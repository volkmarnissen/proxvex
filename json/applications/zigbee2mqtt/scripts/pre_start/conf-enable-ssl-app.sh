#!/bin/sh
# Enable native HTTPS for the zigbee2mqtt frontend (pre-start / reconfigure).
#
# zigbee2mqtt has no separate HTTP/HTTPS port: its frontend serves HTTPS on the
# normal frontend port as soon as ssl_cert/ssl_key are set. Instead of editing
# configuration.yaml (which the user manages via the web onboarding wizard), we
# point the frontend at the managed server cert through zigbee2mqtt's
# environment-variable config overrides (ZIGBEE2MQTT_CONFIG_<PATH>). Env
# overrides take precedence over configuration.yaml, so the cert paths stay
# managed regardless of what the user configures in the UI.
#
# The addon-ssl certs are written by 156-conf-generate-certificates into the
# `certs` volume, which this app mounts at /ssl. So inside the container:
#   /ssl/fullchain.pem  - server cert + CA chain
#   /ssl/privkey.pem    - server private key
#
# Template variables:
#   vm_id - Container VMID
VM_ID="{{ vm_id }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

echo "Enabling native HTTPS for zigbee2mqtt frontend (VM $VM_ID, pre-start)" >&2

# Remove any existing frontend SSL env entries (idempotent on reconfigure)
sed -i '/^lxc\.environment:\s*ZIGBEE2MQTT_CONFIG_FRONTEND_SSL_/d' "$CONF_FILE"

cat >> "$CONF_FILE" <<EOF
lxc.environment: ZIGBEE2MQTT_CONFIG_FRONTEND_SSL_CERT=/ssl/fullchain.pem
lxc.environment: ZIGBEE2MQTT_CONFIG_FRONTEND_SSL_KEY=/ssl/privkey.pem
EOF

echo "Frontend SSL env variables written to $CONF_FILE" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
