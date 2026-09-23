#!/bin/sh
# Emit the deployer's current external endpoint + auth state so the livetest
# runner can switch its apiUrl mid-suite after a self-reconfigure/upgrade.
#
# Runs on the PVE host AFTER the container is up. Reads truth from /etc/pve/
# lxc/${vm_id}.conf and the container's /config volume — never from
# scenario-request params, since those describe the request, not the result.
#
# Why this is needed:
#   Self-upgrade scenarios (proxvex/self-reconfigure-enable-https-oidc and
#   proxvex/self-reconfigure-disable-https-oidc in e2e/oidc-self-suite.lst)
#   replace the Hub-LXC mid-run. The new CT either gains addon-ssl+addon-oidc
#   (→ https://...:1643 + bearer required) or strips them back (→ http://...:
#   1280 + no auth). The live-test-runner has no other signal that its
#   original apiUrl is now wrong — except for these outputs.
#
# Inputs:
#   - vm_id            (LXC id)
#   - deployer_base_url (templated initial URL, e.g. http://ubuntupve:1280;
#                       upgraded to https://ubuntupve:1643 when SSL is on)
#
# Outputs (stdout JSON, picked up as cli-message.result by the runner):
#   - endpoint_url           full URL the runner should fetch
#   - endpoint_requires_oidc "true" | "false"
#   - endpoint_oidc_issuer   issuer URL (empty when OIDC off)
#
# Hard skip:
#   - vm_id missing  → silent no-op (e.g. uninstall task already destroyed it)
#   - conf missing   → silent no-op

set -eu

VMID="{{ vm_id }}"
DEPLOYER_BASE="{{ deployer_base_url }}"
APPLICATION_ID="{{ application_id }}"

emit() {
    # Even on skip, emit ONE valid outputs frame so the runner sees we ran
    # and doesn't think it lost the message. Skip-marker just leaves the
    # three values empty.
    printf '[{"id":"endpoint_url","value":"%s"},{"id":"endpoint_requires_oidc","value":"%s"},{"id":"endpoint_oidc_issuer","value":"%s"}]\n' \
        "$1" "$2" "$3"
}

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
    echo "emit-endpoint-config: vm_id missing, emitting empty endpoint" >&2
    emit "" "false" ""
    exit 0
fi

CONF_FILE="/etc/pve/lxc/${VMID}.conf"
if [ ! -f "$CONF_FILE" ]; then
    echo "emit-endpoint-config: no $CONF_FILE, emitting empty endpoint" >&2
    emit "" "false" ""
    exit 0
fi

# Only a proxvex container may report where the deployer lives. The template
# hangs in oci-image's pipeline, so it also runs for ordinary applications —
# and the SSL detection below keys off *this* container's /etc/ssl/addon
# mount. Without this guard every application carrying addon-ssl reports the
# deployer as having moved to HTTPS, and the runner follows it into a port
# that nothing listens on.
if [ "$APPLICATION_ID" != "proxvex" ]; then
    echo "emit-endpoint-config: application '$APPLICATION_ID' is not the deployer, emitting empty endpoint" >&2
    emit "" "false" ""
    exit 0
fi

# OIDC state — driven by lxc.environment: OIDC_ENABLED=true (set by addon-oidc
# pre_start template; absent when the addon is disabled / its env lines were
# stripped by the disable scenario).
OIDC_ENABLED_LINE=$(grep -E '^lxc\.environment:[[:space:]]*OIDC_ENABLED=' "$CONF_FILE" 2>/dev/null | head -1 || true)
OIDC_ENABLED_VAL=$(printf '%s' "$OIDC_ENABLED_LINE" | sed -E 's/.*OIDC_ENABLED=//; s/[[:space:]]*$//')
if [ "$OIDC_ENABLED_VAL" = "true" ]; then
    REQUIRES_OIDC="true"
else
    REQUIRES_OIDC="false"
fi

OIDC_ISSUER_LINE=$(grep -E '^lxc\.environment:[[:space:]]*OIDC_ISSUER_URL=' "$CONF_FILE" 2>/dev/null | head -1 || true)
OIDC_ISSUER=$(printf '%s' "$OIDC_ISSUER_LINE" | sed -E 's/.*OIDC_ISSUER_URL=//; s/[[:space:]]*$//')

# SSL state — addon-ssl mounts a volume at /etc/ssl/addon (see addon-ssl.json
# default volumes). Presence of an mp* line whose mp= field is /etc/ssl/addon
# (with optional trailing comma) is the canonical signal that SSL is active.
if grep -E '^mp[0-9]+:[[:space:]]*[^,]+,(.*,)?mp=/etc/ssl/addon($|,)' "$CONF_FILE" >/dev/null 2>&1; then
    HAS_SSL=1
else
    HAS_SSL=0
fi

# Compute the runner-facing URL. Start from {{ deployer_base_url }} (which
# reflects the URL the install / current request was made against) and flip
# the scheme + port when SSL is active. The default ports follow the install-
# proxvex.sh convention: 3080 (http) / 3443 (https) inside the container, and
# the host-side port-forward mirrors that delta (1280 → 1643 on yellow, 1080
# → 1443 on green). The exact external port is encoded in deployer_base_url
# already; we just need to swap scheme + base port if SSL flipped on/off.
URL="$DEPLOYER_BASE"
if [ -z "$URL" ] || [ "$URL" = "NOT_DEFINED" ]; then
    URL=""
fi

if [ -n "$URL" ]; then
    # Strip trailing slash for clean comparison on the runner side.
    URL=$(printf '%s' "$URL" | sed -E 's:/$::')

    if [ "$HAS_SSL" = "1" ]; then
        # http → https. Port translation: the proxvex install convention
        # offsets HTTPS by +363 from HTTP (3080→3443; 1280→1643; 1080→1443).
        case "$URL" in
            http://*)
                URL=$(printf '%s' "$URL" | sed -E 's/^http:/https:/')
                # If the URL had an explicit port, bump it: \1:NEW
                URL=$(printf '%s' "$URL" \
                    | awk -F: '
                        NF >= 3 {
                            port = $NF + 363
                            sub(/:[0-9]+$/, ":" port);
                        }
                        { print }')
                ;;
        esac
    else
        # https → http when SSL is OFF (the disable scenario).
        case "$URL" in
            https://*)
                URL=$(printf '%s' "$URL" | sed -E 's/^https:/http:/')
                URL=$(printf '%s' "$URL" \
                    | awk -F: '
                        NF >= 3 {
                            port = $NF - 363
                            sub(/:[0-9]+$/, ":" port);
                        }
                        { print }')
                ;;
        esac
    fi
fi

echo "emit-endpoint-config: vm_id=$VMID ssl=$HAS_SSL oidc=$REQUIRES_OIDC url=$URL issuer=$OIDC_ISSUER" >&2
emit "$URL" "$REQUIRES_OIDC" "$OIDC_ISSUER"
