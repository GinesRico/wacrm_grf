#!/usr/bin/env node
import pg from 'pg';

const { Pool } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function connectionStringFromEnv() {
  if (process.env.WHATICKET_DATABASE_URL) {
    return process.env.WHATICKET_DATABASE_URL;
  }

  const user = encodeURIComponent(requireEnv('WHATICKET_DB_USER'));
  const pass = encodeURIComponent(requireEnv('WHATICKET_DB_PASS'));
  const host = requireEnv('WHATICKET_DB_HOST');
  const port = process.env.WHATICKET_DB_PORT || '5432';
  const db = encodeURIComponent(requireEnv('WHATICKET_DB_NAME'));
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

async function countTable(client, tableName) {
  const result = await client.query(`select count(*)::int as count from "${tableName}"`);
  return { table: tableName, count: result.rows[0]?.count ?? 0 };
}

async function main() {
  const pool = new Pool({ connectionString: connectionStringFromEnv() });
  const client = await pool.connect();

  try {
    const tablesResult = await client.query(`
      select tablename
      from pg_tables
      where schemaname = 'public'
      order by tablename
    `);

    console.log('Tablas public:');
    console.table(tablesResult.rows.map((row) => ({ table: row.tablename })));

    const counts = await Promise.all(
      ['Tickets', 'Messages', 'Contacts', 'QuickAnswers', 'TicketStatusEvents'].map((table) =>
        countTable(client, table)
      )
    );

    console.log('Conteos principales:');
    console.table(counts);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
