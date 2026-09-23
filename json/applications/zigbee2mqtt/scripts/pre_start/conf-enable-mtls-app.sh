#!/bin/sh
# Point zigbee2mqtt's MQTT client at its mTLS client certificate (pre-start /
# reconfigure) when the mTLS addon is enabled.
#
# addon-mtls (161-conf-generate-mtls-certs) writes a CA-signed client cert per
# CN into the `certs` volume under mtls/<CN>/. This app mounts that volume at
# /ssl and uses CN = hostname (mtls_cns default), so inside the container:
#   /ssl/mtls/<hostname>/chain.pem   - CA public cert (verify broker)
#   /ssl/mtls/<hostname>/cert.pem    - client certificate
#   /ssl/mtls/<hostname>/privkey.pem - client private key
#
# We wire these via zigbee2mqtt's env-var config overrides so the MQTT
# connection uses mutual TLS. The broker URL itself (mqtts://...:8883) is set by
# the user in the frontend onboarding wizard; env overrides only manage the cert
# material so it stays consistent with the addon.
#
# Template variables:
#   vm_id    - Container VMID
#   hostname - Container hostname (== client cert CN)
VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

MTLS_DIR="/ssl/mtls/${HOSTNAME}"
echo "Enabling MQTT mTLS for zigbee2mqtt (VM $VM_ID, CN=$HOSTNAME)" >&2

# Remove any existing MQTT mTLS env entries (idempotent on reconfigure)
sed -i '/^lxc\.environment:\s*ZIGBEE2MQTT_CONFIG_MQTT_CA=/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*ZIGBEE2MQTT_CONFIG_MQTT_CERT=/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*ZIGBEE2MQTT_CONFIG_MQTT_KEY=/d' "$CONF_FILE"

cat >> "$CONF_FILE" <<EOF
lxc.environment: ZIGBEE2MQTT_CONFIG_MQTT_CA=${MTLS_DIR}/chain.pem
lxc.environment: ZIGBEE2MQTT_CONFIG_MQTT_CERT=${MTLS_DIR}/cert.pem
lxc.environment: ZIGBEE2MQTT_CONFIG_MQTT_KEY=${MTLS_DIR}/privkey.pem
EOF

echo "MQTT mTLS env variables written to $CONF_FILE" >&2
echo '[{"id":"mtls_app_enabled","value":"true"}]'
