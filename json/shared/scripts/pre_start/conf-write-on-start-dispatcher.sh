#!/bin/sh
# Write the on_start_container dispatcher into the host-side proxvex volume.
#
# The dispatcher runs every executable drop-in in /etc/proxvex/on_start.d/ when
# Proxmox starts the container. Addons get it from
# 166-conf-write-on-start-scripts.json, which also writes their own hooks;
# applications without an addon (docker-compose ones need it for the dockerd
# hook) use this template, which shares the dispatcher body via
# pve_write_on_start_dispatcher but pulls in none of the addon parameters.
#
# Runs on the PVE host (execute_on: ve).
#
# Inputs (template variables):
#   hostname - Container hostname
#   vm_id    - Container VMID
#
# Output: JSON to stdout

set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

log() { echo "$@" >&2; }

# For reconfigure: volumes keep the previous container's hostname, but
# {{ hostname }} carries the scenario's intended new hostname. Look up the
# actual container hostname via pct config so the volume lookup matches.
ACTUAL_HOST=""
if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  ACTUAL_HOST=$(pct config "$VM_ID" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
fi
[ -z "$ACTUAL_HOST" ] && ACTUAL_HOST="$HOSTNAME"

SAFE_HOST=$(pve_sanitize_name "$ACTUAL_HOST")
# Tolerant lookup: without a proxvex volume there is nowhere to put the
# dispatcher. That is a skip, not an installation failure.
VOLUME_DIR=$(resolve_host_volume "$SAFE_HOST" "proxvex" "$VM_ID" 2>/dev/null || echo "")

if [ -z "$VOLUME_DIR" ] || [ ! -d "$VOLUME_DIR" ]; then
  log "Warning: no proxvex volume for ${SAFE_HOST} (vmid ${VM_ID}), skipping"
  printf '[{"id":"on_start_dispatcher_written","value":"false"}]\n'
  exit 0
fi

# Ownership follows the parent volume directory (set by template 150).
VOL_OWNER=$(stat -c '%u:%g' "$VOLUME_DIR" 2>/dev/null || echo "0:0")

pve_write_on_start_dispatcher "$VOLUME_DIR" "$VOL_OWNER"
log "Wrote dispatcher: ${VOLUME_DIR}/on_start_container"

printf '[{"id":"on_start_dispatcher_written","value":"true"}]\n'
