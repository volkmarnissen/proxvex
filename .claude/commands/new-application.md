Create a new proxvex LXC application from (usually) just an application name. You research the best OCI image and read its upstream docs to drive every decision — SSL/OIDC/mTLS support, disk/memory sizing, serial-device need, base choice. The deliverable is normally three files: `application.json`, a small `icon`, and a well-written `application.md`.

## Usage

The user provides: `$ARGUMENTS`
Format: `<app-name> [<oci-image-ref>] [--production]`

In the normal case the user gives **only a name** (e.g. `homebridge`). Everything else you derive by research. An explicit image ref or `--production` are optional overrides.

## Step 1 — Research the image and its docs (do this first, always)

You need the upstream documentation anyway to make the decisions below, so start there.

1. **Pick the best OCI image.** Prefer the project's **official** image (its GitHub/registry README), then well-maintained `ghcr.io`/Docker Hub images. Favor actively-tagged, multi-arch (amd64) images. Note the canonical `<repo>/<image>` and the default web UI port.
2. **Read the docs** for: web UI port, whether it serves **native HTTPS/TLS**, whether it supports **OIDC / OpenID Connect**, whether it supports **mTLS** (e.g. client certs for an MQTT/DB backend), the **config mechanism** (env vars vs a config file), the **runtime user** (uid/gid), persistent **data paths**, and rough **disk + memory** footprint.

Record these findings — they map directly onto `application.json` and `application.md`.

## Step 2 — Choose the base

- **Default: `extends: "oci-image"`.** Use it for essentially all single-image services.
- **`extends: "docker-compose"`** only when the image is **distroless** (no shell — `oci-image`'s in-container steps can't run) or when it's otherwise foreseeable that the single-image LXC path won't work (multi-container, complex entrypoint, init system needed). See `zitadel`, `postgrest`, `cloudflare-tunnel`.

When unsure, try `oci-image`; switch to `docker-compose` if a livetest shows the container can't be configured.

## Step 3 — Map capabilities → addons & properties (from the docs)

| If the image supports… | Then set |
|---|---|
| **native HTTPS/TLS** | `local_https_port`, `ssl_mode: "native"`, `ssl.needs_server_cert: "true"`, `ssl.needs_ca_cert: "true"`, and add `addon-ssl` to `supported_addons`. (HTTP-only app → just `http_port`, no SSL props.) |
| **OIDC** | add `addon-oidc` to `supported_addons`; set `oidc_roles` (e.g. `[{ "key": "admin", "display_name": "Administrator", "group": "<app>" }]`), `oidc_redirect_uri` + `oidc_post_logout_uri` (use `{{hostname}}{{project_domain_suffix}}:{{local_https_port}}` + the app's callback path), and `oidc_required_role` if it gates a role. See `modbus2mqtt`. |
| **mTLS** (client cert to a backend) | add `addon-mtls`; set `mtls.check_file_paths` to the issued client cert path (e.g. `/ssl/mtls/{{hostname}}/cert.pem`). See `zigbee2mqtt`/`modbus2mqtt`. |
| nothing of the above | `supported_addons: []`, HTTP-only |

Only claim a capability the docs actually confirm — e.g. Zigbee2MQTT has no OIDC, so its `.md` explicitly says the OIDC addon is intentionally unavailable.

## Step 4 — Size disk & memory (from image + app footprint)

| Property | Notes |
|---|---|
| **`disk_size`** | Default is **`0.5` GB** — **intentionally small** (on non-ZFS/thick storage the rootfs is fully allocated, so a bigger disk means slower, larger backups; keep it minimal). It fits small images, but **silently** too small for large ones: the OCI extract then dies with `Disk quota exceeded (os error 122)`. **Set it only when the image needs more than ~0.5 GB extracted.** Rough guide: small Alpine (≤~200 MB compressed — mosquitto, zigbee2mqtt, node-red all run on the default) → leave it; Debian/Node/Python (homebridge, esphome) → `4`; build-heavy (runners, Playwright) → `8`–`16`. Estimate: compressed image ×3–4 ≈ extracted rootfs, plus headroom. |
| **`memory`** | set from the app's documented/known footprint when it's above the base default — e.g. `playwright` 2048, `github-runner` 8192. Lightweight services can omit it. |
| `volumes` | persistent data path(s) from the docs, sized generously (grows over time); add `certs=/ssl` when native SSL/mTLS is on. |

## Step 5 — Serial / USB devices

If the app talks to a **USB serial device** (Zigbee/Z-Wave coordinator, Modbus RTU adapter, ESP flashing — `modbus2mqtt` is the canonical example), it must let the user **pick the serial port**. Append the shared step to each lifecycle phase's `pre_start`:

```json
"installation":  { "pre_start": ["110-conf-map-serial.json", ...] },
"upgrade":       { "pre_start": ["110-conf-map-serial.json", ...] },
"reconfigure":   { "pre_start": ["110-conf-map-serial.json"] }
```

It exposes `host_device_path` (a stable `/dev/serial/by-id/...`) → `container_device_path` (e.g. `/dev/ttyUSB0`). Document both in the `.md`. (`extends` **merges** phases — listing only `pre_start` appends to the base's `pre_start` (deduped by template name), it doesn't replace the rest. To fully replace a base task instead of appending, set `"no_extend": true` on that task object.)

## Step 6 — `application.json` property checklist

`hostname` (=app name) · `disk_size` (only if image > ~0.5 GB) · `memory` (if needed) · `volumes` · `envs` (`TZ=Europe/Berlin` + app env) · `rootfs_storage: local-zfs` · `volume_storage: local-zfs, required` · `oci_image` (`<repo>/<image>:{{oci_image_tag}}`) · `wait_for_network: true` · `uid`/`gid`/`username` (match the image) · `http_port` **or** `local_https_port`+ssl props · `volume_backup: true` · addon/oidc/mtls props per Step 3.

Metadata: `name`, `description` (what it is + runs as an LXC), `extends`, `icon`, `tags` (reuse: `automation`/`iot`/`database`/`infrastructure`/`api`/`development`), `supported_addons`, `url`, `documentation`, `source`. Every property `id` must exist in `json/shared/parameter-definitions.json` — unknown ids silently do nothing. Read the closest sibling and match key order.

## Step 7 — `application.md` (very important — write it carefully)

Read existing ones first: `gitea`, `eclipse-mosquitto`, `zigbee2mqtt`, `homebridge`. Cover:

- **Key Parameters table** (parameter · default · description). **Put long parameter descriptions here** rather than cramming them into the JSON — the frontend surfaces this text, so it's where users actually read it.
- **Where to change configuration.** Be explicit about both levels:
  - the **LXC container config** on the PVE host: `/etc/pve/lxc/<vmid>.conf`;
  - the **app's own config**: the concrete file path inside the volume (e.g. gitea `/data/gitea/conf/app.ini`, mosquitto `/mosquitto/config/mosquitto.conf`) or "configured via env vars / the web UI" if there's no file.
- **HTTPS posture** (HTTP-only vs native), **OIDC/mTLS** behavior, **serial** device mapping, and **storage sizing**.

## Step 8 — Config strategy: env vars vs file upload

For a handful of settings, use `envs`. For **extensive configuration**, prefer **uploading a config file** over maintaining many env vars — it's cleaner and matches how the app is normally configured. Add an upload step template to the app's `templates/` and reference it in `pre_start` (see `node-red` `0-upload-settings-js.json` / `1-upload-flows-json.json`, and mosquitto's `mosquitto.conf` upload). Document the uploaded file and its in-container path in the `.md`.

## Step 9 — Remaining files & the version pin

- **`icon`** (~420×420): `sips -z 420 420 <src>.png --out json/applications/<app>/icon.png` (`.svg` is fine too).
- **`tests/default.json`**: `{ "params": [ { "name": "oci_image_tag", "value": "latest" } ], "wait_seconds": 60, "description": "Install <app>; smoke test the container starts and the UI comes up." }`
- **`json/shared/scripts/library/versions.sh`**: add `OCI_<app>_TAG="${OCI_<app>_TAG:-latest}"   # <repo>/<image>` and append `OCI_<app>_TAG` to the matching `export` line (the `# <image>` comment is parsed to pre-pull for livetests; use underscores).

## Step 10 — Validate, deploy, verify

- `cd backend && pnpm run lint:json` — must list the app under `Applications (N)` and the tag under `Image Versions`. (Pre-commit runs this too.)
- **Push a definition change to a live deployer without redeploying:** `production/setup-production.sh --json-dev-sync` copies the local `json/` tree into the deployer and `POST /api/reload` — running containers are untouched. Use it to ship a fix (e.g. a corrected `disk_size`) to an app that already runs.
- **Verify a new app live (preferred):** `/livetest <app>/default` — reproduces the real deploy in the nested VM, where disk/image/config issues surface safely. Go to production only after a green livetest.

## Optional — first-class production app (`--production`)

Create `production/<app>.json` (`{ "application": "<app>", "task": "installation", "params": [ { "name": "vm_id_start", "value": 600 }, { "name": "oci_image_tag", "value": "latest" } ], "selectedAddons": [] }`) and mirror the last step in `setup-production.sh` (menu line in `print_steps()`, a `should_run N` block calling `deploy.sh --host "$(host_for_app <app>)" <app>.json`, a summary `echo`). Non-default host → add `<app>=<host>` to `APP_HOST_MAP`. Don't touch the `--retry` map (curated, stateless steps only).

## Hard-won gotchas

- **`disk_size` default `0.5 GB`** is intentionally small (fast/small backups on non-ZFS thick storage) but **fails silently** for large images — check the image size and override only when it won't fit (don't blindly set it; small Alpine apps run on the default).
- **`extends` merges everything** — phase lists append to the base (deduped by template name, in category order `image→create_ct→pre_start→pre_start_finalize→start→post_start→replace_ct→check`); `properties`/`parameters` are base-first then yours (so a later same-`id` entry overrides); `supported_addons` is a set union. Set only what differs; never copy the base lifecycle into the app. Need a true override of one task? `"no_extend": true` on that task object clears the base's contribution.
- **`http_port` vs `local_https_port`** decides HTTP vs HTTPS health checks — wrong choice fails the check even though the app is up.
- **Claim capabilities only from real docs** — a wrong `addon-oidc`/`addon-ssl` produces broken auth/TLS wiring.
- **An app is "registered" by its directory** (+ versions.sh pin, + optional production wiring) — there is no central index to edit.
- Custom scripts: POSIX `sh`, stdout JSON-only, logs to stderr, never `2>&1` (CLAUDE.md).
