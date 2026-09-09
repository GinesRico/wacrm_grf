import { defineConfig } from "drizzle-kit";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const fileName of [".env.production", ".env.local", ".env"]) {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Set it in the shell or in .env.production/.env.local before running pnpm db:migrate.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
