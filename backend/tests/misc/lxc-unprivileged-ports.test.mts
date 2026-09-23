import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// unprivileged_port_start: an oci-image app is PID 1 and usually runs as a
// non-root uid, so it cannot bind 443. host-install-init-wrapper.sh puts
// /usr/local/sbin/proxvex-init into the rootfs AND points lxc.init.cmd at it,
// keeping the original command as arguments. Both halves are in one template
// because a reconfigure runs only this one (and the ssl addon, which moves the
// app to the new port).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "json/shared/scripts/pre_start");

describe("unprivileged port start", () => {
  let dir: string;
  let binDir: string;
  let rootfs: string;
  let configFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unpriv-ports-"));
    binDir = path.join(dir, "bin");
    rootfs = path.join(dir, "rootfs");
    configFile = path.join(dir, "pct-config.txt");
    fs.mkdirSync(binDir);
    fs.mkdirSync(rootfs);
    fs.writeFileSync(configFile, "rootfs: local-zfs:subvol-513-disk-0,size=8G\n");
    // Container config the script patches; the wiring block overwrites it.
    fs.mkdirSync(path.join(dir, "etc/pve/lxc"), { recursive: true });
    fs.writeFileSync(path.join(dir, "etc/pve/lxc/513.conf"), "lxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n");
    // Mock pct: only `config` is used by the script.
    fs.writeFileSync(
      path.join(binDir, "pct"),
      `#!/bin/sh\n[ "$1" = "config" ] && cat "${configFile}"\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The script sources pve-common.sh/vol-common.sh at runtime; the harness
  // replaces the two volume helpers with stubs that point at our temp rootfs.
  function runInstaller(vars: Record<string, string>) {
    let content = fs.readFileSync(path.join(scriptsDir, "host-install-init-wrapper.sh"), "utf-8");
    for (const [k, v] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
    }
    content = content
      .split('CONF_FILE="/etc/pve/lxc/${VMID}.conf"')
      .join(`CONF_FILE="${path.join(dir, "etc/pve/lxc/513.conf")}"`);
    const stubs = `vol_get_storage_type() { echo zfspool; }\nvol_mount() { echo "${rootfs}"; }\n`;
    const res = spawnSync("sh", ["-s"], {
      input: stubs + content,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    return { code: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
  }

  const wrapper = () => path.join(rootfs, "usr/local/sbin/proxvex-init");

  it("writes an executable wrapper that sets the sysctl and execs the app", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(r.code).toBe(0);
    expect(fs.existsSync(wrapper())).toBe(true);
    const body = fs.readFileSync(wrapper(), "utf-8");
    expect(body).toContain("echo 443 > /proc/sys/net/ipv4/ip_unprivileged_port_start");
    expect(body).toContain('exec "$@"');
    expect(fs.statSync(wrapper()).mode & 0o777).toBe(0o755);
  });

  it("really hands the arguments through when executed", () => {
    runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    // The sysctl write fails outside a container; the wrapper must not care.
    const res = spawnSync("sh", [wrapper(), "/bin/echo", "gitea", "web"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("gitea web");
  });

  it("does nothing when the parameter is unset", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "NOT_DEFINED" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("[]");
    expect(fs.existsSync(wrapper())).toBe(false);
  });

  it("rejects a non-numeric port", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443abc" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("must be a number");
  });

  describe("lxc.init.cmd wiring", () => {
    const conf = () => path.join(dir, "etc/pve/lxc/513.conf");

    function withConf(content: string) {
      fs.mkdirSync(path.dirname(conf()), { recursive: true });
      fs.writeFileSync(conf(), content);
    }

    function runWithConf(vars: Record<string, string>) {
      let content = fs.readFileSync(path.join(scriptsDir, "host-install-init-wrapper.sh"), "utf-8");
      for (const [k, v] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
      }
      content = content.split('CONF_FILE="/etc/pve/lxc/${VMID}.conf"').join(`CONF_FILE="${conf()}"`);
      const stubs = `vol_get_storage_type() { echo zfspool; }\nvol_mount() { echo "${rootfs}"; }\n`;
      const res = spawnSync("sh", ["-s"], {
        input: stubs + content,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: "utf-8",
      });
      return { code: res.status, stderr: res.stderr, conf: fs.readFileSync(conf(), "utf-8") };
    }

    it("prepends the wrapper to an existing init command", () => {
      withConf("hostname: gitea\nlxc.init.cmd: /usr/bin/s6-svscan /etc/s6\nmemory: 2048\n");
      const r = runWithConf({ vm_id: "513", unprivileged_port_start: "443" });
      expect(r.code).toBe(0);
      expect(r.conf).toContain("lxc.init.cmd: /usr/local/sbin/proxvex-init /usr/bin/s6-svscan /etc/s6");
      // The rest of the config must survive untouched.
      expect(r.conf).toContain("memory: 2048");
    });

    it("is idempotent — a second run does not wrap twice", () => {
      withConf("lxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n");
      runWithConf({ vm_id: "513", unprivileged_port_start: "443" });
      const r = runWithConf({ vm_id: "513", unprivileged_port_start: "443" });
      expect(r.code).toBe(0);
      expect(r.conf.match(/proxvex-init/g)?.length).toBe(1);
      expect(r.conf.match(/^lxc\.init\.cmd:/gm)?.length).toBe(1);
    });

    it("wraps the cloned config a reconfigure works on", () => {
      // Reconfigure clones the container: the config already carries the
      // wrapped-or-unwrapped init command, and no other init template runs.
      withConf("hostname: gitea\nlxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n");
      const r = runWithConf({ vm_id: "513", unprivileged_port_start: "443" });
      expect(r.code).toBe(0);
      expect(fs.existsSync(wrapper())).toBe(true);
      expect(r.conf).toContain("proxvex-init");
    });

    it("leaves the config alone when the parameter is unset", () => {
      withConf("lxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n");
      const r = runWithConf({ vm_id: "513", unprivileged_port_start: "NOT_DEFINED" });
      expect(r.code).toBe(0);
      expect(r.conf).not.toContain("proxvex-init");
    });

    it("warns but succeeds when there is no init command to wrap", () => {
      withConf("hostname: gitea\n");
      const r = runWithConf({ vm_id: "513", unprivileged_port_start: "443" });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("no lxc.init.cmd");
    });
  });
});
