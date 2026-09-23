#!/bin/sh
# Read the persisted ZITADEL_EXTERNALDOMAIN from the config managed volume so a
# reconfigure keeps the install-time value instead of the hostname default.
#
# Why: ZITADEL_EXTERNALDOMAIN is a parameter whose default is "= hostname". A
# reconfigure rebuilds parameters from defaults + request and does NOT read the
# live container state, so the value silently drops to the hostname (e.g.
# "zitadel"). The regenerated docker-compose then sends Host:zitadel to the API,
# the instance (registered under the real external domain) is "not found", and
# the login-v2 renders an empty form — locking users out. The correct value is
# already persisted in /config/zitadel.yaml (ExternalDomain:, written only at
# install by template 155, never rewritten on reconfigure), so read it back
# here and emit it as the parameter for the downstream compose generation.
#
# execute_on: ve — reads the host-side config volume before the container is up.
#
# Inputs:  hostname, vm_id
# Output:  ZITADEL_EXTERNALDOMAIN (only when found; on a fresh install or a
#          missing value it emits nothing, leaving the parameter default or an
#          explicit request value in effect).

set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

log() { echo "$@" >&2; }

# On reconfigure the cloned volumes keep the previous container's hostname; use
# the actual container hostname so the volume lookup matches.
ACTUAL_HOST=""
if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  ACTUAL_HOST=$(pct config "$VM_ID" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
fi
[ -z "$ACTUAL_HOST" ] && ACTUAL_HOST="$HOSTNAME"
SAFE_HOST=$(pve_sanitize_name "$ACTUAL_HOST")

CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID" 2>/dev/null || echo "")
if [ -z "$CONFIG_DIR" ] || [ ! -f "$CONFIG_DIR/zitadel.yaml" ]; then
  log "No persisted zitadel.yaml (fresh install or no config volume) — leaving ZITADEL_EXTERNALDOMAIN to the parameter"
  printf '[]\n'
  exit 0
fi

EXTDOMAIN=$(grep -aE '^ExternalDomain:' "$CONFIG_DIR/zitadel.yaml" 2>/dev/null \
  | head -1 | sed -E 's/^ExternalDomain:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')

if [ -n "$EXTDOMAIN" ] && [ "$EXTDOMAIN" != "NOT_DEFINED" ]; then
  log "Persisted ZITADEL_EXTERNALDOMAIN from config volume: $EXTDOMAIN"
  printf '[{"id":"ZITADEL_EXTERNALDOMAIN","value":"%s"}]\n' "$EXTDOMAIN"
else
  log "zitadel.yaml has no usable ExternalDomain — leaving to the parameter"
  printf '[]\n'
fi
