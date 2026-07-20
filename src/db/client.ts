import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var wacrmPgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Postgres/Drizzle stack.");
  }

  if (!globalThis.wacrmPgPool) {
    globalThis.wacrmPgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    });
  }

  return globalThis.wacrmPgPool;
}

function createDb() {
  return drizzle(getPool(), { schema });
}

type Database = NodePgDatabase<typeof schema>;

let cachedDb: Database | undefined;

export function getDb(): Database {
  cachedDb ??= createDb();
  return cachedDb;
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    const value = Reflect.get(getDb(), property, receiver);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});
export type Db = typeof db;
