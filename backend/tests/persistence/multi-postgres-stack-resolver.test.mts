import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { ContextManager, StackContext } from "@src/context-manager.mjs";

/**
 * Test: Multi-Postgres-Stack disambiguation in the variable resolver chain.
 *
 * Scenario reproduced:
 *   - There are TWO postgres stacks in the storage context:
 *     - postgres_default (POSTGRES_PASSWORD = "AAA…")
 *     - postgres_ssl     (POSTGRES_PASSWORD = "BBB…")
 *   - Zitadel/default install passes allStackIds = [postgres_default, oidc_default, …]
 *   - The variable resolver must aggregate stack entries into a "defaults" map
 *     used for {{ POSTGRES_PASSWORD }} resolution in zitadel's compose template.
 *   - It MUST pick "AAA…" (from postgres_default), not "BBB…" (from postgres_ssl).
 *
 * The aggregation logic that we replicate inline (see
 * webapp-ve-route-handlers.mts ~line 482):
 *
 *   for (const sid of allStackIds) {
 *     const stack = ctx.getStack(sid);
 *     if (stack?.entries) for (const e of stack.entries) defaults.set(e.name, e.value);
 *   }
 *
 * If this aggregation ever sees `postgres_ssl` in `allStackIds` for a
 * `_default`-context (e.g. because somewhere a name-only lookup matches "ssl"
 * across stacktypes, or because allStackIds is built from a wrong source), the
 * defaults map would contain the wrong POSTGRES_PASSWORD and zitadel-api would
 * fail SASL auth against postgres-default at runtime.
 */
describe("Multi-postgres-stack resolver disambiguation", () => {
  let tmpDir: string;
  let contextFile: string;
  let secretFile: string;
  let ctx: ContextManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `multi-postgres-resolver-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    contextFile = path.join(tmpDir, "storagecontext.json");
    secretFile = path.join(tmpDir, "secret.txt");
    ctx = new ContextManager(contextFile, secretFile);

    // Two postgres stacks, distinct passwords
    ctx.set("stack_postgres_default", new StackContext({
      id: "postgres_default",
      name: "default",
      stacktype: "postgres",
      entries: [{ name: "POSTGRES_PASSWORD", value: "AAA-default-pw" }],
    }));
    ctx.set("stack_postgres_ssl", new StackContext({
      id: "postgres_ssl",
      name: "ssl",
      stacktype: "postgres",
      entries: [{ name: "POSTGRES_PASSWORD", value: "BBB-ssl-pw" }],
    }));
    // The zitadel-app side: oidc stack for the default variant
    ctx.set("stack_oidc_default", new StackContext({
      id: "oidc_default",
      name: "default",
      stacktype: "oidc",
      entries: [
        { name: "ZITADEL_MASTERKEY", value: "MASTERKEY-DEF" },
        { name: "ZITADEL_DB_PASSWORD", value: "ZIT-DB-DEF" },
        { name: "ZITADEL_ADMIN_PASSWORD", value: "ZIT-ADMIN-DEF" },
      ],
    }));
    ctx.set("stack_oidc_ssl", new StackContext({
      id: "oidc_ssl",
      name: "ssl",
      stacktype: "oidc",
      entries: [
        { name: "ZITADEL_MASTERKEY", value: "MASTERKEY-SSL" },
        { name: "ZITADEL_DB_PASSWORD", value: "ZIT-DB-SSL" },
        { name: "ZITADEL_ADMIN_PASSWORD", value: "ZIT-ADMIN-SSL" },
      ],
    }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: replicates the aggregation loop from webapp-ve-route-handlers.mts
  function buildDefaultsForInstall(stackIds: string[]): Map<string, string> {
    const defaults = new Map<string, string>();
    for (const sid of stackIds) {
      const stack = ctx.getStack(sid);
      if (stack?.entries) {
        for (const entry of stack.entries) {
          defaults.set(entry.name, entry.value);
        }
      }
    }
    return defaults;
  }

  it("getStack uses id, not name — postgres_default and postgres_ssl resolve independently", () => {
    const def = ctx.getStack("postgres_default");
    expect(def).not.toBeNull();
    expect(def!.entries![0].value).toBe("AAA-default-pw");

    const ssl = ctx.getStack("postgres_ssl");
    expect(ssl).not.toBeNull();
    expect(ssl!.entries![0].value).toBe("BBB-ssl-pw");
  });

  it("getStack with bare name 'default' must NOT match a stack (forces id-based lookup)", () => {
    const byName = ctx.getStack("default");
    expect(byName).toBeNull();
  });

  it("zitadel/default install: allStackIds=[postgres_default, oidc_default] → POSTGRES_PASSWORD=AAA", () => {
    const defaults = buildDefaultsForInstall([
      "postgres_default",
      "oidc_default",
    ]);
    expect(defaults.get("POSTGRES_PASSWORD")).toBe("AAA-default-pw");
    expect(defaults.get("ZITADEL_MASTERKEY")).toBe("MASTERKEY-DEF");
  });

  it("zitadel/ssl install: allStackIds=[postgres_ssl, oidc_ssl] → POSTGRES_PASSWORD=BBB", () => {
    const defaults = buildDefaultsForInstall([
      "postgres_ssl",
      "oidc_ssl",
    ]);
    expect(defaults.get("POSTGRES_PASSWORD")).toBe("BBB-ssl-pw");
    expect(defaults.get("ZITADEL_MASTERKEY")).toBe("MASTERKEY-SSL");
  });

  it("if allStackIds accidentally contains BOTH postgres_default and postgres_ssl, last-wins picks the LAST one", () => {
    // Documents the existing last-wins behavior in the aggregation loop.
    // If a future bug ever causes both to leak into allStackIds, the aggregator
    // silently picks the last — this test pins down that behavior so the bug
    // is detectable (today it would shadow the intended postgres_default value
    // with postgres_ssl's password and produce the SASL fail we observe).
    const defaults = buildDefaultsForInstall([
      "postgres_default",
      "postgres_ssl", // last write wins
      "oidc_default",
    ]);
    expect(defaults.get("POSTGRES_PASSWORD")).toBe("BBB-ssl-pw");
  });

  it("regression: name-only lookup must not cross-pollute between stacktypes", () => {
    // If somewhere a lookup uses the bare stack name "default" for stacktype
    // "postgres" and accidentally finds "stack_oidc_default" (which has the
    // same name "default"), it could pull the wrong entries.
    //
    // The current id-based getStack is safe; this test guards future
    // regressions where someone introduces a name-keyed lookup.
    const allDefaultStacks = ctx.listStacks().filter((s) => s.name === "default");
    // Must find postgres_default AND oidc_default — both have name="default"
    expect(allDefaultStacks.map((s) => s.id).sort()).toEqual([
      "oidc_default",
      "postgres_default",
    ]);
    // ID-based lookup must NOT mix them up
    const pg = ctx.getStack("postgres_default");
    expect(pg!.stacktype).toBe("postgres");
    const oi = ctx.getStack("oidc_default");
    expect(oi!.stacktype).toBe("oidc");
  });
});
