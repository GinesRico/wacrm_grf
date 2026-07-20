import { drizzle } from "drizzle-orm/node-postgres";
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

export const db = drizzle(getPool(), { schema });
export type Db = typeof db;
