# Livetest

Run live integration tests against the active workspace instance (green or yellow), or against any instance via `--config`.

## When to use this skill

Use this skill when the user wants to run a livetest, asks about test failures, or mentions `livetest`, `live test`, `integration test`, or `--fix`.

## Usage

The user provides: `$ARGUMENTS`
Format: `[--fresh] [--fix] [--debug <level>] [--config <instance>] [test-filter]`

### When `$ARGUMENTS` is empty (no parameters)

**Do not run any test.** Show the help text below to the user verbatim, then use `AskUserQuestion` to find out what to run. After the user answers, restart this skill with the chosen arguments as if the user had typed them.

Help text to print:

```
Usage: /livetest [--fresh] [--fix] [--from-snapshot] [--no-parallel]
                 [--debug <level>] [--config <instance>] [test-filter]

Test filter      Application (eclipse-mosquitto), scenario (zitadel/default),
                 "--all" for the full suite, "@<file.lst>" for a curated
                 multi-scenario list, or any tag selector.
@<file.lst>      Read a list of scenarios from a file (one per line, `#`
                 comments). Treated like --all but scoped to the listed
                 scenarios + their deps. Same snapshot semantics as --all.
                 Example: @e2e/snapshot-baseline.lst replaces step3.
--all / @file    Runs in nested-deployer mode by default (--config
                 <auto-instance>): step2b refreshes the deployer LXC from
                 the current sources, then the runner rolls the nested VM
                 back to qm @deployer-installed; parallel default; catalog
                 members get a pct snapshot on success (CT + transitive
                 deps). Use --no-parallel / --parallel=1 to force serial.
                 Tests against the actual deployer LXC (not a local Node
                 process), so self-upgrade-via-clone and other LXC-bound
                 paths run for real.
--from-snapshot  Single-scenario only: roll back each transitive dep CT
                 from its existing pct snapshot (and destroy deps that have
                 none, so they reinstall fresh). Default for single is to
                 reuse running deps without rolling back.
--no-parallel    Force serial execution even when the mode default is
                 parallel (i.e. --all / @file).
--debug LV       off | extLog (default) | script.
--fresh          Wipe .livetest-data; --all already does qm rollback, so
                 --fresh is mainly for non-all runs that want a hard reset.
--fix            Autonomously analyse failures and retry.
--config INST    Target the nested-VM deployer of <inst>. Runs step2b first.

Examples:
  /livetest eclipse-mosquitto
  /livetest --debug script zitadel/default
  /livetest --all                            # step2b + nested-deployer + parallel + snapshots (~60 min)
  /livetest @e2e/snapshot-baseline.lst       # fast baseline build (replaces step3)
  /livetest --from-snapshot zitadel/default  # quick rerun from snapshot
  /livetest --fix pgadmin
  /livetest --config github-action --all
```

Then ask via `AskUserQuestion`:

- **Question**: "Welcher Test soll ausgeführt werden?"
- **Header**: `Test`
- **Options** (single-select):
  - `@e2e/snapshot-baseline.lst` — fast baseline build (replaces step3, ~20 min) (Recommended)
  - `eclipse-mosquitto/default` — single scenario, ~1 min, no dependencies
  - `--all` — full suite (step2b + nested-deployer + parallel + snapshots), ~60 min
  - `--from-snapshot zitadel/default` — rerun zitadel/default off existing snapshot

Then ask in a second question whether to enable `--debug` (single-select):
- **Question**: "Debug-Level?"
- **Header**: `Debug`
- **Options**:
  - `extLog (default)` — bundle written, no `set -x` (Recommended)
  - `script` — bundle with `set -x` in shell scripts (slower)
  - `off` — no bundle

Once both answers are in, treat the inputs as if the user had originally typed `/livetest [--debug <level>] <test>` and execute the steps below.

## Two execution modes

**Local-backend mode (default — no `--config`):**
- Instance auto-detected from workspace directory (`*-yellow` → yellow, `*-green` → green)
- Backend runs locally on `localhost:$DEPLOYER_PORT`
- Talks to nested VM only for `pct` operations
- Fast iteration — no docker build, no nested-VM redeploy

**Nested-deployer mode (`--config <instance>`):**
- Instance from `e2e/config.json`
- step2b runs first → docker build + skopeo + pct create on nested VM
- Deployer LXC inside nested VM has current PR's code
- Slower (~2 min for step2b before tests start)

## Instance derivation

```sh
CONFIG_INSTANCE=""             # populated from --config; empty means local-backend mode
case "$(pwd)" in
  *-yellow|*-yellow/*) AUTO_INSTANCE=yellow ;;
  *-green|*-green/*)   AUTO_INSTANCE=green  ;;
  *)
    case "${DEPLOYER_PORT:-3201}" in
      3301) AUTO_INSTANCE=yellow ;;
      *)    AUTO_INSTANCE=green  ;;
    esac
    ;;
esac
# --all and @file curated runs default to nested-deployer mode
case "${TEST_FILTER:-}" in
  --all|@*) [ -z "$CONFIG_INSTANCE" ] && CONFIG_INSTANCE="$AUTO_INSTANCE" ;;
esac
INSTANCE="${CONFIG_INSTANCE:-$AUTO_INSTANCE}"

VMID=$(jq -r ".instances.${INSTANCE}.vmId" e2e/config.json)
PORT_OFFSET=$(jq -r ".instances.${INSTANCE}.portOffset" e2e/config.json)
PVE_SSH_PORT=$((1022 + PORT_OFFSET))

if [ -n "$CONFIG_INSTANCE" ]; then
    PORTS_DEPLOYER=$(jq -r '.ports.deployer' e2e/config.json)
    DEPLOYER_PORT=$((PORTS_DEPLOYER + PORT_OFFSET))
else
    case "$INSTANCE" in
      yellow) _default_deployer_port=3301 ;;
      *)      _default_deployer_port=3201 ;;
    esac
    DEPLOYER_PORT="${DEPLOYER_PORT:-$_default_deployer_port}"
fi
```

## Steps

1. **Parse arguments**: Check for `--fresh`, `--fix`, `--config <instance>`. Remove them from the test filter. Validate `--config` exists in `e2e/config.json`'s `.instances`. Apply instance-derivation. **Keep `--debug <level>` in the argument list** — it propagates to the backend as `debug_level`.

2. **Build if needed**: Only build if backend TypeScript was changed (`test -f .claude/claude.backend-edited`). If yes: `cd backend && pnpm run build` (and remove marker). If no: skip build.

3. **If `--config $INSTANCE` was provided** (nested-deployer mode):
   - Run `./e2e/step2b-install-deployer.sh $INSTANCE` (~2 min).
   - **Skip step 4** and **patch `e2e/config.json`** so live-test-runner targets the nested-VM deployer:
     ```sh
     cp e2e/config.json /tmp/livetest-config.bak.$$
     trap 'cp /tmp/livetest-config.bak.$$ e2e/config.json; rm -f /tmp/livetest-config.bak.$$' EXIT
     jq --arg i "$INSTANCE" 'del(.instances[$i].deployerHost) | del(.instances[$i].deployerPort)' \
        e2e/config.json > /tmp/livetest-config.new.$$ && mv /tmp/livetest-config.new.$$ e2e/config.json
     ```
   - Jump straight to step 6.

4. **(local-backend mode only)** Start the local backend via helper script:
   ```sh
   ./e2e/start-livetest-deployer.sh [--refresh-hub] $INSTANCE
   ```
   Use `--refresh-hub` when `schemas/**`, `backend/src/types.mts`, `backend/src/persistence/**`, `backend/src/templates/**`, or `backend/src/ve-execution/**` changed. For pure `json/` template/script edits, plain start is enough.

5. **(reserved)** — folded into step 4.

6. **Run the livetest**:
   - Local-backend: `DEPLOYER_PORT=$DEPLOYER_PORT npx tsx backend/tests/livetests/src/live-test-runner.mts $INSTANCE <remaining-args>`
   - Nested-deployer: `npx tsx backend/tests/livetests/src/live-test-runner.mts $INSTANCE <remaining-args>`

   Use 10 minute timeout (15 in `--config` mode). Show full output.

7. **Report results** — summarize pass/fail. Always mention debug-bundle location: `livetest-results/$(ls -1t livetest-results/ | head -1)/`.

   **On ANY failure: read diagnostic data BEFORE naming a cause.** For each failed scenario:
   - `host-diagnostics.md` → `cli-output` — actual error text from deployer/CLI
   - `scripts/*.meta.json` — `jq 'select(.exitCode!=null and .exitCode!=0) | {index,command,exitCode}'`
   - `scripts/<NN>-<slug>.md` — failing script's chronological trace

   Only state a root cause backed by a specific line in the diagnostic data; quote it.

8. **If `--fix` and tests failed**: Enter the fix loop below.

## Fix loop (`--fix`)

Work autonomously through failures. For each failed scenario:

1. **Analyze the failure via the debug bundle** at `livetest-results/<runId>/<scenarioId>/`:
   - Read `test-result.md` for `error_message`
   - Find failed scripts: `jq 'select(.exitCode != 0) | {index, command, exitCode}' scripts/*.meta.json`
   - Open `scripts/<NN>-<slug>.md` for the trace
   - Check `variables.md` for wrong values

2. **Fix the issue** in the codebase (templates, scripts, backend code, application JSON).

3. **Rebuild and/or restart**:
   - Schema/types/persistence/templates/ve-execution changed: `cd backend && pnpm run build && cd .. && ./e2e/start-livetest-deployer.sh --refresh-hub $INSTANCE`
   - Other backend code changed: `cd backend && pnpm run build && cd .. && ./e2e/start-livetest-deployer.sh $INSTANCE`
   - Only JSON/scripts changed: `curl -sk -X POST http://localhost:$DEPLOYER_PORT/api/reload`
   - Nested-deployer mode: `./e2e/step2b-install-deployer.sh $INSTANCE`

4. **Re-run the livetest** with the same filter.

5. **If the same scenario fails again**: fix and retry.

6. **Every failure must be fixed — there is no "skip".** All failures are equal, including infrastructure failures. If truly unfixable, produce a deep root-cause analysis instead.

7. **Repeat** until every scenario passes.

### Fix loop principles
- Be autonomous: don't ask the user unless truly stuck
- Time is not a concern
- No failure is someone else's problem
- Dependency failures cascade: fix the root dependency first
- Always restart the deployer after code changes
- Run unit tests (`pnpm test`) after significant backend changes

## Debug bundle reference

Every livetest run with `debug_level != off` (default: `extLog`) produces a per-scenario debug bundle.

**Layout** (per `livetest-results/<runId>/<scenarioId>/`):

| File | Audience | When to read |
|---|---|---|
| `livetest-index.md` | human | start here |
| `test-result.md` | human + machine | confirm pass/fail, get `error_message` |
| `host-diagnostics.md` | human | LXC log, dmesg, docker logs |
| `index.md` | human | backend bundle entry: script table with exit/duration |
| `variables.md` | human | which variable was used where |
| `scripts/NN-<slug>.md` | human | redacted script body + chronological trace |
| `*.json` sidecars | machine | jq-parseable structured data |

**Quick analysis recipes**:

```sh
# Find all failed scripts across all scenarios of the latest run
RUN=livetest-results/$(ls -1t livetest-results/ | head -1)
jq -r 'select(.exitCode != null and .exitCode != 0)
       | "\(.index)\t\(.exitCode)\t\(.command)"' \
   "$RUN"/*/scripts/*.meta.json

# Show all variables that were NOT_DEFINED at substitution time
jq -r '.[] | select(.redactedValue == "NOT_DEFINED")
       | "\(.var)\tline \(.line)"' \
   "$RUN"/*/scripts/*.substitutions.json
```

## Notes

- `green` / `yellow` instances connect to deployer at `localhost:${DEPLOYER_PORT}` (3201 green, 3301 yellow)
- The deployer uses `.livetest-data/` for context (not `examples/`)
- The PVE host is `ubuntupve`; port-forwarded SSH to nested VM goes through port `1022 + portOffset`
- Do NOT stop the deployer after the test — leave it running for subsequent tests
- After code changes that affect the deployer itself, **restart the deployer** so it picks up the new build
