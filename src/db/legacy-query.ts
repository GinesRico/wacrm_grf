import { sql } from "drizzle-orm";

import { db } from "@/db/client";

type Mode = "many" | "single" | "maybeSingle";
type Operation = "select" | "insert" | "update" | "delete" | "upsert";

interface Filter {
  column: string;
  operator: "=" | "<>" | "is" | "in" | ">=" | "<=" | "not.is";
  value: unknown;
}

function quoteIdent(value: string): string {
  return value
    .split(".")
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(".");
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`;
  if (Array.isArray(value)) return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assignments(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${quoteIdent(key)} = ${literal(value)}`)
    .join(", ");
}

function columnsFromSelect(columns: string): string {
  if (columns === "*" || columns.includes("(")) return "*";
  return columns
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(quoteIdent)
    .join(", ");
}

export function legacyDb() {
  return {
    from(table: string) {
      return new LegacyQuery(table);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      return legacyRpc(name, args);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class LegacyQuery implements PromiseLike<any> {
  private operation: Operation = "select";
  private selected = "*";
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private filters: Filter[] = [];
  private orders: { column: string; ascending: boolean }[] = [];
  private limitValue: number | null = null;
  private mode: Mode = "many";
  private countMode = false;
  private headMode = false;
  private conflictColumns: string[] = [];
  private returning = false;

  constructor(private readonly table: string) {}

  select(columns = "*", options?: { count?: string; head?: boolean }) {
    this.selected = columns;
    this.returning = this.operation !== "select";
    this.countMode = options?.count === "exact";
    this.headMode = options?.head === true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    this.operation = "upsert";
    this.values = values;
    this.conflictColumns = options?.onConflict?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: "=", value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, operator: "<>", value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, operator: "is", value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ column, operator: "in", value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, operator: ">=", value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ column, operator: "<=", value });
    return this;
  }

  filter(column: string, operator: string, value: unknown) {
    if (operator === "eq") return this.eq(column, value);
    if (operator === "neq") return this.neq(column, value);
    if (operator === "is") return this.is(column, value);
    if (operator === "not.is") {
      this.filters.push({ column, operator: "not.is", value });
      return this;
    }
    if (operator === "gte") return this.gte(column, value);
    if (operator === "lte") return this.lte(column, value);
    throw new Error(`Unsupported legacy filter operator: ${operator}`);
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  single() {
    this.mode = "single";
    return this;
  }

  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async then<TResult1 = any, TResult2 = never>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const value = await this.execute();
      return onfulfilled ? onfulfilled(value) : (value as TResult1);
    } catch (error) {
      if (onrejected) return onrejected(error);
      throw error;
    }
  }

  private whereSql(alias?: string): string {
    if (this.filters.length === 0) return "";
    const prefix = alias ? `${alias}.` : "";
    const parts = this.filters.map((filter) => {
      if (filter.column.includes(".")) {
        const [relation, column] = filter.column.split(".");
        const relationAlias = relation === "broadcasts" ? "b" : relation === "conversations" ? "c" : relation;
        return `${relationAlias}.${quoteIdent(column)} ${filter.operator === "is" ? "is" : filter.operator} ${filter.operator === "in" ? `(${(filter.value as unknown[]).map(literal).join(", ")})` : literal(filter.value)}`;
      }
      const column = `${prefix}${quoteIdent(filter.column)}`;
      if (filter.operator === "is") return `${column} is ${literal(filter.value)}`;
      if (filter.operator === "not.is") return `${column} is not ${literal(filter.value)}`;
      if (filter.operator === "in") return `${column} in (${(filter.value as unknown[]).map(literal).join(", ")})`;
      return `${column} ${filter.operator} ${literal(filter.value)}`;
    });
    return ` where ${parts.join(" and ")}`;
  }

  private orderLimitSql(alias?: string): string {
    const prefix = alias ? `${alias}.` : "";
    const order =
      this.orders.length > 0
        ? ` order by ${this.orders.map((o) => `${prefix}${quoteIdent(o.column)} ${o.ascending ? "asc" : "desc"}`).join(", ")}`
        : "";
    const limit = this.limitValue != null ? ` limit ${this.limitValue}` : "";
    return `${order}${limit}`;
  }

  private async execute() {
    const query = this.buildSql();
    const result = await db.execute(sql.raw(query));
    const rows = result.rows as Record<string, unknown>[];
    const count = this.countMode ? Number((rows[0] as { count?: unknown } | undefined)?.count ?? 0) : null;

    if (this.headMode) return { data: null, error: null, count };
    if (this.mode === "single") return { data: rows[0] ?? null, error: null, count };
    if (this.mode === "maybeSingle") return { data: rows[0] ?? null, error: null, count };
    return { data: rows, error: null, count };
  }

  private buildSql(): string {
    if (this.operation === "select") return this.selectSql();
    if (this.operation === "insert") return this.insertSql();
    if (this.operation === "update") return this.updateSql();
    if (this.operation === "delete") return this.deleteSql();
    return this.upsertSql();
  }

  private selectSql(): string {
    if (this.countMode && this.headMode) {
      return `select count(*)::int as count from ${quoteIdent(this.table)}${this.whereSql()}`;
    }
    if (this.table === "messages" && this.selected.includes("conversations(")) {
      return `select m.conversation_id, json_build_object('account_id', c.account_id) as conversations from messages m join conversations c on c.id = m.conversation_id${this.whereSql("m")}${this.orderLimitSql("m")}`;
    }
    if (this.table === "broadcast_recipients" && this.selected.includes("broadcasts!inner")) {
      return `select br.* from broadcast_recipients br join broadcasts b on b.id = br.broadcast_id${this.whereSql("br")}${this.orderLimitSql("br")}`;
    }
    return `select ${columnsFromSelect(this.selected)} from ${quoteIdent(this.table)}${this.whereSql()}${this.orderLimitSql()}`;
  }

  private insertSql(): string {
    const rows = Array.isArray(this.values) ? this.values : [this.values as Record<string, unknown>];
    const keys = Object.keys(rows[0] ?? {});
    const values = rows
      .map((row) => `(${keys.map((key) => literal(row[key])).join(", ")})`)
      .join(", ");
    const returning = this.returning || this.mode !== "many" ? " returning *" : "";
    return `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(", ")}) values ${values}${returning}`;
  }

  private updateSql(): string {
    const returning = this.returning || this.mode !== "many" ? " returning *" : "";
    return `update ${quoteIdent(this.table)} set ${assignments(this.values as Record<string, unknown>)}${this.whereSql()}${returning}`;
  }

  private deleteSql(): string {
    const returning = this.returning || this.mode !== "many" ? " returning *" : "";
    return `delete from ${quoteIdent(this.table)}${this.whereSql()}${returning}`;
  }

  private upsertSql(): string {
    const values = this.values as Record<string, unknown>;
    const keys = Object.keys(values);
    const conflict = this.conflictColumns.length > 0 ? this.conflictColumns : keys.slice(0, 1);
    const updates = keys
      .filter((key) => !conflict.includes(key))
      .map((key) => `${quoteIdent(key)} = excluded.${quoteIdent(key)}`)
      .join(", ");
    if (!updates) {
      return `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(", ")}) values (${keys.map((key) => literal(values[key])).join(", ")}) on conflict (${conflict.map(quoteIdent).join(", ")}) do nothing returning *`;
    }
    return `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(", ")}) values (${keys.map((key) => literal(values[key])).join(", ")}) on conflict (${conflict.map(quoteIdent).join(", ")}) do update set ${updates} returning *`;
  }
}

async function legacyRpc(name: string, args: Record<string, unknown>) {
  if (name === "increment_automation_execution") {
    const result = await db.execute(
      sql.raw(`select public.increment_automation_execution(${literal(args.automation_id)}) as data`),
    );
    return { data: (result.rows[0] as { data?: unknown } | undefined)?.data ?? null, error: null };
  }

  if (name === "increment_automation_execution_count") {
    const automationId = args.p_automation_id ?? args.automation_id;
    await db.execute(
      sql.raw(
        `update automations set execution_count = execution_count + 1, last_executed_at = now(), updated_at = now() where id = ${literal(automationId)}`,
      ),
    );
    return { data: null, error: null };
  }

  if (name === "increment_flow_execution") {
    const result = await db.execute(
      sql.raw(`select public.increment_flow_execution(${literal(args.flow_id)}) as data`),
    );
    return { data: (result.rows[0] as { data?: unknown } | undefined)?.data ?? null, error: null };
  }

  if (name === "claim_ai_reply_slot") {
    const result = await db.execute(
      sql.raw(
        `select public.claim_ai_reply_slot(${literal(args.conversation_id)}, ${literal(args.max_replies)}) as data`,
      ),
    );
    return { data: (result.rows[0] as { data?: unknown } | undefined)?.data ?? null, error: null };
  }

  throw new Error(`Unsupported legacy rpc: ${name}`);
}
