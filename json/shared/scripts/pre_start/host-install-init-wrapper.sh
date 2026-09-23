#!/bin/sh
# =============================================================================
# host-install-init-wrapper.sh — install /usr/local/sbin/proxvex-init into the
# container rootfs so an app that is PID 1 can bind privileged ports.
#
# WHY: in an oci-image app the service IS the container init (lxc.init.cmd),
# and it usually runs as a non-root uid (gitea: uid 1000). Such a process
# cannot bind ports below net.ipv4.ip_unprivileged_port_start (default 1024),
# so an app that should answer on 443 has to be moved to a high port
# (local_https_port defaults to 1443 for exactly that reason).
#
# The sysctl is per network namespace, so it could simply be set for the
# container — but Proxmox rejects raw `lxc.sysctl.*` keys ("unable to parse
# config") and strips them on the next config write, and `lxc.hook.start-host`
# is rejected as well. Inside the container there is no "before the app"
# either: the app is the first process.
#
# SO: wrap init. This script writes a tiny wrapper into the rootfs AND points
# lxc.init.cmd at it, keeping the original command as its arguments. The
# wrapper raises the port range and then `exec "$@"` — no extra process stays
# behind, and it happens on every start, not just the deploy.
#
# Both halves live here on purpose: a reconfigure runs neither
# 107-conf-oci-lxc-configuration nor any other init step, but it DOES re-run
# the ssl addon (159-conf-enable-ssl-app), which moves the app to the new
# port. Split across two templates, a reconfigure would hand the app a
# privileged port without the wrapper — it would fail to bind and the
# container would come up broken. So this template owns the whole feature and
# is wired into installation, upgrade and reconfigure alike; it must run
# AFTER 107 wrote lxc.init.cmd.
#
# File capabilities (setcap cap_net_bind_service, parameter
# bind_privileged_port) are not an alternative here: they need libcap inside
# the guest, they must be applied before the process starts (same ordering
# problem), and a capability written from the host is ignored inside a user
# namespace unless it carries a rootid.
#
# Parameters:
#   vm_id                    - container id (required)
#   unprivileged_port_start  - lowest port a non-root process may bind
#                              (e.g. 443). Empty / NOT_DEFINED → no-op.
#
# Runs on the VE with the container stopped; mounts the rootfs offline via
# vol_mount (same mechanism as host-push-ca-to-container.sh).
#
# Library: pve-common.sh + vol-common.sh (vol_mount, vol_get_storage_type)
# Output: JSON array to stdout
# =============================================================================

VMID="{{ vm_id }}"
PORT_START="{{ unprivileged_port_start }}"

WRAPPER_RELPATH=usr/local/sbin/proxvex-init

if [ -z "$PORT_START" ] || [ "$PORT_START" = "NOT_DEFINED" ]; then
  echo "unprivileged_port_start not set — no init wrapper needed" >&2
  echo '[]'
  exit 0
fi

case "$PORT_START" in
  ''|*[!0-9]*)
    echo "Error: unprivileged_port_start must be a number (got '$PORT_START')" >&2
    exit 1
    ;;
esac
if [ "$PORT_START" -lt 1 ] || [ "$PORT_START" -gt 65535 ]; then
  echo "Error: unprivileged_port_start out of range: $PORT_START" >&2
  exit 1
fi

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  echo "Error: vm_id not set" >&2
  exit 1
fi

# Read rootfs volid from pct config: `rootfs: local-zfs:subvol-500-disk-0,size=1G`
ROOTFS_VOLID=$(pct config "$VMID" 2>/dev/null \
  | awk '/^rootfs:/ {
      sub(/^rootfs:[[:space:]]+/,"");
      split($0,a,",");
      print a[1];
      exit
    }')

if [ -z "$ROOTFS_VOLID" ]; then
  echo "Error: cannot determine rootfs of vmid $VMID from pct config" >&2
  exit 1
fi

ROOTFS_VOLNAME="${ROOTFS_VOLID#*:}"
STORAGE="${ROOTFS_VOLID%%:*}"
STORAGE_TYPE=$(vol_get_storage_type "$STORAGE")
if [ -z "$STORAGE_TYPE" ]; then
  echo "Error: cannot determine storage type for $STORAGE" >&2
  exit 1
fi

ROOTFS_PATH=$(vol_mount "$ROOTFS_VOLID" "$ROOTFS_VOLNAME" "$STORAGE_TYPE" "$STORAGE")
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
  echo "Error: vol_mount returned no usable directory for $ROOTFS_VOLID (got '$ROOTFS_PATH')" >&2
  exit 1
fi

# For block-based storages we mounted ourselves; release the mount on exit so
# pct start can attach the rootfs cleanly (see host-push-ca-to-container.sh).
case "$STORAGE_TYPE" in
  lvm|lvmthin)
    trap 'umount "$ROOTFS_PATH" 2>/dev/null || umount -l "$ROOTFS_PATH" 2>/dev/null || true; rmdir "$ROOTFS_PATH" 2>/dev/null || true' EXIT
    ;;
esac

TARGET="${ROOTFS_PATH}/${WRAPPER_RELPATH}"
mkdir -p "$(dirname "$TARGET")" || {
  echo "Error: cannot create $(dirname "$TARGET")" >&2
  exit 1
}

# The wrapper must not fail the app: a read-only or missing sysctl only means
# privileged ports stay closed, which the app itself will report.
cat > "$TARGET" <<EOF
#!/bin/sh
# Written by proxvex (host-install-init-wrapper.sh) — do not edit.
# Raises the unprivileged port range, then hands over to the app as PID 1.
echo $PORT_START > /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null \\
  || echo "proxvex-init: cannot set ip_unprivileged_port_start" >&2
exec "\$@"
EOF
chmod 0755 "$TARGET"

echo "Installed init wrapper /${WRAPPER_RELPATH} (ip_unprivileged_port_start=$PORT_START)" >&2

# Point lxc.init.cmd at the wrapper, keeping the original command as its
# arguments. Idempotent: a config that already starts with the wrapper (a
# second run, or the clone a reconfigure works on) is left alone.
CONF_FILE="/etc/pve/lxc/${VMID}.conf"
if [ ! -f "$CONF_FILE" ]; then
  echo "Error: $CONF_FILE not found" >&2
  exit 1
fi

CURRENT=$(sed -n 's/^lxc\.init\.cmd:[[:space:]]*//p' "$CONF_FILE" | tail -n1)
if [ -z "$CURRENT" ]; then
  # No init command at all: the app then runs whatever the rootfs uses as
  # init, and this template cannot wrap it. Deliberately not fatal — the
  # wrapper is in place, only unused.
  echo "Warning: no lxc.init.cmd in $CONF_FILE — wrapper installed but not wired" >&2
elif [ "${CURRENT#/$WRAPPER_RELPATH}" != "$CURRENT" ]; then
  echo "lxc.init.cmd already wrapped: $CURRENT" >&2
else
  TMP="${CONF_FILE}.proxvex-init.$$"
  # awk over sed: the command contains slashes, and only the last matching
  # line is authoritative (see the duplicate-line history in 107).
  awk -v wrapper="/$WRAPPER_RELPATH" '
    /^lxc\.init\.cmd:[[:space:]]*/ {
      cmd = $0
      sub(/^lxc\.init\.cmd:[[:space:]]*/, "", cmd)
      print "lxc.init.cmd: " wrapper " " cmd
      next
    }
    { print }
  ' "$CONF_FILE" > "$TMP" && mv "$TMP" "$CONF_FILE"
  echo "Set lxc.init.cmd: /$WRAPPER_RELPATH $CURRENT" >&2
fi

echo '[]'
