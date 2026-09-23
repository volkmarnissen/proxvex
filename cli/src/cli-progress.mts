import type { IVeExecuteMessage } from "@shared/types.mjs";
import type { CliApiClient } from "./cli-api-client.mjs";
import { TimeoutError, ExecutionFailedError } from "./cli-types.mjs";

/**
 * Heartbeat cadence for "still polling" stderr messages when neither a new
 * IVeExecuteMessage nor a retry-failure has surfaced. Without this the
 * caller (user / livetest CLI / frontend wrapper) sees nothing while a
 * long step (docker pull, compose up, image build) runs silently — same
 * symptom as the Hub being unreachable, which is unhelpful for diagnosis.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * After this much silence, drop the delta cursor and re-poll from scratch.
 *
 * Delta polling goes blind for good if `lastSeenIndex` ever moves past a
 * message we still need: the message index is a process-global counter shared
 * by all concurrent tasks, and adopted clone messages are injected carrying
 * their ORIGINAL (lower) indexes. The terminal "Completed" frame then stays
 * invisible and the task dies of timeout although the backend finished it
 * minutes earlier — seen under livetest --all on upgrade/reconfigure
 * scenarios, where the backend group ended in Completed/finished=true while
 * the CLI polled on for another 4-5 minutes.
 *
 * The existing recovery only covers a Hub replacement (retry gap + known
 * post-replace endpoint); this one needs no such context.
 */
const CURSOR_RESET_AFTER_MS = 90_000;

export interface ProgressOptions {
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  timeout: number;
  /** Filter polled messages to this restartKey only — required under
   *  parallel livetest runs, where multiple CLI processes share the same
   *  VE host but each speaks for a single deploy. Without it the server
   *  returns the union of all groups → each CLI sees other CLIs' errors.
   */
  restartKey?: string;
  /** Override heartbeat cadence (ms). Defaults to HEARTBEAT_INTERVAL_MS.
   *  Set to 0 to disable. Tests use a small value to exercise the path
   *  without faking timers. */
  heartbeatIntervalMs?: number;
}

export class CliProgress {
  private seenMessages = 0;
  private lastSeenIndex = -1;
  private totalSteps?: number;
  private startTime = Date.now();
  private lastMessageTime = Date.now();
  private lastHeartbeatTime = Date.now();
  // Phase-2 OIDC suite: latest endpoint state emitted by template
  // 351-post-emit-endpoint-config from the message stream. Captured eagerly
  // during normal polling so that when the Hub-LXC then replaces itself
  // (proxvex/self-reconfigure-{enable,disable}-https-oidc) and the original
  // baseUrl goes dark, the retry-catch block can fail over to this URL
  // instead of timing out the test.
  private pendingEndpointUrl?: string;
  private pendingRequiresOidc?: boolean;

  constructor(
    private client: CliApiClient,
    private veContext: string,
    private options: ProgressOptions,
  ) {}

  async poll(): Promise<{ vmId?: number; success: boolean }> {
    const deadline = Date.now() + this.options.timeout * 1000;
    let retryCount = 0;
    // Default 3 retries (~15 s at 5 s/retry) for normal operations. The
    // self-upgrade-via-clone scenario destroys the deployer-CT mid-task
    // (boot+takeover gap can be 30-60+ s); the livetest runner sets
    // PROXVEX_CLI_MAX_RETRIES to ride out the gap and pick up the
    // adopted finished message on the new CT.
    const maxRetries = parseInt(process.env.PROXVEX_CLI_MAX_RETRIES ?? "3", 10);
    const heartbeatInterval = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    // Tracks whether the current polling stretch went through a retry/error
    // window. When recovery happens AND a 351 emit had told us the post-
    // replace endpoint state, we assume a Hub-replacement straddled the
    // gap and reset the delta-poll cursor — the new Hub adopts clone-task
    // messages with their ORIGINAL indexes, which are below our last-seen
    // mark and would otherwise stay invisible to delta polling forever.
    // This handles the same-URL case (upgrade where addon-ssl+oidc stayed
    // on) that the explicit URL-switch path doesn't cover.
    let hadRetryGap = false;
    let lastCursorReset = 0;
    while (Date.now() < deadline) {
      let messages: IVeExecuteMessage[];
      try {
        const since = this.lastSeenIndex >= 0 ? this.lastSeenIndex : undefined;
        const response = await this.client.getExecuteMessages(
          this.veContext,
          since,
          this.options.restartKey,
        );
        // Response is array of ISingleExecuteMessagesResponse
        const latest = response[response.length - 1];
        messages = latest?.messages ?? [];
        // Capture total steps from plannedSteps on first response
        if (this.totalSteps === undefined && latest?.plannedSteps) {
          this.totalSteps = latest.plannedSteps.length;
        }
        // Post-recovery index reset (covers the same-URL self-upgrade case).
        if (hadRetryGap && this.pendingEndpointUrl && this.lastSeenIndex >= 0) {
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          process.stderr.write(
            `[T+${elapsed}s] Poll recovered after retry window with pending endpoint set — resetting delta cursor to re-receive adopted clone messages from the new Hub\n`,
          );
          this.lastSeenIndex = -1;
          // Re-poll once with since=undefined to pick up adopted messages
          // immediately rather than waiting for the next tick.
          const refetch = await this.client.getExecuteMessages(
            this.veContext, undefined, this.options.restartKey,
          );
          const refetchLatest = refetch[refetch.length - 1];
          messages = refetchLatest?.messages ?? [];
        }
        // Track highest seen index for delta-polling
        for (const msg of messages) {
          if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
            this.lastSeenIndex = msg.index;
          }
        }
        hadRetryGap = false;
        retryCount = 0;
      } catch (err) {
        retryCount++;
        // Phase-2 OIDC suite failover: when polling against the original
        // Hub URL starts failing and a prior message already told us the
        // new endpoint (template 351 ran on the Clone BEFORE replace_ct),
        // hot-swap the API client's base URL and reset retry budget. Use
        // a small threshold (2) so we don't flap on a single transient
        // failure but switch quickly once the Hub is really gone.
        if (
          retryCount >= 2 &&
          this.pendingEndpointUrl &&
          this.pendingEndpointUrl !== this.client.getBaseUrl()
        ) {
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          process.stderr.write(
            `[T+${elapsed}s] Hub at ${this.client.getBaseUrl()} unreachable — `
              + `switching to post-replace endpoint ${this.pendingEndpointUrl}`
              + (this.pendingRequiresOidc ? " (OIDC required)" : "")
              + "\n",
          );
          this.client.setBaseUrl(this.pendingEndpointUrl);
          if (this.pendingRequiresOidc) {
            // Drop any stale token and re-mint via the OIDC issuer the
            // post-replace endpoint expects. If --oidc-* wasn't passed
            // by the caller, authenticateOidc is a no-op and the next
            // request will return 401 (caller's problem to supply creds).
            this.client.resetToken();
            try {
              await this.client.authenticateOidc();
            } catch (authErr: any) {
              process.stderr.write(
                `[T+${elapsed}s] OIDC re-auth failed: ${authErr?.message ?? authErr}\n`,
              );
            }
          }
          // Reset the delta-poll cursor. The old Hub mirrored clone-task
          // messages into its own index space (offset 120 in proxvex's
          // self-upgrade orchestrator); after adoption into the new Hub
          // the clone's messages keep their ORIGINAL indexes (0..N-1).
          // Without this reset, the CLI's lastSeenIndex sits at the
          // mirrored OLD-Hub offset (e.g. 159) — every poll against the
          // new Hub asks `since=159`, but the adopted messages only go
          // up to ~41, so the response is always empty and the CLI never
          // sees the finished frame. Re-receiving messages we already
          // saw on the old Hub is harmless (renderMessage is idempotent;
          // duplicate rendering is fine for diagnostic output).
          this.lastSeenIndex = -1;
          retryCount = 0;
          continue;
        }
        hadRetryGap = true;
        if (retryCount > maxRetries) throw err;
        // Surface the retry so the user knows we're not silently wedged.
        // Skipping json mode keeps the stdout stream pure for parsers; the
        // info still goes to stderr, which json-mode consumers don't read.
        const reason = err instanceof Error ? err.message : String(err);
        const elapsed = Math.round((Date.now() - this.startTime) / 1000);
        process.stderr.write(
          `[T+${elapsed}s] Hub not responding (${reason}); retry ${retryCount}/${maxRetries} in 5s\n`,
        );
        await sleep(5000);
        continue;
      }

      // With delta-polling, all returned messages are new
      for (const msg of messages) {
        this.renderMessage(msg, this.seenMessages);
        this.seenMessages++;
        this.lastMessageTime = Date.now();
        this.lastHeartbeatTime = Date.now();

        // Eagerly capture endpoint-state outputs (emitted by template
        // 351-post-emit-endpoint-config) so we can fail over in the
        // retry-catch above when the original Hub goes dark mid-replace.
        // We only need the *latest* value — subsequent scenarios in the
        // same poll loop will overwrite it.
        if (msg.result) {
          // result may carry a leading LXC_MANAGER_JSON_START_MARKER_<id>\n
          // prefix from the SSH-executor's banner-strip line — slice from
          // the first '[' so we parse the JSON payload regardless. Without
          // this, JSON.parse silently fails and pendingEndpointUrl is never
          // set, the failover never fires, and the CLI retries the dead
          // OLD-Hub URL until cli_timeout.
          const raw = msg.result;
          const jsonStart = raw.indexOf("[");
          if (jsonStart >= 0) {
            try {
              const outputs = JSON.parse(raw.slice(jsonStart));
              if (Array.isArray(outputs)) {
                for (const o of outputs) {
                  if (o && typeof o === "object" && typeof o.id === "string") {
                    if (o.id === "endpoint_url" && typeof o.value === "string" && o.value) {
                      this.pendingEndpointUrl = o.value;
                    } else if (o.id === "endpoint_requires_oidc") {
                      this.pendingRequiresOidc = String(o.value ?? "") === "true";
                    }
                  }
                }
              }
            } catch { /* msg.result not a JSON array */ }
          }
        }

        if (msg.finished) {
          const success = msg.exitCode === 0;
          if (!success) {
            throw new ExecutionFailedError(
              `Execution failed at step '${msg.command}' (exit code ${msg.exitCode})`,
            );
          }
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          if (!this.options.quiet && !this.options.json) {
            process.stderr.write(
              `\nCompleted. VMID: ${msg.vmId ?? "N/A"}, Duration: ${elapsed}s\n`,
            );
            if (msg.completionInfo) {
              const info = msg.completionInfo;
              const line = "=".repeat(60);
              process.stderr.write(`\n${line}\n`);
              process.stderr.write(`  ${info.header}\n`);
              process.stderr.write(`${line}\n`);
              if (info.details) {
                for (const l of info.details.split("\n")) {
                  process.stderr.write(`  ${l}\n`);
                }
              }
              if (info.url) {
                process.stderr.write(`\n  URL: ${info.url}\n`);
              }
              process.stderr.write(`${line}\n`);
            }
          }
          const result: { vmId?: number; success: boolean } = { success: true };
          if (msg.vmId !== undefined) result.vmId = msg.vmId;
          return result;
        }
      }

      // Heartbeat when no message has surfaced for a while. Long steps
      // (docker pull, compose up, image build) can run silently between
      // start and finish — without this the user sees nothing and can't
      // tell apart "still working" from "hung/disconnected".
      const now = Date.now();
      if (
        heartbeatInterval > 0 &&
        now - this.lastHeartbeatTime > heartbeatInterval
      ) {
        const elapsedSinceStart = Math.round((now - this.startTime) / 1000);
        const silentFor = Math.round((now - this.lastMessageTime) / 1000);
        process.stderr.write(
          `[T+${elapsedSinceStart}s] Still polling, no progress for ${silentFor}s\n`,
        );
        this.lastHeartbeatTime = now;
      }

      // Cursor-drift safety net — see CURSOR_RESET_AFTER_MS.
      if (
        this.lastSeenIndex >= 0 &&
        now - this.lastMessageTime > CURSOR_RESET_AFTER_MS &&
        now - lastCursorReset > CURSOR_RESET_AFTER_MS
      ) {
        lastCursorReset = now;
        const elapsed = Math.round((now - this.startTime) / 1000);
        const silent = Math.round((now - this.lastMessageTime) / 1000);
        process.stderr.write(
          `[T+${elapsed}s] No new message for ${silent}s — dropping delta cursor `
            + `(was ${this.lastSeenIndex}) and re-polling in full\n`,
        );
        this.lastSeenIndex = -1;
      }

      await sleep(3000);
    }

    throw new TimeoutError(
      `Execution timed out after ${this.options.timeout}s`,
    );
  }

  private renderMessage(
    msg: IVeExecuteMessage,
    index: number,
  ): void {
    if (this.options.json) {
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }

    // Skip partial streaming messages
    if (msg.partial) return;

    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const step = this.totalSteps ? `[${index + 1}/${this.totalSteps}]` : `[${index + 1}]`;
    const status =
      msg.exitCode === 0
        ? "OK"
        : msg.finished
          ? `FAILED (exit ${msg.exitCode})`
          : "...";
    const extra = msg.vmId ? ` (VMID: ${msg.vmId})` : "";
    const name = msg.command;

    process.stderr.write(
      `[${time}] ${step} ${name} ${"."
        .repeat(Math.max(1, 40 - name.length))} ${status}${extra}\n`,
    );

    // In quiet mode: show step headers (above) but skip logs — except on failure
    if (this.options.quiet) {
      if (msg.exitCode !== 0 && msg.stderr) {
        for (const line of msg.stderr.split("\n")) {
          if (line) process.stderr.write(`    ${line}\n`);
        }
      }
      return;
    }

    if ((this.options.verbose || msg.exitCode !== 0) && msg.stderr) {
      for (const line of msg.stderr.split("\n")) {
        if (line) process.stderr.write(`    ${line}\n`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
