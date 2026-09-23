#!/usr/bin/env python3
"""Map serial device to LXC container.

Executed via stdin with map_device_lib.py prepended.
All output goes to stderr; stdout should remain empty.
"""

import os
import re
import sys

# Optional import for editor/type checking; at runtime this script is executed with the
# library code prepended via stdin.
try:
    from map_device_lib import *  # type: ignore
except Exception:
    pass


if "eprint" not in globals():
    def eprint(msg: str) -> None:  # type: ignore
        print(msg, file=sys.stderr, flush=True)


def log(msg: str) -> None:
    eprint(f"map-serial-device: {msg}")


def _parse_lxc_idmap_ranges(config_text: str) -> list[tuple[str, int, int, int]]:
    ranges: list[tuple[str, int, int, int]] = []
    for line in config_text.splitlines():
        m = re.match(r"^\s*lxc\.idmap\s*[:=]\s*([ug])\s+(\d+)\s+(\d+)\s+(\d+)\s*$", line)
        if not m:
            continue
        kind = m.group(1)
        cont_start = int(m.group(2))
        host_start = int(m.group(3))
        length = int(m.group(4))
        ranges.append((kind, cont_start, host_start, length))
    return ranges


def _is_unprivileged_container(config_text: str) -> bool:
    return bool(re.search(r"^\s*unprivileged\s*[:=]\s*1\s*$", config_text, flags=re.MULTILINE))


def _map_id_via_idmap(
    ranges: list[tuple[str, int, int, int]],
    kind: str,
    container_id: int,
) -> int | None:
    for k, cont_start, host_start, length in ranges:
        if k != kind:
            continue
        if cont_start <= container_id < cont_start + length:
            return host_start + (container_id - cont_start)
    return None


def _passthrough_host_id_fallback(container_id: int) -> int:
    # Fallback host id when no lxc.idmap line is visible for this id yet.
    #
    # The serial device is always owned by the application's uid/gid, and proxvex
    # ALWAYS creates a 1:1 passthrough idmap entry for that exact uid/gid (see
    # conf-setup-lxc-uid-mapping.py / conf-setup-lxc-gid-mapping.py). So the host
    # device node must be owned by the SAME numeric id (1:1), not the shifted
    # 100000+id range used for ordinary unprivileged ids.
    #
    # We only reach this fallback when the idmap lines are not readable at this
    # point (e.g. a stale pmxcfs read right after they were written, or a
    # reconfigure clone that did not re-emit mapped_uid/mapped_gid). Using the
    # shifted value here would chown the device to an id that maps to "nobody"
    # inside the container, leaving the app unable to open the port.
    return container_id


def best_effort_chown_numeric(path: str, uid: int, gid: int) -> None:
    try:
        os.chown(path, uid, gid)
    except Exception:
        # Fall back to chown binary if present.
        chown_bin = shutil_which("chown")
        if chown_bin:
            _run([chown_bin, f"{uid}:{gid}", path], check=False)


def main() -> int:
    require_root()

    vm_id = "{{ vm_id }}".strip()
    if not vm_id:
        eprint("Error: vm_id is required")
        return 1

    host_device_path = tmpl_str("{{ host_device_path }}")
    install_replug = tmpl_bool("{{ install_replug_watcher }}")

    if install_replug and not host_device_path:
        eprint("Error: install_replug_watcher=true requires host_device_path (e.g. /dev/serial/by-id/...)")
        return 1

    uid = tmpl_int("{{ uid }}", 0)
    gid = tmpl_int("{{ gid }}", 20)

    mapped_uid_raw = tmpl_str("{{ mapped_uid }}")
    mapped_gid_raw = tmpl_str("{{ mapped_gid }}")

    container_device_path = tmpl_str("{{ container_device_path }}")
    if not container_device_path:
        # Default to a simple, widely-supported device node path inside the container.
        # The host source stays stable via /dev/serial/by-id/...; inside the container the
        # device appears at a fixed path that typical apps can open directly.
        container_device_path = "/dev/ttyUSB0"

    if not container_device_path.startswith("/dev/") or re.search(r"^/dev/.+/.+", container_device_path):
        eprint(f"Warning: container_device_path={container_device_path} is not a simple /dev/<name>; using /dev/serial-by-id")
        container_device_path = "/dev/serial-by-id"

    if not host_device_path:
        eprint("Error: host_device_path is required (e.g. /dev/serial/by-id/usb-...)")
        return 1

    log(
        "start "
        + f"vm_id={vm_id} "
        + f"host_device_path={host_device_path} "
        + f"container_device_path={container_device_path} "
        + f"uid={uid} gid={gid} "
        + f"install_replug_watcher={install_replug}"
    )

    vm_type = detect_vm_type(vm_id)
    if vm_type != "lxc":
        eprint(f"Error: map-serial-device currently supports LXC only (vm_id={vm_id}, type={vm_type})")
        return 1

    log(f"detected vm_type={vm_type}")

    config_file = f"/etc/pve/lxc/{vm_id}.conf"
    try:
        config = read_text(config_file)
    except Exception as ex:
        eprint(f"Error: Cannot read {config_file}: {ex}")
        return 1

    log(f"loaded config_file={config_file}")

    idmap_ranges = _parse_lxc_idmap_ranges(config)
    is_unpriv = _is_unprivileged_container(config)

    # Derive host-side numeric owner/group for the device node.
    # If the host device node is owned by a UID/GID that is not mapped into the container,
    # it will show up as "nobody" inside the container.
    host_uid: int
    host_gid: int
    if mapped_uid_raw and re.fullmatch(r"\d+", mapped_uid_raw):
        host_uid = int(mapped_uid_raw)
    else:
        host_uid_mapped = _map_id_via_idmap(idmap_ranges, "u", uid)
        if host_uid_mapped is not None:
            host_uid = host_uid_mapped
        elif is_unpriv:
            host_uid = _passthrough_host_id_fallback(uid)
            log(
                f"warning: no lxc.idmap 'u' entry visible for uid={uid}; "
                + f"assuming 1:1 passthrough (host_uid={host_uid}). "
                + "Serial mapping must run after idmap setup."
            )
        else:
            host_uid = uid

    if mapped_gid_raw and re.fullmatch(r"\d+", mapped_gid_raw):
        host_gid = int(mapped_gid_raw)
    else:
        host_gid_mapped = _map_id_via_idmap(idmap_ranges, "g", gid)
        if host_gid_mapped is not None:
            host_gid = host_gid_mapped
        elif is_unpriv:
            host_gid = _passthrough_host_id_fallback(gid)
            log(
                f"warning: no lxc.idmap 'g' entry visible for gid={gid}; "
                + f"assuming 1:1 passthrough (host_gid={host_gid}). "
                + "Serial mapping must run after idmap setup."
            )
        else:
            host_gid = gid

    log(
        f"idmap: unprivileged={is_unpriv} host_uid={host_uid} host_gid={host_gid} "
        + f"(container uid={uid} gid={gid})"
    )

    # Proxmox config format is typically "key: value" (e.g. "arch: amd64").
    # Some tools/scripts may have written "key = value". To avoid duplicates,
    # detect the preferred separator from ANY key style in the file.
    has_colon_style = bool(re.search(r"^[A-Za-z0-9_.-]+:\s+", config, flags=re.MULTILINE))
    has_equals_style = bool(re.search(r"^[A-Za-z0-9_.-]+\s*=\s+", config, flags=re.MULTILINE))
    use_colon = has_colon_style and not has_equals_style
    if has_colon_style and has_equals_style:
        # Mixed file: Proxmox native is colon, so prefer colon.
        use_colon = True
    sep = ":" if use_colon else "="
    log(
        "config separator detected: "
        + ("colon" if use_colon else "equals")
        + f" (has_colon_style={has_colon_style}, has_equals_style={has_equals_style})"
    )

    # Determine current tty device (best-effort) for permissions + major number.
    current_devnode = None
    resolved = resolve_symlink(host_device_path)
    if os.path.exists(resolved):
        current_devnode = resolved
    log(f"resolved host_device_path -> {resolved} (exists={os.path.exists(resolved)})")

    # Update LXC config: remove old lines that could conflict with our target.
    # Match both "key: value" and "key = value" to prevent duplicates.
    target_rel = container_device_path.lstrip("/")
    patterns = [
        re.compile(rf"^\s*lxc\.mount\.entry\s*[:=].*\s+{re.escape(target_rel)}\s+.*$"),
    ]

    # Allow character devices for this class (wildcard major for current node if known, else common majors).
    major_minor = stat_chr_major_minor(resolve_symlink(host_device_path))
    majors_to_allow = []
    if major_minor:
        major, _minor = major_minor
        majors_to_allow = [major]
    else:
        majors_to_allow = [188, 166]

    # Remove any existing devices.allow lines for the majors we are going to ensure.
    for m in majors_to_allow:
        patterns.append(
            re.compile(rf"^\s*lxc\.cgroup2\.devices\.allow\s*[:=]\s*c\s+{m}:\*\s+rwm\s*$"),
        )

    config = remove_lines_matching(config, patterns)

    # Map serial device.
    # Use the *symlink path* in config so container restarts pick up the current target.
    config = ensure_line(
        config,
        f"lxc.mount.entry{sep} {host_device_path} {target_rel} none bind,optional,create=file,uid={uid},gid={gid},mode=0664",
    )

    log(f"ensured mount entry: {host_device_path} -> /{target_rel}")

    for m in majors_to_allow:
        config = ensure_line(config, f"lxc.cgroup2.devices.allow{sep} c {m}:* rwm")
    if major_minor:
        log(f"allowed cgroup device major={majors_to_allow[0]}:* (from stat)")
    else:
        log("allowed cgroup device majors 188:* and 166:* (fallback)")

    if not check_vm_stopped(vm_id, vm_type):
        eprint(f"Warning: Container {vm_id} is running; config changes take effect after restart.")
    try:
        write_text_atomic(config_file, config)
    except Exception as ex:
        eprint(f"Error: Failed to write {config_file}: {ex}")
        return 1

    log(f"wrote updated config_file={config_file}")

    # Best-effort host permissions for dialout-based setup.
    if current_devnode and os.path.exists(current_devnode):
        log(
            f"best-effort host ownership: devnode={current_devnode} "
            + f"(chown {host_uid}:{host_gid} + chmod g+rw)"
        )
        best_effort_chown_numeric(current_devnode, host_uid, host_gid)
        best_effort_chmod_group_rw(current_devnode)

    if install_replug and host_device_path:
        log("installing replug watcher (udev rule + systemd unit)")
        if not shutil_which("udevadm"):
            eprint("Warning: udevadm not found; cannot install replug udev rule.")
            return 0
        if not shutil_which("systemctl"):
            eprint("Warning: systemctl not found; cannot install replug systemd unit.")
            return 0

        devnode_for_match = resolve_symlink(host_device_path)
        if not os.path.exists(devnode_for_match):
            eprint(f"Warning: Cannot resolve host_device_path right now: {host_device_path}")
            devnode_for_match = host_device_path

        try:
            match = udev_match_for_tty(devnode_for_match)
            unit_name = f"lxc-serial-rebind-{vm_id}.service"
            rule_lines = render_udev_rule_lines(match, unit_name)
        except Exception as ex:
            eprint(f"Warning: Failed to derive udev match: {ex}")
            rule_lines = []

        if rule_lines:
            rule_path = f"/etc/udev/rules.d/99-lxc-serial-rebind-{vm_id}.rules"
            write_text_atomic(rule_path, "".join(rule_lines), mode=0o644)
            log(f"installed udev rule: {rule_path}")
        else:
            log("skipping udev rule install (no rule lines)")

        # Systemd oneshot unit (no external scripts)
        unit_path = f"/etc/systemd/system/lxc-serial-rebind-{vm_id}.service"
        unit = f"""[Unit]
Description=Rebind serial device into LXC {vm_id}

[Service]
Type=oneshot
Environment=VM_ID={vm_id}
Environment=HOST_BY_ID={host_device_path}
Environment=TARGET={container_device_path}
Environment=HOST_UID={host_uid}
Environment=HOST_GID={host_gid}
ExecStart=/bin/sh -eu -c 'pid=$(pct pid "$VM_ID" 2>/dev/null || true); [ -n "$pid" ] && [ "$pid" != "0" ] || exit 0; src=$(readlink -f "$HOST_BY_ID" 2>/dev/null || true); [ -n "$src" ] && [ -e "$src" ] || exit 0; if command -v chown >/dev/null 2>&1; then chown "$HOST_UID:$HOST_GID" "$src" 2>/dev/null || true; fi; if command -v chmod >/dev/null 2>&1; then chmod g+rw "$src" 2>/dev/null || true; fi; nsenter -t "$pid" -m -- sh -c "[ -e '$TARGET' ] || : > '$TARGET'" 2>/dev/null || true; nsenter -t "$pid" -m -- sh -c "umount -l '$TARGET' 2>/dev/null || true" 2>/dev/null || true; nsenter -t "$pid" -m -- mount --bind "$src" "$TARGET"'

[Install]
WantedBy=multi-user.target
"""
        write_text_atomic(unit_path, unit, mode=0o644)

        log(f"installed systemd unit: {unit_path}")

        systemctl("daemon-reload")
        systemctl("enable", f"lxc-serial-rebind-{vm_id}.service")
        udev_reload_rules()

        log("replug watcher enabled + udev rules reloaded")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
