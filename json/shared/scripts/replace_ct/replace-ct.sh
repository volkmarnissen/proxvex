#!/bin/sh
# Replace old container with new one.
#
# Steps:
# 1) Validate previous_vm_id and vm_id are set and different.
# 2) Start new container if not already running.
# 3) Stop old container.
# 4) Destroy old container.
# 5) Output redirect_url for frontend.
#
# This script runs on the PVE host (execute_on: "ve"), so it can safely
# stop the deployer's own container without killing the script.

set -eu

PROXVEX_REPLACED_LOCK="${PROXVEX_REPLACED_LOCK:-migrate}"

mark_replaced() {
  _vmid="$1"; _new="$2"
  _now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # `pct config` emits the description as a single URL-encoded line. Without
  # decoding here, appending plain markers below and feeding the result back
  # to `pct set --description` causes Proxmox to encode the value a SECOND
  # time — every %3A becomes %253A, every %0A becomes %250A, and the next
  # is_managed_container() pass no longer matches `proxvex:managed`.
  _desc_enc=$(pct config "$_vmid" 2>/dev/null | sed -n 's/^description: //p' | head -1)
  _desc=$(python3 -c "import sys; from urllib.parse import unquote
s = sys.argv[1]
# Iterative decode handles already-double-encoded descriptions left behind
# by earlier versions of this script.
for _ in range(4):
    n = unquote(s)
    if n == s:
        break
    s = n
print(s, end='')" "$_desc_enc" 2>/dev/null || printf '%s' "$_desc_enc")
  # Strip any prior replaced-* markers; description is now in plain form so
  # grep matches by line correctly.
  _clean=$(printf '%s' "$_desc" | grep -v 'proxvex:replaced-' || true)
  _new_desc=$(printf '%s\n<!-- proxvex:replaced-at %s -->\n<!-- proxvex:replaced-by %s -->' \
    "$_clean" "$_now" "$_new")
  pct set "$_vmid" --description "$_new_desc" >&2 2>/dev/null || true
  pct set "$_vmid" --onboot 0 >&2 2>/dev/null || true
  pct set "$_vmid" --lock "$PROXVEX_REPLACED_LOCK" >&2 2>/dev/null || true
  echo "Marked $_vmid replaced-by $_new at $_now (lock=$PROXVEX_REPLACED_LOCK)" >&2
}

SOURCE_VMID="{{ previous_vm_id }}"
TARGET_VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
HTTP_PORT="{{ http_port }}"
LOCAL_HTTPS_PORT="{{ local_https_port }}"
DEPLOYER_BASE_URL="{{ deployer_base_url }}"
VE_CONTEXT_KEY="{{ ve_context_key }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

# ─── Step 1: Validate ────────────────────────────────────────────────────────
if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$SOURCE_VMID" = "$TARGET_VMID" ]; then
  fail "previous_vm_id ($SOURCE_VMID) must differ from vm_id ($TARGET_VMID)"
fi
if [ "$HTTP_PORT" = "NOT_DEFINED" ]; then HTTP_PORT="3000"; fi
if [ "$LOCAL_HTTPS_PORT" = "NOT_DEFINED" ]; then LOCAL_HTTPS_PORT="3443"; fi

# ─── Step 2: Start new container if not running ──────────────────────────────
target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$target_status" != "running" ]; then
  log "Starting new container $TARGET_VMID..."
  ATTEMPTS=3
  WAIT_SECONDS=40
  INTERVAL=2
  attempt=1
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    pct start "$TARGET_VMID" >&2 2>&1 || true
    ELAPSED=0
    while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
      target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
      if [ "$target_status" = "running" ]; then
        break 2
      fi
      sleep "$INTERVAL"
      ELAPSED=$((ELAPSED + INTERVAL))
    done
    attempt=$((attempt + 1))
  done
  if [ "$target_status" != "running" ]; then
    # Rollback: restart old container
    log "Failed to start new container $TARGET_VMID. Restarting old container $SOURCE_VMID..."
    pct start "$SOURCE_VMID" >/dev/null 2>&1 || log "Warning: failed to restart old container $SOURCE_VMID"
    fail "Failed to start new container $TARGET_VMID after $ATTEMPTS attempts"
  fi
fi
log "New container $TARGET_VMID is running"

# ─── Step 3: Determine redirect URL ──────────────────────────────────────────
if [ -n "$DEPLOYER_BASE_URL" ] && [ "$DEPLOYER_BASE_URL" != "NOT_DEFINED" ]; then
  REDIRECT_URL="$DEPLOYER_BASE_URL"
else
  HAS_SSL=0
  if pct exec "$TARGET_VMID" -- test -f /etc/ssl/addon/fullchain.pem 2>/dev/null && \
     pct exec "$TARGET_VMID" -- test -f /etc/ssl/addon/privkey.pem 2>/dev/null; then
    HAS_SSL=1
  fi
  if [ "$HAS_SSL" -eq 1 ]; then
    REDIRECT_URL="https://${HOSTNAME}:${LOCAL_HTTPS_PORT}"
  else
    REDIRECT_URL="http://${HOSTNAME}:${HTTP_PORT}"
  fi
fi

# ─── Step 4: Stop source + mark for delayed cleanup ──────────────────────────
# Historical note: this script used to have a 70-line "Self-upgrade detected"
# special path that wrote .pending-post-upgrade.json into the NEW container's
# /config volume and deferred the stop to the new deployer's finalizer
# (upgrade-finalization-service.mts). With the self-upgrade-via-clone
# orchestrator (stage C of the redesign), the deployer no longer drives
# its own replace — a temporary clone CT runs replace-ct.sh externally,
# so we can stop SOURCE inline without killing our SSH session. The
# special path is gone; the regular path below handles all cases. If
# SOURCE happens to be the deployer instance (e.g. somebody invoked the
# CLI manually instead of going through the orchestrator), the atomic
# start-new + stop-old fast-path in start/lxc-start.sh:21-45 has already
# stopped SOURCE before this script runs.
source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$source_status" = "running" ]; then
  # Per-app stop timeout. This generic replace path serves ALL apps, so it
  # must NOT impose Zitadel's long window on everyone. Zitadel has no
  # app-level shutdown-grace knob; its graceful stop is bounded by in-flight
  # transaction timeouts, the largest being Projections.TransactionDuration
  # (default 1m, zitadel cmd/defaults.yaml) → it needs ~90s or pct SIGKILLs
  # mid-shutdown, leaving lock:/orphan state. Every other app keeps the
  # normal 30s. Detect by the SOURCE container's hostname (cheap; matches
  # how the rest of the codebase identifies zitadel).
  _src_host=$(pct config "$SOURCE_VMID" 2>/dev/null | awk '/^hostname:/{print $2; exit}')
  case "$_src_host" in
    zitadel) _src_stop_timeout=90 ;;
    *)       _src_stop_timeout=30 ;;
  esac
  log "Stopping old container $SOURCE_VMID (${_src_host:-?}, timeout ${_src_stop_timeout}s)..."
  # `pct stop` does not accept --timeout on this PVE — it is the forceful path;
  # only `pct shutdown` carries the timeout knob. Use `pct shutdown --timeout N
  # --forceStop 1` (graceful, SIGKILL after the timeout) with bare `pct stop`
  # as a last-resort fallback — the same pattern lxc-start.sh and
  # host-stop-and-unlink-previous-deployer.sh already use. Without this the stop
  # fails outright ("Unknown option: timeout"), the old container keeps running,
  # and its ZFS datasets stay busy → the destroy below cannot remove them → they
  # surface as orphan_unmounted in the volume-consistency check.
  pct shutdown "$SOURCE_VMID" --timeout "$_src_stop_timeout" --forceStop 1 >&2 \
    || pct stop "$SOURCE_VMID" >&2 \
    || log "Warning: failed to stop old container $SOURCE_VMID"
fi

# Unlink all managed volumes and rename to clean names. The new container
# already owns these volumes; the old container keeps only its rootfs.
vol_unlink_persistent "$SOURCE_VMID"

# Mark + lock instead of immediate destroy. A periodic backend cleanup service
# entsorgt the container after grace period. Activate-button rollback bleibt
# during the grace window möglich.
mark_replaced "$SOURCE_VMID" "$TARGET_VMID"

log "Container $SOURCE_VMID marked for delayed cleanup (replaced by $TARGET_VMID)"

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
