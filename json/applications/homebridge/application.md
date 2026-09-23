# Homebridge

Lightweight server that emulates the iOS HomeKit API so non-HomeKit smart-home
devices become controllable from Apple Home and Siri, via Homebridge's large
plugin ecosystem. Runs as an OCI-image LXC container
(`homebridge/homebridge`). The **Config UI X** web interface — used to edit
`config.json`, install/configure plugins and read logs — listens on port
**8581**.

## HTTPS (addon-ssl)

Config UI X can serve the web interface over **native HTTPS** — enable the
**SSL addon** (`addon-ssl`, mode `native`). The managed server certificate is
written into the `certs` volume (mounted at `/ssl`), and an `ssl` block is
added to the Config UI X platform in `config.json` pointing at it:

```json
"ssl": { "key": "/ssl/privkey.pem", "cert": "/ssl/fullchain.pem" }
```

The UI then serves HTTPS on the same port **8581**. Enabling/disabling SSL
edits `config.json` automatically (see _Configuration_): if the file does not
exist yet it is generated with a minimal valid config; if it exists, only the
`ssl` block is added or removed, preserving everything else.

Without the addon the UI serves **plain HTTP** — put a reverse proxy in front
or keep it on a trusted LAN segment.

## Authentication (no OIDC)

Config UI X uses its **own** authentication — a form login with users stored in
`auth.json` and optional TOTP two-factor. It does **not** support OpenID
Connect / SSO (upstream feature request
[homebridge-config-ui-x#2007](https://github.com/homebridge/homebridge-config-ui-x/issues/2007)),
so the OIDC addon is intentionally not offered for this application.

## Configuration

The effective config file is **`/homebridge/config.json`** (on the `config`
volume; host-side: the `subvol-<vmid>-homebridge-config` managed volume). It is
where the HomeKit bridge details (`bridge.username`, `bridge.pin`), installed
plugins and the Config UI X platform (incl. the managed `ssl` block) live —
edit it from the UI, or directly on the volume. The container-level LXC config
(port maps, mounts, env) is on the PVE host at `/etc/pve/lxc/<vmid>.conf`.

## HomeKit pairing & mDNS

HomeKit accessories are announced and discovered on the local network over
**mDNS / Bonjour**. Because the container sits directly on the LAN with its own
IP (unlike a NATed Docker bridge, which is why the upstream Docker image
requires `network_mode: host`), mDNS advertisement works without extra
configuration. Pair the bridge from the Apple Home app using the PIN shown on
the Config UI X status page.

## Storage

The `config` volume (mounted at `/homebridge`, default 4 GB) holds
`config.json`, the persisted accessory/pairing state and all installed
plugins with their Node modules — which grow as you add plugins, so size it
generously.

## Plugins needing native packages

Some plugins require extra apt packages (e.g. `ffmpeg` for camera plugins).
Add them via the image's `HOMEBRIDGE_APT_PACKAGES` environment variable — set
it in the application's **Environment** parameter (space-separated package
list) and reconfigure.
