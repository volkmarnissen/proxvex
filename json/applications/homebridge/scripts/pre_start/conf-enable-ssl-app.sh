#!/bin/sh
# Enable native HTTPS for the Homebridge Config UI X (pre-start / reconfigure).
#
# Config UI X serves HTTPS itself once an "ssl" block is present in its platform
# entry in config.json — it is NOT configurable via environment variables, so we
# must edit the file. The addon-ssl certs are written by 156-conf-generate-
# certificates into the `certs` volume, which this app mounts at /ssl. Inside the
# container:
#   /ssl/fullchain.pem  - server cert + CA chain
#   /ssl/privkey.pem    - server private key
#
# Behaviour (per project spec):
#   - config.json missing  -> generate a minimal valid config with the ssl block
#   - config.json present   -> add/replace the ssl block on the "config" platform,
#                              preserving everything else (idempotent)
#
# Runs on the PVE host (execute_on: ve). resolve_host_volume comes from the
# auto-injected ve-global.sh.
#
# Template variables:
#   vm_id       - Container VMID
#   hostname    - Container hostname
#   uid / gid           - in-container runtime user
#   mapped_uid / mapped_gid - host-side uid/gid the container user maps to
VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
UI_PORT="{{ http_port }}"
UID_IN="{{ uid }}"
GID_IN="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

CONFIG_DIR=$(resolve_host_volume "$HOSTNAME" "config" "$VM_ID") || {
  echo "ERROR: could not resolve homebridge config volume for vmid=$VM_ID host=$HOSTNAME" >&2
  exit 1
}
CONFIG_JSON="${CONFIG_DIR}/config.json"

echo "Enabling native HTTPS for Homebridge Config UI X (VM $VM_ID, file=$CONFIG_JSON)" >&2

CONFIG_JSON="$CONFIG_JSON" UI_PORT="${UI_PORT:-8581}" python3 - <<'PY' || exit 1
import json, os, secrets, sys

path = os.environ["CONFIG_JSON"]
ui_port = int(os.environ.get("UI_PORT") or "8581")
SSL = {"key": "/ssl/privkey.pem", "cert": "/ssl/fullchain.pem"}

_INVALID_PINS = {"00000000", "11111111", "22222222", "33333333", "44444444",
                 "55555555", "66666666", "77777777", "88888888", "99999999",
                 "12345678", "87654321"}

def gen_mac():
    # locally-administered, unicast MAC for the HomeKit bridge
    octets = [0x02] + [secrets.randbelow(256) for _ in range(5)]
    return ":".join("%02X" % o for o in octets)

def gen_pin():
    while True:
        d = "%08d" % secrets.randbelow(10 ** 8)
        if d not in _INVALID_PINS:
            return "%s-%s-%s" % (d[0:3], d[3:5], d[5:8])

created = False
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        sys.stderr.write("ERROR: %s is not a JSON object\n" % path)
        sys.exit(1)
else:
    created = True
    data = {
        "bridge": {
            "name": "Homebridge",
            "username": gen_mac(),
            "port": 51826,
            "pin": gen_pin(),
        },
        "accessories": [],
        "platforms": [],
    }

platforms = data.setdefault("platforms", [])
if not isinstance(platforms, list):
    sys.stderr.write("ERROR: platforms is not a list in %s\n" % path)
    sys.exit(1)

ui = next((p for p in platforms
           if isinstance(p, dict) and p.get("platform") == "config"), None)
if ui is None:
    ui = {"name": "Config", "port": ui_port, "platform": "config"}
    platforms.append(ui)
ui["ssl"] = SSL

with open(path, "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")

sys.stderr.write("%s config.json; ssl block -> %s\n"
                 % ("Generated" if created else "Patched", path))
PY

# Hand ownership to the container's runtime user (host-side uid/gid the
# container user maps to under the idmap), so Homebridge can read/write it.
OWNER_UID="${MAPPED_UID:-$UID_IN}"
OWNER_GID="${MAPPED_GID:-$GID_IN}"
if [ -n "$OWNER_UID" ] && [ -n "$OWNER_GID" ]; then
  chown "${OWNER_UID}:${OWNER_GID}" "$CONFIG_JSON" 2>/dev/null \
    || echo "WARN: could not chown $CONFIG_JSON to ${OWNER_UID}:${OWNER_GID}" >&2
fi

echo "Native HTTPS enabled in $CONFIG_JSON" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
