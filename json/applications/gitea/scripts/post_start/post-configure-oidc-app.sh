#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# Runs inside the container as the application user (execute_on with uid/gid).
# Uses Gitea CLI directly — no root issues since we run as git user.

OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
GITEA_ADMIN_USER="admin"
GITEA_ADMIN_PASS="{{ GITEA_ADMIN_PASSWORD }}"
AUTH_NAME="zitadel"
DISCOVERY_URL="${OIDC_ISSUER_URL}/.well-known/openid-configuration"

echo "Configuring Gitea OIDC authentication source..." >&2
echo "  Issuer URL:    ${OIDC_ISSUER_URL}" >&2
echo "  Discovery URL: ${DISCOVERY_URL}" >&2
echo "  Client ID:     ${OIDC_CLIENT_ID}" >&2

# Wait for gitea's DB migration (the web server runs it on first start). The
# CLI commands below — `admin user create`, `admin auth add-oauth` — query
# tables (`user`, `login_source`) that don't exist until migration finishes,
# so polling `admin user list` until it stops failing with "relation does not
# exist" is the cheapest way to gate. Gives up after ~60 s.
echo "Waiting for Gitea DB migration..." >&2
i=0
while [ $i -lt 60 ]; do
  if gitea admin user list >/dev/null 2>&1; then
    echo "Gitea DB ready after ${i}s" >&2
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ $i -ge 60 ]; then
  echo "ERROR: Gitea DB not ready after 60s" >&2
  exit 1
fi

# Create admin user if not exists
EXISTING_USER=$(gitea admin user list 2>/dev/null | grep -w "${GITEA_ADMIN_USER}" || true)
if [ -z "$EXISTING_USER" ]; then
  echo "Creating admin user..." >&2
  gitea admin user create --admin --username "${GITEA_ADMIN_USER}" --password "${GITEA_ADMIN_PASS}" --email "admin@localhost" --must-change-password=false >&2 2>&1
fi

# Check if auth source already exists
EXISTING=$(gitea admin auth list 2>/dev/null | grep -w "${AUTH_NAME}" || true)
if [ -n "$EXISTING" ]; then
  echo "OIDC auth source '${AUTH_NAME}' already exists, skipping." >&2
  exit 0
fi

# Add OIDC auth source via CLI
gitea admin auth add-oauth \
  --name "${AUTH_NAME}" \
  --provider openidConnect \
  --key "${OIDC_CLIENT_ID}" \
  --secret "${OIDC_CLIENT_SECRET}" \
  --auto-discover-url "${DISCOVERY_URL}" \
  --scopes "openid email profile" >&2

if [ $? -eq 0 ]; then
  echo "OIDC auth source '${AUTH_NAME}' created successfully" >&2
else
  echo "ERROR: Failed to create OIDC auth source" >&2
  exit 1
fi
