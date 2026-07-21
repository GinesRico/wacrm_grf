import { NextResponse } from "next/server";
import { and, asc, count, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { deals, pipelineStages, pipelines } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeStage } from "@/lib/pipelines/serialize";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

async function assertPipeline(accountId: string, pipelineId: string) {
  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.accountId, accountId), eq(pipelines.id, pipelineId)))
    .limit(1);
  return !!pipeline;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const pipelineId = url.searchParams.get("pipeline_id");
    if (!pipelineId) {
      return NextResponse.json({ error: "pipeline_id is required." }, { status: 400 });
    }
    if (!(await assertPipeline(ctx.accountId, pipelineId))) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position));

    return NextResponse.json({ stages: rows.map(serializeStage) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const pipelineId = typeof body.pipeline_id === "string" ? body.pipeline_id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const color =
      typeof body.color === "string" && body.color.trim()
        ? body.color.trim()
        : "#3b82f6";
    const position = Number.isFinite(Number(body.position))
      ? Number(body.position)
      : 0;

    if (!pipelineId || !name) {
      return NextResponse.json(
        { error: "pipeline_id and name are required." },
        { status: 400 },
      );
    }
    if (!(await assertPipeline(ctx.accountId, pipelineId))) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }

    const [stage] = await db
      .insert(pipelineStages)
      .values({ pipelineId, name, color, position })
      .returning();

    const serialized = serializeStage(stage);
    await publishRealtimeEvent("pipeline_stage.created", {
      accountId: ctx.accountId,
      payload: { stage: serialized },
    }).catch((error) => {
      console.warn("[realtime] failed to publish pipeline_stage.created:", error);
    });

    return NextResponse.json({ stage: serialized }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rawStages = Array.isArray(body.stages) ? body.stages : [];

    if (rawStages.length === 0) {
      return NextResponse.json({ error: "stages are required." }, { status: 400 });
    }

    const stageRows = rawStages
      .map((stage, index) => {
        if (!stage || typeof stage !== "object") return null;
        const row = stage as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const pipelineId = typeof row.pipeline_id === "string" ? row.pipeline_id : "";
        const name = typeof row.name === "string" ? row.name.trim() : "";
        const color =
          typeof row.color === "string" && row.color.trim()
            ? row.color.trim()
            : "#3b82f6";
        return id && pipelineId && name
          ? { id, pipelineId, name, color, position: index }
          : null;
      })
      .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

    if (stageRows.length !== rawStages.length) {
      return NextResponse.json({ error: "Invalid stage payload." }, { status: 400 });
    }

    const pipelineIds = [...new Set(stageRows.map((stage) => stage.pipelineId))];
    const owned = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(
        and(
          eq(pipelines.accountId, ctx.accountId),
          pipelineIds.length === 1
            ? eq(pipelines.id, pipelineIds[0])
            : inArray(pipelines.id, pipelineIds),
        ),
      );
    if (owned.length !== pipelineIds.length) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }

    const updated = await db.transaction(async (tx) => {
      const result = [];
      for (const stage of stageRows) {
        const [row] = await tx
          .update(pipelineStages)
          .set({
            name: stage.name,
            color: stage.color,
            position: stage.position,
          })
          .where(
            and(
              eq(pipelineStages.id, stage.id),
              eq(pipelineStages.pipelineId, stage.pipelineId),
            ),
          )
          .returning();
        if (row) result.push(row);
      }
      return result;
    });

    const stages = updated.map(serializeStage);
    await Promise.all(
      stages.map((stage) =>
        publishRealtimeEvent("pipeline_stage.updated", {
          accountId: ctx.accountId,
          payload: { stage },
        }).catch((error) => {
          console.warn("[realtime] failed to publish pipeline_stage.updated:", error);
        }),
      ),
    );

    return NextResponse.json({ stages });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const [stage] = await db
      .select({ id: pipelineStages.id, pipelineId: pipelineStages.pipelineId })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(and(eq(pipelines.accountId, ctx.accountId), eq(pipelineStages.id, id)))
      .limit(1);

    if (!stage) {
      return NextResponse.json({ error: "Stage not found." }, { status: 404 });
    }

    const [dealCount] = await db
      .select({ count: count() })
      .from(deals)
      .where(eq(deals.stageId, id));
    if (Number(dealCount?.count ?? 0) > 0) {
      return NextResponse.json(
        { error: "Stage still has deals." },
        { status: 409 },
      );
    }

    await db.delete(pipelineStages).where(eq(pipelineStages.id, id));
    await publishRealtimeEvent("pipeline_stage.deleted", {
      accountId: ctx.accountId,
      payload: { stage },
    }).catch((error) => {
      console.warn("[realtime] failed to publish pipeline_stage.deleted:", error);
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
