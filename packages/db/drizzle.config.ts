import { defineConfig } from "drizzle-kit";

/**
 * `generate` only — this config deliberately does not set `driver: "d1-http"`.
 *
 * That driver is what powers drizzle-kit's push/pull/studio commands against a
 * live D1 over the HTTP API, and it requires a `dbCredentials` block carrying an
 * account id, database id, and an API token. None of those belong in the repo,
 * and none of those commands are used here: migrations are generated from the
 * schema and then applied by wrangler (`bun run migrate:local` / `:remote`),
 * which reads the binding out of apps/web/wrangler.jsonc instead.
 *
 * `dialect: "sqlite"` alone is everything `drizzle-kit generate` needs.
 *
 * Output lands in ./migrations as <timestamp>_<name>/migration.sql — a nested
 * layout wrangler finds only because wrangler.jsonc sets `migrations_pattern`.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
