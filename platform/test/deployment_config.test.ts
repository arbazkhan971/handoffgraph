import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(fileURLToPath(new NodeURL("../wrangler.toml", import.meta.url)), "utf8");
const migrationsDirectory = fileURLToPath(new NodeURL("../migrations/", import.meta.url));
const attributes = readFileSync(
  fileURLToPath(new NodeURL("../../.gitattributes", import.meta.url)),
  "utf8",
);

describe("Hosted Basic deployment configuration", () => {
  it("pins the production and staging route fence", () => {
    expect(config).toMatch(/^HOSTED_SURFACE = "basic"$/m);
    expect(config.match(/^HOSTED_SURFACE = "basic"$/gm)).toHaveLength(2);
    expect(config).toMatch(/^workers_dev = false$/m);
    expect(config).toMatch(/^preview_urls = false$/m);
  });

  it("pins exact isolated production and staging resources and origins", () => {
    expect([...config.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1])).toEqual([
      "handoffgraph-api",
      "handoffgraph-api-staging",
    ]);
    expect([...config.matchAll(/^database_name = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual(["handoffgraph", "handoffgraph-staging"]);
    const databaseIds = [...config.matchAll(/^database_id = "([^"]+)"$/gm)]
      .map((match) => match[1]);
    expect(databaseIds).toEqual([
      "e51cf2d3-d955-4308-8fff-e6405110b1bf",
      "5116cde4-ae30-4eec-b285-e473c918e94b",
    ]);
    expect(new Set(databaseIds).size).toBe(2);
    expect([...config.matchAll(/^bucket_name = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual(["handoffgraph-bodies", "handoffgraph-bodies-staging"]);
    expect([...config.matchAll(/^binding = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual(["DB", "BODIES", "DB", "BODIES"]);
    expect([...config.matchAll(/^APP_ORIGIN = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual([
        "https://api.handoffgraph.dev",
        "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
      ]);
    expect([...config.matchAll(/^LANDING_ORIGIN = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual([
        "https://handoffgraph.dev",
        "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
      ]);
    expect([...config.matchAll(/^WORKOS_REDIRECT_URI = "([^"]+)"$/gm)].map((match) => match[1]))
      .toEqual([
        "https://api.handoffgraph.dev/v1/auth/callback",
        "https://handoffgraph-api-staging.arbaz-khan.workers.dev/v1/auth/callback",
      ]);
  });

  it("keeps staging workers.dev-only and production on the exact custom domain", () => {
    expect([...config.matchAll(/^workers_dev = (true|false)$/gm)].map((match) => match[1]))
      .toEqual(["false", "true"]);
    expect(config.match(/^routes = \[\]$/gm)).toHaveLength(1);
    expect(config).toMatch(
      /^routes = \[\n  \{ pattern = "api\.handoffgraph\.dev", custom_domain = true \}\n\]$/m,
    );
    expect(config.match(/^  \{ pattern = "api\.handoffgraph\.dev", custom_domain = true \}$/gm))
      .toHaveLength(1);
    expect(config).toMatch(
      /^\[env\.staging\]\nname = "handoffgraph-api-staging"\nworkers_dev = true\npreview_urls = false\nroutes = \[\]$/m,
    );
  });

  it("does not bind non-selectively-purgeable advanced stores", () => {
    expect(config).not.toMatch(/^\[\[analytics_engine_datasets\]\]$/m);
    expect(config).not.toMatch(/^\[\[env\.staging\.analytics_engine_datasets\]\]$/m);
    expect(config).not.toMatch(/^\[\[queues\.(?:producers|consumers)\]\]$/m);
    expect(config).not.toMatch(/^\[\[env\.staging\.queues\.(?:producers|consumers)\]\]$/m);
    expect(config).not.toMatch(/^\[\[(?:env\.staging\.)?kv_namespaces\]\]$/m);
  });

  it("keeps automatic URL-bearing telemetry disabled", () => {
    expect(config).toMatch(/^invocation_logs = false$/m);
    expect(config).toMatch(/^\[observability\.traces\]\nenabled = false$/m);
  });

  it("keeps trigger migrations compatible with the remote D1 parser", () => {
    expect(attributes).toMatch(/^platform\/migrations\/\*\.sql text eol=lf$/m);
    const migrationNames = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrationNames).not.toHaveLength(0);
    for (const name of migrationNames) {
      const source = readFileSync(`${migrationsDirectory}/${name}`, "utf8");
      expect(source, `${name} must use LF line endings`).not.toContain("\r\n");
      expect(source, `${name} must parenthesize SELECT CASE in trigger bodies`).not.toMatch(
        /\bSELECT\s+CASE\b/,
      );
    }
  });
});
