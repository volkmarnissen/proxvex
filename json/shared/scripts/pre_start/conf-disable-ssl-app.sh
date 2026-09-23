#!/bin/sh
# Disable SSL application-specific configuration (no-op default)
#
# This script is called when the SSL addon is disabled.
# Applications can override this script in their own scripts/
# directory to perform application-specific SSL cleanup
# (e.g., removing SSL settings from configuration files).
#
# Override example: examples/applications/postgres/scripts/conf-disable-ssl-app.sh

echo "No application-specific SSL cleanup needed" >&2
# Emit both declared outputs (ssl_app_disabled, pg_mtls_disabled). Apps
# that don't have mTLS support legitimately report pg_mtls_disabled=false.
# Postgres overrides this script with a real true/false based on actual
# state. The shared no-op must still emit ALL declared outputs or the
# backend's output-validation rejects the command (missing-expected-
# outputs error breaks the whole disable pipeline mid-reconfigure).
echo '[{"id":"ssl_app_disabled","value":"false"},{"id":"pg_mtls_disabled","value":"false"}]'
