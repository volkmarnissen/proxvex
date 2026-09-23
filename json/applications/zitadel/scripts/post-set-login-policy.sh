#!/bin/sh
# Set the Zitadel instance login policy to a known-good state.
#
# Target (mirrors heimvio-green/docker/iam/01_login_policy.sh, the hand-tuned
# production policy):
#   - allowUsernamePassword: true   password login stays available as the
#                                    fallback when passkey isn't set up
#   - passwordlessType: ALLOWED      passkey (WebAuthn) allowed
#   - forceMfa + forceMfaLocalOnly   MFA required, but ONLY for local password
#                                    logins (external IdP does its own MFA)
#   - second factor TOTP             authenticator app as the default 2nd factor
#   - multi factor U2F_WITH_VERIFICATION for the passkey flow
#
# Why proxvex needs to own this: a fresh Zitadel keeps whatever the
# FirstInstance default or an external iam migration left behind. In
# production that was allowUsernamePassword=false — the login-v2 form then
# renders with no fields and every password user is locked out (there is no
# fallback when passkey isn't registered). Setting the policy here makes a
# proxvex-deployed Zitadel match the intended production behaviour on both
# install and reconfigure.
#
# execute_on: lxc — runs inside the zitadel container after docker compose is
# up, using the ephemeral admin PAT (same source + fallbacks as
# 340-post-setup-deployer-in-zitadel). Idempotent: PUT replaces the policy and
# the factor POSTs tolerate "already exists".
#
# Inputs (template variables):
#   compose_project           - docker compose project name
#   ZITADEL_EXTERNALDOMAIN    - public domain; Host header for instance match
#
# Output: JSON to stdout

COMPOSE_PROJECT="{{ compose_project }}"
ZITADEL_EXTERNALDOMAIN="{{ ZITADEL_EXTERNALDOMAIN }}"
[ "$COMPOSE_PROJECT" = "NOT_DEFINED" ] && COMPOSE_PROJECT=""
[ "$ZITADEL_EXTERNALDOMAIN" = "NOT_DEFINED" ] && ZITADEL_EXTERNALDOMAIN=""

emit() { printf '[{"id":"login_policy_set","value":"%s"}]\n' "$1"; }

if ! command -v curl > /dev/null 2>&1; then
  echo "Installing curl..." >&2
  pkg_install curl || { echo "ERROR: curl unavailable" >&2; emit false; exit 1; }
fi

COMPOSE_DIR="/opt/docker-compose/${COMPOSE_PROJECT}"
[ -n "$COMPOSE_PROJECT" ] && [ -d "$COMPOSE_DIR" ] && cd "$COMPOSE_DIR"

ZITADEL_CONTAINER_ID=$(docker ps -q -f name=zitadel-api 2>/dev/null | head -1)

# --- admin PAT: persistent volume first (survives reconfigure), then /proc ---
PAT=""
if [ -f "/bootstrap/admin-client.pat" ]; then
  PAT=$(cat /bootstrap/admin-client.pat 2>/dev/null)
fi
if [ -z "$PAT" ] && [ -n "$ZITADEL_CONTAINER_ID" ]; then
  GO_PID_FMT=$(printf '%s.State.Pid%s' '{{' '}}')
  CONTAINER_PID=$(docker inspect -f "$GO_PID_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
  if [ -n "$CONTAINER_PID" ] && [ -f "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" ]; then
    PAT=$(cat "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" 2>/dev/null)
  fi
fi
if [ -z "$PAT" ]; then
  # PAT gone means hardening already ran on a prior deploy; the policy it set
  # then still stands. Skip rather than fail the whole reconfigure.
  echo "Admin PAT not available — skipping login policy (already bootstrapped)" >&2
  emit skipped
  exit 0
fi

# --- Zitadel API URL (container IP, bypasses Traefik) + Host header ---
GO_IP_FMT=$(printf '%srange .NetworkSettings.Networks%s%s.IPAddress%s%send%s' \
  '{{' '}}' '{{' '}}' '{{' '}}')
ZITADEL_API_IP=$(docker inspect -f "$GO_IP_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
if [ -n "$ZITADEL_API_IP" ]; then
  ZITADEL_URL="http://${ZITADEL_API_IP}:8080"
else
  ZITADEL_URL="http://localhost:8080"
fi
HOST_HEADER="$ZITADEL_EXTERNALDOMAIN"

api() {
  # api METHOD PATH BODY
  curl -sk -X "$1" \
    -H "Authorization: Bearer $PAT" \
    ${HOST_HEADER:+-H "Host: $HOST_HEADER"} \
    -H "Content-Type: application/json" \
    --data "$3" \
    "${ZITADEL_URL}$2" 2>/dev/null
}

echo "Setting instance login policy (password fallback + TOTP + MFA local-only)..." >&2
RESP=$(api PUT /admin/v1/policies/login '{
  "allowUsernamePassword": true,
  "allowRegister": true,
  "allowExternalIdp": true,
  "forceMfa": true,
  "forceMfaLocalOnly": true,
  "passwordlessType": "PASSWORDLESS_TYPE_ALLOWED",
  "hidePasswordReset": false,
  "ignoreUnknownUsernames": false,
  "allowDomainDiscovery": false,
  "disableLoginWithEmail": false,
  "disableLoginWithPhone": true,
  "defaultRedirectUri": "",
  "passwordCheckLifetime": "864000s",
  "externalLoginCheckLifetime": "864000s",
  "mfaInitSkipLifetime": "2592000s",
  "secondFactorCheckLifetime": "64800s",
  "multiFactorCheckLifetime": "43200s"
}')
case "$RESP" in
  *error*|*Error*)
    # "No changes" / "not been changed" is a success for an idempotent PUT.
    case "$RESP" in
      *"No changes"*|*"not been changed"*) : ;;
      *) echo "WARN: login policy PUT response: $RESP" >&2 ;;
    esac
    ;;
esac

echo "Ensuring TOTP second factor..." >&2
api POST /admin/v1/policies/login/second_factors '{"type":"SECOND_FACTOR_TYPE_OTP"}' >/dev/null
echo "Ensuring U2F_WITH_VERIFICATION multi factor..." >&2
api POST /admin/v1/policies/login/multi_factors '{"type":"MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION"}' >/dev/null

echo "Login policy set." >&2
emit true
