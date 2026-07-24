import { NextResponse } from "next/server";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contacts,
  deals,
} from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  daysAgoStart,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from "@/lib/dashboard/date-utils";
import type {
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from "@/lib/dashboard/types";

function toIso(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function startOfLocalWeek(d: Date = new Date()): Date {
  const out = startOfLocalDay(d);
  out.setDate(out.getDate() - mondayIndex(out));
  return out;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const range = Math.min(Math.max(Number(url.searchParams.get("range") ?? 30), 1), 90);
    const todayStart = startOfLocalDay();
    const yesterdayStart = daysAgoStart(1);
    const responseRangeStart = daysAgoStart(range - 1);
    const thisWeekStart = startOfLocalWeek();
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const responseQueryStart =
      responseRangeStart < lastWeekStart ? responseRangeStart : lastWeekStart;

    const [
      openConvResult,
      newConvTodayResult,
      newConvYesterdayResult,
      [newContactsToday],
      [newContactsYesterday],
      openDealRows,
      messagesTodayResult,
      messagesYesterdayResult,
      messageSeriesResult,
      responseTimeResult,
      pipelineResult,
      activityRows,
    ] = await Promise.all([
      db.execute(sql`
        select count(*)::int as count
        from conversations
        where account_id = ${ctx.accountId} and status = 'open'
      `),
      db.execute(sql`
        select count(*)::int as count
        from conversations
        where account_id = ${ctx.accountId}
          and status = 'open'
          and created_at >= ${todayStart}
      `),
      db.execute(sql`
        select count(*)::int as count
        from conversations
        where account_id = ${ctx.accountId}
          and status = 'open'
          and created_at >= ${yesterdayStart}
          and created_at < ${todayStart}
      `),
      db
        .select({ count: count() })
        .from(contacts)
        .where(and(eq(contacts.accountId, ctx.accountId), gte(contacts.createdAt, todayStart))),
      db
        .select({ count: count() })
        .from(contacts)
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            gte(contacts.createdAt, yesterdayStart),
            lt(contacts.createdAt, todayStart),
          ),
        ),
      db
        .select({ value: deals.value })
        .from(deals)
        .where(and(eq(deals.accountId, ctx.accountId), eq(deals.status, "open"))),
      db.execute(sql`
        select count(*)::int as count
        from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id = ${ctx.accountId}
          and m.sender_type = 'agent'
          and m.created_at >= ${todayStart}
      `),
      db.execute(sql`
        select count(*)::int as count
        from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id = ${ctx.accountId}
          and m.sender_type = 'agent'
          and m.created_at >= ${yesterdayStart}
          and m.created_at < ${todayStart}
      `),
      db.execute(sql`
        select m.created_at, m.sender_type
        from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id = ${ctx.accountId}
          and m.created_at >= ${daysAgoStart(range - 1)}
        order by m.created_at asc
      `),
      db.execute(sql`
        with ordered_messages as (
          select
            m.id,
            m.conversation_id,
            m.sender_type,
            m.created_at,
            lag(m.sender_type) over (
              partition by m.conversation_id
              order by m.created_at, m.id
            ) as previous_sender_type
          from messages m
          join conversations c on c.id = m.conversation_id
          where c.account_id = ${ctx.accountId}
            and m.deleted_at is null
            and m.created_at >= ${responseQueryStart}
        ),
        pending_starts as (
          select id, conversation_id, created_at
          from ordered_messages
          where sender_type = 'customer'
            and coalesce(previous_sender_type, '') <> 'customer'
        )
        select
          ps.created_at as pending_at,
          first_reply.created_at as replied_at
        from pending_starts ps
        join lateral (
          select m.created_at
          from messages m
          where m.conversation_id = ps.conversation_id
            and m.deleted_at is null
            and m.sender_type in ('agent', 'bot')
            and m.created_at > ps.created_at
          order by m.created_at, m.id
          limit 1
        ) first_reply on true
      `),
      db.execute(sql`
        select
          ps.id,
          ps.name,
          ps.color,
          d.id as deal_id,
          d.value
        from pipeline_stages ps
        join pipelines p on p.id = ps.pipeline_id
        left join deals d on d.stage_id = ps.id and d.status = 'open'
        where p.account_id = ${ctx.accountId}
        order by ps.position asc
      `),
      db.execute(sql`
        (
          select 'contact' as kind, id::text, coalesce(name, phone) as label, created_at as at
          from contacts
          where account_id = ${ctx.accountId}
          order by created_at desc
          limit 10
        )
        union all
        (
          select 'broadcast' as kind, id::text, name as label, created_at as at
          from broadcasts
          where account_id = ${ctx.accountId}
          order by created_at desc
          limit 10
        )
        order by at desc
        limit 20
      `),
    ]);

    const openConv = openConvResult.rows[0] as { count?: number } | undefined;
    const newConvToday = newConvTodayResult.rows[0] as { count?: number } | undefined;
    const newConvYesterday = newConvYesterdayResult.rows[0] as { count?: number } | undefined;
    const messagesToday = (messagesTodayResult.rows[0] as { count?: number } | undefined)?.count ?? 0;
    const messagesYesterday = (messagesYesterdayResult.rows[0] as { count?: number } | undefined)?.count ?? 0;
    const messageSeriesRows = messageSeriesResult.rows as Array<{
      created_at: Date | string;
      sender_type: string;
    }>;
    const responseTimeRows = responseTimeResult.rows as Array<{
      pending_at: Date | string;
      replied_at: Date | string;
    }>;
    const stageRows = pipelineResult.rows as Array<{
      id: string;
      name: string;
      color: string | null;
      deal_id: string | null;
      value: string | null;
    }>;

    const openDealsValue = openDealRows.reduce(
      (sum, row) => sum + Number(row.value ?? 0),
      0,
    );
    const metrics: MetricsBundle = {
      activeConversations: {
        current: Number(openConv?.count ?? 0),
        previous: Number(newConvToday?.count ?? 0) - Number(newConvYesterday?.count ?? 0),
      },
      newContactsToday: {
        current: Number(newContactsToday?.count ?? 0),
        previous: Number(newContactsYesterday?.count ?? 0),
      },
      openDealsValue,
      openDealsCount: openDealRows.length,
      messagesSentToday: {
        current: messagesToday,
        previous: messagesYesterday,
      },
    };

    const keys = lastNDayKeys(range);
    const buckets = new Map(keys.map((key) => [key, { incoming: 0, outgoing: 0 }]));
    for (const row of messageSeriesRows) {
      const key = localDayKey(toIso(row.created_at));
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (row.sender_type === "customer") bucket.incoming += 1;
      else bucket.outgoing += 1;
    }
    const series: ConversationsSeriesPoint[] = keys.map((day) => ({
      day,
      ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }),
    }));

    const responseMinutesByDow = Array.from({ length: 7 }, () => [] as number[]);
    const thisWeekResponseMinutes: number[] = [];
    const lastWeekResponseMinutes: number[] = [];
    for (const row of responseTimeRows) {
      const pendingAt = new Date(row.pending_at);
      const repliedAt = new Date(row.replied_at);
      const minutes = (repliedAt.getTime() - pendingAt.getTime()) / 60000;
      if (!Number.isFinite(minutes) || minutes < 0) continue;

      if (pendingAt >= responseRangeStart) {
        responseMinutesByDow[mondayIndex(pendingAt)].push(minutes);
      }
      if (pendingAt >= thisWeekStart) {
        thisWeekResponseMinutes.push(minutes);
      } else if (pendingAt >= lastWeekStart && pendingAt < thisWeekStart) {
        lastWeekResponseMinutes.push(minutes);
      }
    }
    const responseTime: ResponseTimeSummary = {
      buckets: responseMinutesByDow.map((values, dow) => ({
        dow,
        avgMinutes: average(values),
        samples: values.length,
      })),
      thisWeekAvg: average(thisWeekResponseMinutes),
      lastWeekAvg: average(lastWeekResponseMinutes),
    };

    const byStage = new Map<string, { id: string; name: string; color: string; dealCount: number; totalValue: number }>();
    for (const row of stageRows) {
      const current = byStage.get(row.id) ?? {
        id: row.id,
        name: row.name,
        color: row.color || "#64748b",
        dealCount: 0,
        totalValue: 0,
      };
      if (row.deal_id) {
        current.dealCount += 1;
        current.totalValue += Number(row.value ?? 0);
      }
      byStage.set(row.id, current);
    }
    const slices = [...byStage.values()].filter(
      (stage) => stage.totalValue > 0 || stage.dealCount > 0,
    );
    const pipeline: PipelineDonutData = {
      stages: slices,
      totalValue: slices.reduce((sum, stage) => sum + stage.totalValue, 0),
    };

    const activity = (activityRows.rows as Array<{ kind: string; id: string; label: string; at: Date | string }>).map(
      (row) => ({
        id: `${row.kind}-${row.id}`,
        kind: row.kind,
        text:
          row.kind === "broadcast"
            ? `Broadcast "${row.label}" created`
            : `New contact: ${row.label}`,
        at: toIso(row.at),
        href: row.kind === "broadcast" ? "/broadcasts" : "/contacts",
      }),
    );

    return NextResponse.json({
      metrics,
      series,
      pipeline,
      responseTime,
      activity,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
