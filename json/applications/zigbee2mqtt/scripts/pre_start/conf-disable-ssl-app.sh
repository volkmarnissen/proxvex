#!/bin/sh
# Disable native HTTPS for the zigbee2mqtt frontend (when the SSL addon is
# disabled). Removes the frontend SSL env overrides added by
# conf-enable-ssl-app.sh so the frontend falls back to plain HTTP. Without this
# the env vars would survive and zigbee2mqtt would keep trying to serve HTTPS
# from cert files that no longer get refreshed.
#
# Template variables:
#   vm_id - Container VMID
VM_ID="{{ vm_id }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

echo "Disabling native HTTPS for zigbee2mqtt frontend (VM $VM_ID)" >&2

sed -i '/^lxc\.environment:\s*ZIGBEE2MQTT_CONFIG_FRONTEND_SSL_/d' "$CONF_FILE"

echo "Frontend SSL env variables removed from $CONF_FILE" >&2
# 158 declares both outputs; this app has no Postgres-style mTLS coupling.
echo '[{"id":"ssl_app_disabled","value":"true"},{"id":"pg_mtls_disabled","value":"false"}]'
