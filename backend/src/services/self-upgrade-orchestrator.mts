import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger/index.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, TaskType, IParameterValue, IVeExecuteMessage, ISingleExecuteMessagesResponse } from "../types.mjs";
import type { WebAppVeMessageManager } from "../webapp/webapp-ve-message-manager.mjs";

type ParamNV = { name: string; value: IParameterValue };

/** Flag the orchestrator sets on the clone-side upgrade request so the
 *  clone's route handler skips orchestration (preventing infinite
 *  clone-spawns-clone recursion). The clone's handler reads this from the
 *  POST body and passes through to the normal upgrade pipeline. */
export const ORCHESTRATED_FLAG = "_orchestrated_via_clone";

/** Filename inside the deployer-CT's /config volume that records "the
 *  clone with this VMID/IP needs to be cleaned up after the upgrade is
 *  done". Written by the orchestrator before triggering the clone-side
 *  upgrade; read by clone-cleanup-service on the new CT's first boot. */
export const CLEANUP_MARKER_FILENAME = ".pending-clone-cleanup.json";

/**
 * Write the marker that tells the new (replaced) deployer-CT to pull the
 * clone's debug bundle and destroy the clone CT once it has booted.
 *
 * The marker lives inside the SOURCE deployer's /config volume. When the
 * clone reconfigures the source, the volume is cloned to the new CT
 * (subvol-NEW-…-config). The marker rides along into the new CT's
 * /config, so the new CT's clone-cleanup-service sees it on first boot.
 */
export function writeCleanupMarker(
  localPath: string,
  marker: {
    cloneVmid: string;
    cloneIp: string;
    /** Unified restartKey used by Hub, Clone, and new-CT adoption (E.8).
     *  Hub generates it; the Clone runs its entire reconfigure pipeline
     *  under this same key; clone-cleanup-service on the new CT adopts
     *  the bundle + messages under it. One key, one bundle, one stream. */
    restartKey: string;
    veContextKey: string;
  },
): string {
  const markerPath = path.join(localPath, CLEANUP_MARKER_FILENAME);
  const body = {
    clone_vmid: marker.cloneVmid,
    clone_ip: marker.cloneIp,
    restart_key: marker.restartKey,
    ve_context_key: marker.veContextKey,
    started_at: new Date().toISOString(),
  };
  writeFileSync(markerPath, JSON.stringify(body, null, 2));
  logger.info("Clone-cleanup marker written", { markerPath, ...body });
  return markerPath;
}

const logger = createLogger("self-upgrade-orchestrator");

export interface CloneCreationResult {
  cloneVmid: string;
  cloneIp: string;
  cloneHostname: string;
  sourceVmid: string;
  veContextKey: string;
}

/**
 * Self-upgrade orchestrator. The proxvex deployer-CT cannot reliably
 * replace itself in-place (static IP handover races, SSH session death
 * mid-replace). The orchestrator instead clones the deployer into a
 * short-lived "upgrader" CT and uses it as a temporary external deployer
 * that drives the real upgrade against the original.
 *
 * Stage B (current): clone + wait-for-api + one no-op HTTP call. The
 * orchestrator does NOT yet trigger any upgrade through the clone — that
 * arrives in Stage C.
 *
 * Stage C (future): replace the no-op with a real upgrade POST against
 * the clone, generating a deterministic restartKey so the new CT can
 * adopt the clone's debug bundle after Stage D's cleanup service runs.
 */

/**
 * Clone the current deployer-CT into a short-lived temp deployer.
 * Runs `clone-as-temp-deployer.sh` on the PVE host via VeExecution. The
 * script does pct snapshot + clone --full + customization (hostname,
 * static-IP-derived, OIDC strip, SSL strip).
 *
 * Returns the clone's VMID, derived static IP, and new hostname. The
 * clone is created but NOT yet started — caller must `pct start` it.
 */
export async function cloneSelfAsTempDeployer(
  selfVmid: string,
  preferredContextKey?: string,
  deployerBaseUrl?: string,
  outerRestartKey?: string,
): Promise<CloneCreationResult> {
  const pm = PersistenceManager.getInstance();
  const contextManager = pm.getContextManager();
  const repositories = pm.getRepositories();

  const scriptContent = repositories.getScript({
    name: "clone-as-temp-deployer.sh",
    scope: "application",
    applicationId: "proxvex",
    category: "create_ct",
  });
  const libraryContent = repositories.getScript({
    name: "upgrade-common.sh",
    scope: "shared",
    category: "root",
  });
  if (!scriptContent || !libraryContent) {
    throw new Error(
      "clone-as-temp-deployer.sh / upgrade-common.sh not found in repositories",
    );
  }

  const veKey = await pickVeContext(preferredContextKey);
  const veContext = contextManager.getVEContextByKey(veKey);
  if (!veContext) throw new Error(`VE context ${veKey} not found`);

  const cmd: ICommand = {
    name: "Clone self as temp deployer",
    execute_on: "ve",
    script: "clone-as-temp-deployer.sh",
    scriptContent,
    libraryContent,
    outputs: [],
    ...(outerRestartKey ? { restartKey: outerRestartKey } : {}),
  };

  const ve = new VeExecution(
    [cmd],
    [
      { id: "previous_vm_id", value: String(selfVmid) },
      { id: "vm_id_start", value: "400" },
      { id: "searchdomain", value: "" },
      { id: "deployer_base_url", value: deployerBaseUrl ?? "" },
    ],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );

  await ve.run(null);

  const cloneVmid = String(ve.outputs.get("vm_id") ?? "");
  let cloneIp = String(ve.outputs.get("clone_ip") ?? "");
  const cloneHostname = String(ve.outputs.get("hostname") ?? "");
  if (!cloneVmid || !cloneHostname) {
    throw new Error(
      `Clone script returned incomplete outputs: vmid=${cloneVmid} ip=${cloneIp} host=${cloneHostname}`,
    );
  }
  // cloneIp empty means the source had ip=dhcp; the clone now also uses
  // DHCP and the actual IP will be discovered post-start (see startClone +
  // discoverCloneIp below).
  logger.info("Clone created", { cloneVmid, cloneIp: cloneIp || "(dhcp)", cloneHostname, sourceVmid: selfVmid, veKey });
  return { cloneVmid, cloneIp, cloneHostname, sourceVmid: selfVmid, veContextKey: veKey };
}

/**
 * Discover the clone's actual IP address after it has been started. For
 * static-IP clones the IP is known from the script output; for DHCP
 * clones we need to look up the leased address. Implementation reads
 * the clone's own routing table from /proc/net/fib_trie (no in-CT tools
 * required) and extracts the /32 LOCAL host route — that's the IP
 * bound on the clone's eth0 (excluding the lo 127.0.0.1).
 *
 * Polls for up to 30s — DHCP lease + interface bring-up can take a few
 * seconds after `pct start` returns.
 */
export async function discoverCloneIp(
  cloneVmid: string,
  veContextKey: string,
  timeoutMs = 30_000,
  outerRestartKey?: string,
): Promise<string> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) throw new Error(`VE context ${veContextKey} not found`);

  const inlineScript = `#!/bin/sh
set -eu
VMID="{{ clone_vmid }}"
TIMEOUT="{{ timeout_seconds }}"
elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  # Read fib_trie from inside the clone. /sbin/ip is missing in the
  # proxvex base image, so we use the kernel-side procfs view: every
  # bound IP appears as a "/32 host LOCAL" line (excluding 127.0.0.1).
  ip=$(pct exec "$VMID" -- /bin/cat /proc/net/fib_trie 2>/dev/null \
    | awk '
      /\\|--/ { last = $2; next }
      /\\/32 host LOCAL/ && last !~ /^127\\./ { print last; exit }
    ')
  if [ -n "$ip" ]; then
    printf '[{"id":"clone_ip","value":"%s"}]' "$ip"
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
echo "Error: clone $VMID has no non-loopback IP after $TIMEOUT s" >&2
exit 1
`;
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const cmd: ICommand = {
    name: "Discover clone IP",
    execute_on: "ve",
    script: "inline-discover-clone-ip.sh",
    scriptContent: inlineScript,
    outputs: [],
    ...(outerRestartKey ? { restartKey: outerRestartKey } : {}),
  };
  const ve = new VeExecution(
    [cmd],
    [
      { id: "clone_vmid", value: String(cloneVmid) },
      { id: "timeout_seconds", value: String(timeoutSeconds) },
    ],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
  const ip = String(ve.outputs.get("clone_ip") ?? "");
  if (!ip) throw new Error(`Clone ${cloneVmid} did not bind any non-loopback IP within ${timeoutSeconds}s`);
  logger.info("Clone IP discovered", { cloneVmid, cloneIp: ip });
  return ip;
}

/**
 * Start the cloned CT on the PVE host (via `pct start`).
 * Idempotent: returns immediately if the CT is already running.
 */
export async function startClone(cloneVmid: string, veContextKey: string, outerRestartKey?: string): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) throw new Error(`VE context ${veContextKey} not found`);

  const inlineScript = `#!/bin/sh
set -eu
VMID="{{ clone_vmid }}"
status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo unknown)
if [ "$status" != "running" ]; then
  pct start "$VMID" >&2
fi
echo '[{"id":"started","value":"true"}]'
`;
  const cmd: ICommand = {
    name: "Start clone",
    execute_on: "ve",
    script: "inline-pct-start.sh",
    scriptContent: inlineScript,
    outputs: [],
    ...(outerRestartKey ? { restartKey: outerRestartKey } : {}),
  };
  const ve = new VeExecution(
    [cmd],
    [{ id: "clone_vmid", value: String(cloneVmid) }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
  logger.info("Clone started", { cloneVmid });
}

/**
 * Poll the clone's HTTP /api/version until it returns 200 or the timeout
 * elapses. Returns the version JSON on success.
 *
 * The orchestrator runs in the deployer-CT, which sits on the same bridge
 * as the clone (host-managed=1 + derived static IP), so the clone's IP is
 * directly reachable without any tunneling.
 */
export async function waitForCloneApi(
  cloneIp: string,
  port = 3080,
  timeoutMs = 300_000,
): Promise<{ version: string; gitHash?: string }> {
  // 90s was too tight: under a parallel `/livetest --all` the host is busy
  // installing other LXCs (zfs send/recv contention) and the clone-deployer
  // takes 2–3 min to come up cold. 300s covers that worst case while still
  // failing fast on a truly stuck clone.
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const body = await httpGetJson<{ version: string; gitHash?: string }>(
        `http://${cloneIp}:${port}/api/version`,
        3000,
      );
      logger.info("Clone API reachable", { cloneIp, version: body.version });
      return body;
    } catch (err: any) {
      lastError = err?.message || String(err);
      await sleep(2000);
    }
  }
  throw new Error(`Clone ${cloneIp}:${port} did not respond within ${timeoutMs}ms (last error: ${lastError})`);
}

/**
 * Stage-B no-op: issue a single GET against the clone and return its
 * response. Used to prove that round-trips work end-to-end.
 */
export async function triggerNoOpOnClone(cloneIp: string, port = 3080): Promise<unknown> {
  const body = await httpGetJson<unknown>(`http://${cloneIp}:${port}/api/applications`, 5000);
  return body;
}

/**
 * Stage-C real trigger: POST the original upgrade/reconfigure request to
 * the clone's VeConfiguration endpoint. The clone runs the regular
 * pipeline (skipping orchestration thanks to the `_orchestrated_via_clone`
 * flag) and drives the replace against `previous_vm_id` = the deployer
 * that is being upgraded.
 *
 * Returns the restart key the clone assigned to its task — the orchestrator
 * can poll it via /api/ve/execute against the clone (left to the caller).
 */
export async function triggerUpgradeViaClone(
  cloneIp: string,
  veContextKey: string,
  application: string,
  task: TaskType,
  params: ParamNV[],
  previousVmid: string,
  selectedAddons: string[],
  port = 3080,
  timeoutMs = 30_000,
  outerRestartKey?: string,
  stackIds?: string[],
  disabledAddons?: string[],
): Promise<{ restartKey: string; cloneStatus: number }> {
  // Ensure the clone has the source's VE context configured. The clone
  // is a `pct clone` of the source CT, which carries over /config/
  // storagecontext.json — for a fully provisioned source-deployer this
  // already contains the right SSH config. But fresh-installed proxvex
  // CTs (e.g. the test framework's `proxvex/plain` install) ship with an
  // empty storagecontext: the source-deployer has no SSH config of its
  // own, only the Hub that installed it does. Without injecting one,
  // /api/<ve>/ve-configuration/... on the clone returns 404 "VE context
  // not found" and the orchestrator can't dispatch.
  //
  // Inject the source-deployer's veContext (host + port) on the clone
  // via /api/sshconfig. The same endpoint the test runner uses to seed
  // a fresh Spoke; on the clone it's idempotent (existing configs by
  // host are kept).
  await injectVeContextOnClone(cloneIp, port, veContextKey, outerRestartKey);

  // Ensure previous_vm_id is in the params so the clone's pipeline knows
  // which CT to replace. The orchestrator's caller may or may not have
  // included it — be defensive. (E.5) Pass `params` 1:1 otherwise — this
  // forwards `debug_level` (from the livetest runner's --debug flag) and
  // any other runner-supplied params to the clone-side reconfigure, so
  // the clone's bundle has the same debug richness as a regular task.
  const paramsWithPrev = params.filter((p) => p.name !== "previous_vm_id");
  paramsWithPrev.push({ name: "previous_vm_id", value: String(previousVmid) });

  const body = {
    task,
    params: paramsWithPrev,
    selectedAddons,
    // Forward disabledAddons — the disable-reconfigure flow on the Hub-side
    // sets this to instruct the Clone-side pipeline to STRIP addon-ssl +
    // addon-oidc (or whichever addons the user is turning off). Without
    // forwarding, the Clone re-derives addons from selectedAddons only and the
    // disable scenario produces a new CT that still carries SSL+OIDC — visibly
    // indistinguishable from a no-op upgrade.
    ...(disabledAddons && disabledAddons.length > 0 ? { disabledAddons } : {}),
    [ORCHESTRATED_FLAG]: true,
    // Forward the resolved stack ids from the Hub-side request. The Hub owns
    // the addon stack registry; the clone's registry is a copy of the pre-OIDC
    // source and cannot re-derive oidc_* stacks itself, so the Clone's
    // reconfigure pipeline seeds allStackIds from this — otherwise
    // 185-host-resolve-dependency-hosts fails with "Dependencies require a
    // stack_name but none is set" and depended-on apps resolve to NOT_DEFINED.
    ...(stackIds && stackIds.length > 0 ? { stackIds } : {}),
    // E.8: Hub forwards its outer restartKey to the Clone. The Clone's
    // route handler picks this up and forces setupExecution to use it
    // instead of generating a new one — so the Clone's whole reconfigure
    // pipeline (every command, the debug bundle, all messages) lands
    // under the SAME key the Hub started with. clone-cleanup-service
    // then adopts under that same key on the new CT, and the CLI sees
    // a single coherent task stream end-to-end.
    ...(outerRestartKey ? { outer_restart_key: outerRestartKey } : {}),
  };
  // Route shape: /api/:veContext/ve-configuration/:application (see
  // ApiUri.VeConfiguration in types.mts).
  const url = `http://${cloneIp}:${port}/api/${encodeURIComponent(veContextKey)}/ve-configuration/${encodeURIComponent(application)}`;
  logger.info("Triggering clone-side upgrade", { url, task, previousVmid, selectedAddons, disabledAddons, outerRestartKey });
  const response = await httpPostJson<{ restartKey?: string }>(url, body, timeoutMs);
  if (!response.body?.restartKey) {
    throw new Error(
      `Clone returned no restartKey (status=${response.status}, body=${JSON.stringify(response.body).slice(0, 200)})`,
    );
  }
  return { restartKey: response.body.restartKey, cloneStatus: response.status };
}

/**
 * Detect whether the current request is a deployer self-upgrade: the
 * deployer-instance marker on `previousVmid` AND the request was not
 * already routed through a clone (which would loop infinitely).
 *
 * Returns true only when:
 *   - application is "proxvex"
 *   - task is "upgrade" or "reconfigure"
 *   - previousVmid carries the deployer-instance marker on the PVE host
 *   - the request body does NOT carry the ORCHESTRATED_FLAG
 */
export async function shouldOrchestrateSelfUpgrade(
  application: string,
  task: TaskType,
  previousVmid: string | undefined,
  requestBody: any,
  veContextKey: string,
): Promise<{ orchestrate: boolean; resolvedPreviousVmid?: string }> {
  if (application !== "proxvex") return { orchestrate: false };
  if (task !== "upgrade" && task !== "reconfigure") return { orchestrate: false };
  if (requestBody && requestBody[ORCHESTRATED_FLAG] === true) return { orchestrate: false };
  // If the caller didn't supply previous_vm_id, autodetect from /proc/1/cgroup.
  // Lets a simple POST `/api/<ve>/ve-configuration/proxvex { task: reconfigure }`
  // trigger self-upgrade without the caller having to know the Hub's vmid.
  let resolvedPreviousVmid = previousVmid;
  if (!resolvedPreviousVmid) {
    const { getSelfVmid } = await import("./self-vmid-service.mjs");
    const self = await getSelfVmid();
    if (!self) {
      logger.warn("shouldOrchestrateSelfUpgrade: no previous_vm_id supplied AND self-vmid autodetect failed — declining to orchestrate");
      return { orchestrate: false };
    }
    resolvedPreviousVmid = self;
    logger.info("previous_vm_id autodetected via self-vmid-service", { resolvedPreviousVmid });
  }

  // Probe via SSH whether the previous CT has the deployer-instance marker.
  // Cheaper than a full VeExecution roundtrip; reuses the existing SSH
  // master connection that VeExecution would establish anyway.
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) return { orchestrate: false };

  const inlineScript = `#!/bin/sh
set -eu
VMID="{{ previous_vm_id }}"
if pct config "$VMID" 2>/dev/null | grep -qa deployer-instance; then
  echo '[{"id":"is_deployer","value":"true"}]'
else
  echo '[{"id":"is_deployer","value":"false"}]'
fi
`;
  const cmd: ICommand = {
    name: "Detect deployer-instance marker",
    execute_on: "ve",
    script: "inline-is-deployer.sh",
    scriptContent: inlineScript,
    outputs: [],
  };
  const ve = new VeExecution(
    [cmd],
    [{ id: "previous_vm_id", value: String(resolvedPreviousVmid) }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  try {
    await ve.run(null);
  } catch (err: any) {
    logger.warn("Could not probe deployer marker — proceeding without orchestration", {
      previousVmid: resolvedPreviousVmid,
      error: err?.message,
    });
    return { orchestrate: false };
  }
  const isDeployer = String(ve.outputs.get("is_deployer") ?? "false") === "true";
  if (!isDeployer) return { orchestrate: false };
  return { orchestrate: true, resolvedPreviousVmid };
}

/**
 * Stage-E: poll the clone's task-message stream and forward every new
 * message into the original deployer's message manager under the same
 * restart key. The UI is already subscribed to the original's SSE
 * stream — by mirroring messages locally we give the user a continuous
 * live view of the clone's progress without changing the frontend.
 *
 * Fire-and-forget: started from the route handler after the trigger
 * succeeds; runs until the clone reports the task is finished, or for
 * up to `maxDurationMs` (default 30 min), or until the source CT is
 * stopped and the process dies (whichever first). Errors are logged
 * but not rethrown — losing the mirror is degraded UX, not a failure
 * of the upgrade itself.
 *
 * Polling cadence: 2s. Each tick fetches messages with `?since=N` so
 * we only see new ones. The poll endpoint is cheap (in-memory data on
 * the clone), so 2s is comfortably below "noticeable lag" for a
 * progress UI.
 */
export async function mirrorCloneTaskMessages(opts: {
  cloneIp: string;
  port?: number;
  veContextKey: string;
  application: string;
  task: string;
  /** Unified restart key (E.8): same value the Clone runs under AND the
   *  key the Hub-local MessageManager bucket uses. The Clone's pipeline
   *  emits under this key; the mirror just polls /ve/execute on the
   *  Clone and re-injects each new message under the same key into the
   *  Hub's local manager — so live UI/CLI see continuous progress while
   *  the Hub is still alive. */
  restartKey: string;
  messageManager: WebAppVeMessageManager;
  maxDurationMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const {
    cloneIp,
    port = 3080,
    veContextKey,
    application,
    task,
    restartKey,
    messageManager,
    maxDurationMs = 30 * 60_000,
    pollIntervalMs = 2_000,
  } = opts;

  const startedAt = Date.now();
  let seenIndices = new Set<number>();
  let consecutiveErrors = 0;
  // Hub emitted its own Stage 1-5 markers before the mirror started.
  // Those markers consumed indices 0..N on the Hub's group. The Clone's
  // pipeline starts indexing from 0 too — without an offset, every Clone
  // message would collide with a Hub stage marker (handleFinalMessage
  // merges by index → Clone msg overwrites Stage marker, or vice versa).
  // We compute the offset once on the first batch by looking at the
  // current max-index in the Hub-side group and adding 1. Set to null
  // until established so the first batch wins regardless of arrival order.
  let cloneIndexOffset: number | null = null;

  logger.info("Mirroring clone task messages", { cloneIp, veContextKey, application, task, restartKey });

  while (Date.now() - startedAt < maxDurationMs) {
    let groups: ISingleExecuteMessagesResponse[];
    try {
      // Always fetch the entire group; dedup by msg.index. Don't use
      // `?since=` — the proxvex backend treats since as a wall-clock
      // cutoff that excludes already-recorded messages with earlier ts,
      // which would silently drop the bulk of the clone's task output
      // after the first poll.
      const url = `http://${cloneIp}:${port}/api/${encodeURIComponent(veContextKey)}/ve/execute?restartKey=${encodeURIComponent(restartKey)}`;
      groups = await httpGetJson<ISingleExecuteMessagesResponse[]>(url, 5_000);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      // After ~30s of unbroken errors (15 ticks × 2s), assume the clone
      // is gone (could have been destroyed mid-task by an admin) and
      // exit. Below that, transient errors are expected during the
      // clone's busy phases.
      if (consecutiveErrors > 15) {
        logger.warn("Mirror giving up after sustained errors from clone", {
          cloneIp,
          error: err?.message,
          consecutiveErrors,
        });
        return;
      }
      await sleep(pollIntervalMs);
      continue;
    }

    const group = groups.find((g) => g.restartKey === restartKey);
    if (group) {
      // Establish the offset once, lazily, from the Hub-side group's
      // current max index. Done here (after we know the Clone is alive
      // and has at least one message) so we capture every Stage marker
      // emitted by the route handler before the mirror started.
      if (cloneIndexOffset === null && group.messages.length > 0) {
        const hubGroup = messageManager.messages.find(
          (g) =>
            g.application === application &&
            g.task === task &&
            g.restartKey === restartKey,
        );
        const hubMax = hubGroup
          ? Math.max(
              -1,
              ...hubGroup.messages.map((m) =>
                typeof m.index === "number" ? m.index : -1,
              ),
            )
          : -1;
        cloneIndexOffset = hubMax + 1;
        logger.info("Clone-message index offset established", {
          restartKey,
          cloneIndexOffset,
          hubMax,
        });
      }
      for (const msg of group.messages) {
        // Dedupe by Clone-side index — re-polling returns already-seen
        // messages. seenIndices tracks Clone-side indices, NOT the
        // remapped Hub-side ones.
        const idx = msg.index;
        if (typeof idx === "number") {
          if (seenIndices.has(idx)) continue;
          seenIndices.add(idx);
        }
        // Remap Clone-side index to the Hub-side index space by adding
        // the offset captured above. Messages without an index pass
        // through unchanged.
        const remapped: IVeExecuteMessage =
          typeof idx === "number" && cloneIndexOffset !== null
            ? { ...(msg as IVeExecuteMessage), index: idx + cloneIndexOffset }
            : (msg as IVeExecuteMessage);
        try {
          messageManager.handleExecutionMessage(
            remapped,
            application,
            task,
            restartKey,
          );
        } catch (err: any) {
          logger.warn("Failed to inject mirrored message into local manager", {
            error: err?.message,
            msgIndex: idx,
          });
        }
      }
      // If the most recent message reports finished, we're done.
      // (The group-level shape has no `finished` field; per-message
      // `finished: true` is the canonical end-of-task marker.)
      const lastMsg = group.messages[group.messages.length - 1];
      if (lastMsg && (lastMsg as IVeExecuteMessage).finished) {
        logger.info("Clone task reported finished; mirroring stopped", {
          restartKey,
          messageCount: group.messages.length,
          durationMs: Date.now() - startedAt,
        });
        // Best-effort: pull the Clone's debug bundle into the OUTER's own
        // collector before SIGTERM lands. Gives the still-connected browser
        // a small window (between this point and OUTER shutdown) to fetch
        // the full diagnosis via `/api/ve/debug/<restartKey>` from this
        // OUTER — without having to wait the ~9 min until the NEW CT is up
        // and clone-cleanup-service.finalizeCloneCleanupIfPending runs the
        // primary adoption. Failures are logged but do not block: the NEW
        // CT will still adopt the bundle on its first boot.
        try {
          const { pullAndAdoptBundle } = await import(
            "./clone-cleanup-service.mjs"
          );
          await pullAndAdoptBundle(cloneIp, restartKey);
        } catch (err: any) {
          logger.warn(
            "OUTER-side clone-bundle adoption failed (NEW CT will adopt at boot)",
            { restartKey, error: err?.message },
          );
        }
        return;
      }
    }

    await sleep(pollIntervalMs);
  }

  logger.warn("Mirror reached maxDurationMs without seeing 'finished' — exiting", {
    restartKey,
    maxDurationMs,
  });
}

/**
 * POST the source-deployer's veContext (host + port from PersistenceManager)
 * to the clone's /api/sshconfig endpoint so the clone has a VE context with
 * the same key as the source (`ve_<host>`). Without this, the clone's
 * /api/<veContextKey>/ve-configuration/... handler returns 404 "VE context
 * not found" for fresh-installed clones that ship with an empty
 * storagecontext.
 */
async function injectVeContextOnClone(
  cloneIp: string,
  port: number,
  veContextKey: string,
  outerRestartKey?: string,
): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) {
    throw new Error(`Cannot inject VE context on clone: ${veContextKey} not found in source PersistenceManager`);
  }
  const host = (veContext as { host: string }).host;
  const sshPort = (veContext as { port?: number }).port ?? 22;
  const url = `http://${cloneIp}:${port}/api/sshconfig`;
  // 30s timeout: the clone's backend has just booted and is concurrently
  // running its own background SSH probes (List VM IDs, List Storages,
  // etc.) for the deployer UI. Those compete for the event loop on the
  // first few seconds — the 5s default was sometimes not enough.
  const response = await httpPostJson<unknown>(url, { host, port: sshPort, current: true }, 30_000);
  logger.info("Injected VE context on clone", { cloneIp, veContextKey, host, sshPort, status: response.status });

  // The clone's own SSH key must be authorized on the PVE host so the
  // clone-driven reconfigure can SSH to run execute_on:ve templates. In
  // production the parent deployer's key is already authorized and the
  // clone inherits it via pct clone, so authorization is a no-op. In test
  // setups (proxvex/plain installed by an existing deployer), the new
  // CT's key was never trusted — without this step the clone's first SSH
  // gets `Permission denied (publickey)`.
  //
  // Fetch the publicKeyCommand the clone exposes via GET /api/sshconfigs
  // (the same descriptor the UI shows to the operator with a click-to-run
  // command) and execute it on the PVE host. Idempotent: appending an
  // already-authorized key is a no-op.
  try {
    const sshConfigs = await httpGetJson<{
      sshs?: Array<{ host?: string; publicKeyCommand?: string }>;
    }>(`http://${cloneIp}:${port}/api/sshconfigs`, 10_000);
    const entry = sshConfigs.sshs?.find((s) => s.host === host) ?? sshConfigs.sshs?.[0];
    const pkc = entry?.publicKeyCommand;
    if (!pkc) {
      logger.warn("Clone /api/sshconfigs returned no publicKeyCommand — clone SSH may be denied on PVE host", {
        cloneIp,
        host,
      });
    } else {
      await authorizeClonePubKeyOnVeHost(veContextKey, pkc, outerRestartKey);
      logger.info("Authorized clone's pubkey on PVE host", { cloneIp, veContextKey });
    }
  } catch (err: any) {
    logger.warn("Failed to authorize clone pubkey on PVE host — clone-side reconfigure may fail with Permission denied", {
      cloneIp,
      error: err?.message,
    });
  }
}

/**
 * Run the clone's `publicKeyCommand` (an `echo 'ssh-ed25519 …' >>~/.ssh/
 * authorized_keys` snippet) on the PVE host via VeExecution. The clone's
 * SSH key has to be trusted by the host before any of the clone's
 * `execute_on:ve` templates can connect. Idempotent — running it twice
 * leaves duplicate lines in authorized_keys but doesn't break anything.
 */
async function authorizeClonePubKeyOnVeHost(
  veContextKey: string,
  publicKeyCommand: string,
  outerRestartKey?: string,
): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) throw new Error(`VE context ${veContextKey} not found`);

  // The publicKeyCommand is a literal shell snippet; embedding it directly
  // is safe — the clone is trusted (we just spawned it). Wrap in `sh -c`
  // so multi-statement commands work.
  const inlineScript = `#!/bin/sh
set -eu
mkdir -p /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
{{ public_key_command }}
echo "authorized_keys updated" >&2
printf '[{"id":"pubkey_authorized","value":"true"}]'
`;
  const cmd: ICommand = {
    name: "Authorize clone pubkey on PVE host",
    execute_on: "ve",
    script: "inline-authorize-clone-pubkey.sh",
    scriptContent: inlineScript,
    outputs: [],
    ...(outerRestartKey ? { restartKey: outerRestartKey } : {}),
  };
  const ve = new VeExecution(
    [cmd],
    [{ id: "public_key_command", value: publicKeyCommand }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
}

// ── helpers ──────────────────────────────────────────────────────────────

async function pickVeContext(preferred: string | undefined): Promise<string> {
  const pm = PersistenceManager.getInstance();
  const cm = pm.getContextManager();
  const keys = Array.from(cm.keys()).filter((k) => k.startsWith("ve_"));
  if (preferred && keys.includes(preferred)) return preferred;
  if (keys.length === 0) throw new Error("No VE contexts configured");
  return keys[0]!;
}

function httpPostJson<T>(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 3080,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as T) : ({} as T) });
          } catch (err: any) {
            reject(new Error(`Invalid JSON from ${url}: ${err?.message} (raw=${raw.slice(0, 200)})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout connecting to ${url}`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
        } catch (err: any) {
          reject(new Error(`Invalid JSON from ${url}: ${err?.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout connecting to ${url}`)));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
