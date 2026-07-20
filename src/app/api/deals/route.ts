import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contacts,
  deals,
  pipelineStages,
  pipelines,
  profiles,
} from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeDeal } from "@/lib/pipelines/serialize";

const DEAL_STATUSES = new Set(["open", "won", "lost"]);

async function assertPipeline(accountId: string, pipelineId: string) {
  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.accountId, accountId), eq(pipelines.id, pipelineId)))
    .limit(1);
  return !!pipeline;
}

async function assertStage(pipelineId: string, stageId: string) {
  const [stage] = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(
      and(
        eq(pipelineStages.pipelineId, pipelineId),
        eq(pipelineStages.id, stageId),
      ),
    )
    .limit(1);
  return !!stage;
}

function normalizeDealInput(body: Record<string, unknown>) {
  const status = typeof body.status === "string" ? body.status : undefined;
  return {
    title: typeof body.title === "string" ? body.title.trim() : "",
    value: Number.isFinite(Number(body.value)) ? String(Number(body.value)) : "0",
    currency:
      typeof body.currency === "string" && body.currency.trim()
        ? body.currency.trim()
        : "USD",
    contactId: typeof body.contact_id === "string" && body.contact_id ? body.contact_id : null,
    pipelineId: typeof body.pipeline_id === "string" ? body.pipeline_id : "",
    stageId: typeof body.stage_id === "string" ? body.stage_id : "",
    assignedTo:
      typeof body.assigned_to === "string" && body.assigned_to
        ? body.assigned_to
        : null,
    notes:
      typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
    expectedCloseDate:
      typeof body.expected_close_date === "string" && body.expected_close_date
        ? body.expected_close_date
        : null,
    status: status && DEAL_STATUSES.has(status) ? status : undefined,
  };
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
      .select({
        deal: deals,
        contact: contacts,
        assignee: profiles,
        stage: pipelineStages,
      })
      .from(deals)
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .leftJoin(profiles, eq(profiles.id, deals.assignedTo))
      .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.accountId, ctx.accountId), eq(deals.pipelineId, pipelineId)))
      .orderBy(desc(deals.createdAt));

    return NextResponse.json({
      deals: rows.map((row) =>
        serializeDeal(row.deal, {
          contact: row.contact,
          assignee: row.assignee,
          stage: row.stage,
        }),
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = normalizeDealInput(body);

    if (!input.title || !input.pipelineId || !input.stageId || !input.contactId) {
      return NextResponse.json(
        { error: "title, contact_id, pipeline_id and stage_id are required." },
        { status: 400 },
      );
    }
    if (!(await assertPipeline(ctx.accountId, input.pipelineId))) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }
    if (!(await assertStage(input.pipelineId, input.stageId))) {
      return NextResponse.json({ error: "Stage not found." }, { status: 404 });
    }

    const [created] = await db
      .insert(deals)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        contactId: input.contactId,
        assignedTo: input.assignedTo,
        title: input.title,
        value: input.value,
        currency: input.currency,
        notes: input.notes,
        expectedCloseDate: input.expectedCloseDate,
        status: input.status ?? "open",
      })
      .returning();

    return NextResponse.json({ deal: serializeDeal(created) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const action = typeof body.action === "string" ? body.action : "";

    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    if (action === "move") {
      const stageId = typeof body.stage_id === "string" ? body.stage_id : "";
      if (!stageId) {
        return NextResponse.json({ error: "stage_id is required." }, { status: 400 });
      }
      const [existing] = await db
        .select({ pipelineId: deals.pipelineId })
        .from(deals)
        .where(and(eq(deals.accountId, ctx.accountId), eq(deals.id, id)))
        .limit(1);
      if (!existing || !(await assertStage(existing.pipelineId, stageId))) {
        return NextResponse.json({ error: "Deal or stage not found." }, { status: 404 });
      }
      const [updated] = await db
        .update(deals)
        .set({ stageId, updatedAt: new Date() })
        .where(and(eq(deals.accountId, ctx.accountId), eq(deals.id, id)))
        .returning();
      return NextResponse.json({ deal: serializeDeal(updated) });
    }

    if (action === "status") {
      const status = typeof body.status === "string" ? body.status : "";
      if (!DEAL_STATUSES.has(status)) {
        return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      }
      const [updated] = await db
        .update(deals)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(deals.accountId, ctx.accountId), eq(deals.id, id)))
        .returning();
      if (!updated) {
        return NextResponse.json({ error: "Deal not found." }, { status: 404 });
      }
      return NextResponse.json({ deal: serializeDeal(updated) });
    }

    const input = normalizeDealInput(body);
    if (!input.title || !input.pipelineId || !input.stageId || !input.contactId) {
      return NextResponse.json(
        { error: "title, contact_id, pipeline_id and stage_id are required." },
        { status: 400 },
      );
    }
    if (!(await assertPipeline(ctx.accountId, input.pipelineId))) {
      return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
    }
    if (!(await assertStage(input.pipelineId, input.stageId))) {
      return NextResponse.json({ error: "Stage not found." }, { status: 404 });
    }

    const [updated] = await db
      .update(deals)
      .set({
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        contactId: input.contactId,
        assignedTo: input.assignedTo,
        title: input.title,
        value: input.value,
        currency: input.currency,
        notes: input.notes,
        expectedCloseDate: input.expectedCloseDate,
        updatedAt: new Date(),
      })
      .where(and(eq(deals.accountId, ctx.accountId), eq(deals.id, id)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }

    return NextResponse.json({ deal: serializeDeal(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(deals)
      .where(and(eq(deals.accountId, ctx.accountId), eq(deals.id, id)))
      .returning({ id: deals.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
