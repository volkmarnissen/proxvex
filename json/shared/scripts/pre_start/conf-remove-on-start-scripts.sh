#!/bin/sh
# Remove addon on_start.d scripts and compose overlay from the host-side
# volume directory when an addon is disabled.
#
# Requires:
#   - shared_volpath: Host-side base path for volumes
#   - hostname: Container hostname
#
# Output: JSON to stdout

set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

log() { echo "$@" >&2; }

SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
# Capture failures from resolve_host_volume without letting `set -e` abort
# the whole pipeline. When the addons that own the on-start volume have
# been disabled (e.g. `disable-https-oidc` strips addon-ssl + addon-oidc),
# the new CT has no `subvol-<vmid>-<host>-proxvex` mount — that's the
# correct end-state, NOT a fatal error. Treat the missing volume as a
# "nothing to do" no-op and emit the empty outputs frame.
VOLUME_DIR=$(resolve_host_volume "$SAFE_HOST" "proxvex" "$VM_ID") || VOLUME_DIR=""

if [ -z "$VOLUME_DIR" ] || [ ! -d "$VOLUME_DIR" ]; then
  log "Volume directory missing/empty for ${SAFE_HOST}/proxvex (vmid $VM_ID) — nothing to remove (addons that own this volume are not active)"
  printf '[]\n'
  exit 0
fi

REMOVED=0

# Remove on_start.d scripts
for script in acme-renew.sh ssl-proxy.sh smbd.sh oauth2-proxy-hook.sh; do
  SCRIPT_PATH="${VOLUME_DIR}/on_start.d/${script}"
  if [ -f "$SCRIPT_PATH" ]; then
    rm -f "$SCRIPT_PATH"
    log "Removed: ${SCRIPT_PATH}"
    REMOVED=$((REMOVED + 1))
  fi
done

# Remove reload_certificates hook
RELOAD_PATH="${VOLUME_DIR}/reload_certificates"
if [ -f "$RELOAD_PATH" ]; then
  rm -f "$RELOAD_PATH"
  log "Removed: ${RELOAD_PATH}"
  REMOVED=$((REMOVED + 1))
fi

# Remove docker-compose overlay directory
COMPOSE_DIR="${VOLUME_DIR}/docker-compose"
if [ -d "$COMPOSE_DIR" ]; then
  rm -rf "$COMPOSE_DIR"
  log "Removed: ${COMPOSE_DIR}"
  REMOVED=$((REMOVED + 1))
fi

log "Removed ${REMOVED} on-start items from ${VOLUME_DIR}"

printf '[{"id":"on_start_scripts_removed","value":"%s"}]\n' "$REMOVED"
