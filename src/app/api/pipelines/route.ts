import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { pipelineStages, pipelines } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializePipeline, serializeStage } from "@/lib/pipelines/serialize";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

const DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
];

async function createPipelineWithDefaultStages(
  userId: string,
  accountId: string,
  name: string,
) {
  return db.transaction(async (tx) => {
    const [pipeline] = await tx
      .insert(pipelines)
      .values({ userId, accountId, name })
      .returning();

    const stages = await tx
      .insert(pipelineStages)
      .values(
        DEFAULT_STAGES.map((stage) => ({
          pipelineId: pipeline.id,
          ...stage,
        })),
      )
      .returning();

    return { pipeline, stages };
  });
}

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    let rows = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(asc(pipelines.createdAt));

    if (rows.length === 0) {
      await createPipelineWithDefaultStages(
        ctx.userId,
        ctx.accountId,
        "Sales Pipeline",
      );
      rows = await db
        .select()
        .from(pipelines)
        .where(eq(pipelines.accountId, ctx.accountId))
        .orderBy(asc(pipelines.createdAt));
    }

    return NextResponse.json({ pipelines: rows.map(serializePipeline) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }

    const { pipeline, stages } = await createPipelineWithDefaultStages(
      ctx.userId,
      ctx.accountId,
      name,
    );
    const serializedPipeline = serializePipeline(pipeline);
    const serializedStages = stages.map(serializeStage);

    await publishRealtimeEvent("pipeline.created", {
      accountId: ctx.accountId,
      payload: { pipeline: serializedPipeline, stages: serializedStages },
    }).catch((error) => {
      console.warn("[realtime] failed to publish pipeline.created:", error);
    });

    return NextResponse.json(
      {
        pipeline: serializedPipeline,
        stages: serializedStages,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!id || !name) {
      return NextResponse.json({ error: "id and name are required." }, { status: 400 });
    }

    const [updated] = await db
      .update(pipelines)
      .set({ name })
      .where(and(eq(pipelines.accountId, ctx.accountId), eq(pipelines.id, id)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }

    const pipeline = serializePipeline(updated);
    await publishRealtimeEvent("pipeline.updated", {
      accountId: ctx.accountId,
      payload: { pipeline },
    }).catch((error) => {
      console.warn("[realtime] failed to publish pipeline.updated:", error);
    });

    return NextResponse.json({ pipeline });
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

    const deleted = await db
      .delete(pipelines)
      .where(and(eq(pipelines.accountId, ctx.accountId), eq(pipelines.id, id)))
      .returning({ id: pipelines.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }

    await publishRealtimeEvent("pipeline.deleted", {
      accountId: ctx.accountId,
      payload: { pipeline: { id } },
    }).catch((error) => {
      console.warn("[realtime] failed to publish pipeline.deleted:", error);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
