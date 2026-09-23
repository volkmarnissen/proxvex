#!/bin/sh
# Disable native HTTPS for the Homebridge Config UI X (when the SSL addon is
# disabled). Removes the "ssl" block from the "config" platform in config.json
# so the UI falls back to plain HTTP. config.json itself is preserved; only the
# ssl key is dropped. No-op if the file or block is absent (idempotent).
#
# Runs on the PVE host (execute_on: ve). resolve_host_volume comes from the
# auto-injected ve-global.sh.
#
# Template variables:
#   vm_id    - Container VMID
#   hostname - Container hostname
VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

CONFIG_DIR=$(resolve_host_volume "$HOSTNAME" "config" "$VM_ID") || {
  echo "ERROR: could not resolve homebridge config volume for vmid=$VM_ID host=$HOSTNAME" >&2
  exit 1
}
CONFIG_JSON="${CONFIG_DIR}/config.json"

if [ ! -f "$CONFIG_JSON" ]; then
  echo "config.json not found at $CONFIG_JSON — nothing to disable" >&2
  echo '[{"id":"ssl_app_disabled","value":"true"},{"id":"pg_mtls_disabled","value":"false"}]'
  exit 0
fi

echo "Disabling native HTTPS for Homebridge Config UI X (VM $VM_ID, file=$CONFIG_JSON)" >&2

CONFIG_JSON="$CONFIG_JSON" python3 - <<'PY' || exit 1
import json, os, sys

path = os.environ["CONFIG_JSON"]
with open(path) as f:
    data = json.load(f)

changed = False
for p in data.get("platforms", []) if isinstance(data, dict) else []:
    if isinstance(p, dict) and p.get("platform") == "config" and "ssl" in p:
        del p["ssl"]
        changed = True

if changed:
    with open(path, "w") as f:
        json.dump(data, f, indent=4)
        f.write("\n")
    sys.stderr.write("Removed ssl block from %s\n" % path)
else:
    sys.stderr.write("No ssl block present in %s — nothing to do\n" % path)
PY

echo "Native HTTPS disabled in $CONFIG_JSON" >&2
echo '[{"id":"ssl_app_disabled","value":"true"},{"id":"pg_mtls_disabled","value":"false"}]'
