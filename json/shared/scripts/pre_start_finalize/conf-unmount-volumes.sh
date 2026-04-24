#!/bin/sh
# Release host-side volume mounts created during pre_start.
#
# Runs as the final pre_start_finalize step on the VE host, after all addon-
# contributed pre_start templates have executed. Block-based managed volumes
# (LVM, LVM-thin) are mounted during create-storage-volumes so chmod/chown
# and later pre_start scripts can treat them as directories; they must be
# unmounted before `pct start` so Proxmox can mount them into the container.
#
# Directory-backed volumes (ZFS subvol, dir, NFS/CIFS) are never mounted by
# vol_mount — so vol_unmount_all is a no-op for them.
#
# Library: vol-common.sh
#
# Requires:
#   - vm_id: LXC container ID (required)

set -eu

VMID="{{ vm_id }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required for unmount"
fi

log "unmount-volumes: vm_id=$VMID"
vol_unmount_all "$VMID"
printf '[{"id":"volumes_unmounted","value":"true"}]\n'
