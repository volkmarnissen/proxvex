# Zigbee2MQTT

Bridges Zigbee devices to MQTT via a Zigbee coordinator attached to a serial/USB
port. Runs as an OCI-image LXC container (`ghcr.io/koenkk/zigbee2mqtt`).

## Serial coordinator

Map your Zigbee coordinator into the container with the **Map Serial Device**
step:

- Set **USB Serial Port** (`host_device_path`) to a stable `/dev/serial/by-id/...`
  path so the mapping survives replugs.
- The coordinator appears inside the container at **Container Device Path**
  (default `/dev/ttyUSB0`; many sticks enumerate as `/dev/ttyACM0`). Enter this
  same path as the adapter port in the onboarding wizard.

## Configuration

Zigbee2MQTT is configured through its **web onboarding wizard** on first start
(MQTT broker, coordinator/adapter, Zigbee channel) and afterwards via the
frontend **Settings** page — no config file upload is required.

## HTTPS (addon-ssl)

With the SSL addon enabled the frontend serves HTTPS natively on port 8080 using
the managed server certificate. The cert paths are injected via
`ZIGBEE2MQTT_CONFIG_FRONTEND_SSL_CERT` / `_KEY`, so they cannot be overwritten
from the UI.

## MQTT mTLS (addon-mtls)

With the mTLS addon enabled a client certificate (CN = hostname) is issued into
`/ssl/mtls/<hostname>/` and wired into the MQTT client via
`ZIGBEE2MQTT_CONFIG_MQTT_CA` / `_CERT` / `_KEY`. Point the broker URL at
`mqtts://<broker>:8883` in the onboarding wizard.

> OpenID Connect (OIDC) is **not** supported by Zigbee2MQTT — its frontend only
> offers a static `auth_token`. The OIDC addon is therefore intentionally not
> available for this application.
