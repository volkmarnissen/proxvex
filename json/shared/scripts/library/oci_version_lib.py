"""OCI image version resolution library.

Resolves the actual version of an OCI image using skopeo.

Resolution strategy:
1. Test-mode: return pre-populated versions from /tmp/.oci-version-cache.json
2. OCI labels (org.opencontainers.image.version, io.hass.version, etc.)
3. Image tag (if not "latest")
4. Digest matching: compare the digest of "latest" against versioned remote tags

Requires skopeo to be available on the host.
"""

import json
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Optional

# ============================================================================
# Test mode: pre-populated by test infrastructure to avoid skopeo calls
# ============================================================================
_TEST_CACHE_PATH = "/tmp/.oci-version-cache.json"
_test_cache: Optional[dict] = None  # lazy-loaded, once per script run


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _load_test_cache() -> dict:
    """Load test cache if present. Returns empty dict in production."""
    global _test_cache
    if _test_cache is not None:
        return _test_cache
    try:
        with open(_TEST_CACHE_PATH, "r") as f:
            _test_cache = json.load(f)
            if _test_cache.get("_meta", {}).get("mode") == "test":
                _log(f"Using test cache: {_TEST_CACHE_PATH}")
                return _test_cache
    except Exception:
        pass
    _test_cache = {}
    return _test_cache


def _is_test_mode() -> bool:
    """Check if running in test mode (pre-populated cache with mode=test)."""
    return _load_test_cache().get("_meta", {}).get("mode") == "test"


# ============================================================================
# Skopeo wrappers
# ============================================================================

def oci_skopeo_inspect(image_ref: str, timeout: int = 30) -> Optional[dict]:
    """Inspect an image via skopeo. Returns parsed JSON or None on failure.

    Forward declaration: run_skopeo is defined later in this module."""
    if _is_test_mode():
        return _load_test_cache().get("inspect", {}).get(image_ref) or None

    ref = image_ref if image_ref.startswith("docker://") else f"docker://{image_ref}"
    cmd = ["skopeo", "inspect", "--override-os", "linux", "--override-arch", "amd64", ref]

    res = run_skopeo(cmd, timeout=timeout, image_ref=ref)
    if not res.ok():
        annotated = res.annotated_stderr().strip()
        if annotated:
            _log(annotated)
        return None
    try:
        return json.loads(res.stdout)
    except Exception:
        return None


def skopeo_list_tags(image_repo: str, timeout: int = 30) -> list[str]:
    """List all tags for an image repository via skopeo."""
    if _is_test_mode():
        entry = _load_test_cache().get("tags", {}).get(image_repo)
        if isinstance(entry, dict):
            return entry.get("tags", [])
        return []

    ref = image_repo if image_repo.startswith("docker://") else f"docker://{image_repo}"
    res = run_skopeo(["skopeo", "list-tags", ref], timeout=timeout, image_ref=ref)
    if not res.ok():
        annotated = res.annotated_stderr().strip()
        if annotated:
            _log(annotated)
        return []
    try:
        data = json.loads(res.stdout)
        return data.get("Tags", [])
    except Exception:
        return []


# ============================================================================
# Version extraction helpers
# ============================================================================

def extract_version_from_labels(inspect_output: dict) -> Optional[str]:
    """Extract version from image labels (multiple common fields)."""
    labels = inspect_output.get("Labels") or {}
    if not labels:
        return None

    version_fields = [
        "org.opencontainers.image.version",
        "io.hass.version",
        "org.opencontainers.image.revision",
        "version",
    ]

    for field in version_fields:
        if field in labels:
            version = labels[field]
            if version and version.strip():
                version = version.strip()
                if version.lower().startswith("v") and len(version) > 1:
                    version = version[1:]
                return version
    return None


def _pick_candidate_tags(all_tags: list[str], limit: int = 5) -> list[str]:
    """Pick the most likely version tags from a list, sorted descending."""
    version_re = re.compile(r"^v?\d+[\d.]*$")
    versioned = [t for t in all_tags if version_re.match(t)]

    def sort_key(t: str) -> list[int]:
        clean = t.lstrip("v")
        try:
            return [int(x) for x in clean.split(".")]
        except ValueError:
            return [0]

    versioned.sort(key=sort_key, reverse=True)
    return versioned[:limit]


def _clean_tag(tag: str) -> str:
    """Strip leading 'v' from a version tag."""
    if tag.lower().startswith("v") and len(tag) > 1:
        return tag[1:]
    return tag


# ============================================================================
# Main resolution functions
# ============================================================================

def resolve_version_by_digest(
    image_repo: str,
    latest_digest: str,
    local_tags: Optional[list[str]] = None,
) -> Optional[str]:
    """Match the digest of 'latest' against versioned tags."""
    # Step 1: Check local tags first (fast)
    if local_tags:
        for tag in local_tags:
            if tag == "latest":
                continue
            data = oci_skopeo_inspect(f"{image_repo}:{tag}")
            if data and data.get("Digest") == latest_digest:
                clean = _clean_tag(tag)
                _log(f"Resolved latest -> {clean} via local digest match")
                return clean

    # Step 2: Check top remote version tags
    _log(f"Checking remote tags for {image_repo}...")
    all_tags = skopeo_list_tags(image_repo)
    candidates = _pick_candidate_tags(all_tags)

    for tag in candidates:
        data = oci_skopeo_inspect(f"{image_repo}:{tag}")
        if data and data.get("Digest") == latest_digest:
            clean = _clean_tag(tag)
            _log(f"Resolved latest -> {clean} via remote digest match")
            return clean

    return None


def resolve_image_version(
    image_ref: str,
    local_tags: Optional[list[str]] = None,
) -> str:
    """Resolve the actual version of an OCI image.

    Returns resolved version string, or "unknown" if resolution fails.
    """
    # Split repo:tag
    if ":" in image_ref:
        repo, tag = image_ref.rsplit(":", 1)
    else:
        repo, tag = image_ref, "latest"

    # Non-latest tag: use it directly
    if tag != "latest":
        return _clean_tag(tag)

    # Test mode: return pre-populated version if available
    if _is_test_mode():
        cached = _load_test_cache().get("versions", {}).get(image_ref)
        if cached:
            _log(f"Resolved version from test cache: {cached}")
            return cached

    # Inspect the image
    data = oci_skopeo_inspect(f"{repo}:{tag}")
    if not data:
        return "unknown"

    # Try labels first
    version = extract_version_from_labels(data)
    if version:
        _log(f"Resolved version from labels: {version}")
        return version

    # Try digest matching
    digest = data.get("Digest")
    if digest:
        version = resolve_version_by_digest(repo, digest, local_tags)
        if version:
            return version

    return "unknown"


# ============================================================================
# Skopeo failure probes
#
# Evidence-gathering on skopeo failure. Each probe reports observations only:
# outcome (ok/fail/skipped), latency, terse detail. No classification, no
# remedy text — those create misleading-confidence reports when the cause
# is something the table doesn't know about. The reader (human or AI) draws
# the conclusion from the probe block.
#
# Probe block schema is stable; downstream tooling may key off the labels.
# ============================================================================

_PROBE_BUDGET_MS_DEFAULT = 5000
_PROBE_PER_STEP_TIMEOUT_S = 1.5
_PROBE_BLOB_PROBE_BYTES = 4096
_PROBE_CONTROL_IMAGE = "alpine:3"
_PROBE_BLOB_HASH_RE = re.compile(
    r"https?://([^/\s]+)/v2/([^\s]+?)/blobs/(sha256:[0-9a-f]{8,})",
)


def _parse_image_ref_parts(image_ref: str) -> tuple[str, str, str]:
    """Return (registry_host, repo_path, tag) from a possibly-prefixed ref.

    `docker://registry-1.docker.io/library/postgres:16-alpine`
        -> ("registry-1.docker.io", "library/postgres", "16-alpine")
    Defaults: registry -> docker.io's canonical name; repo with no slash gets
    "library/" prefix (Docker Hub convention). Returns "" for fields we can't
    determine — caller decides whether to skip that probe."""
    ref = image_ref[len("docker://"):] if image_ref.startswith("docker://") else image_ref
    # tag
    tag = "latest"
    if "@" in ref:
        ref, _ = ref.split("@", 1)
    if ":" in ref.rsplit("/", 1)[-1]:
        ref_head, tag = ref.rsplit(":", 1)
    else:
        ref_head = ref
    # host vs repo
    if "/" in ref_head:
        head, rest = ref_head.split("/", 1)
        if "." in head or ":" in head or head == "localhost":
            registry, repo = head, rest
        else:
            registry, repo = "registry-1.docker.io", ref_head
    else:
        registry, repo = "registry-1.docker.io", ref_head
    if registry in ("registry-1.docker.io", "docker.io", "index.docker.io") and "/" not in repo:
        repo = "library/" + repo
    return registry, repo, tag


def _probe_step(label: str, fn) -> dict:
    """Run a probe function, capture outcome + latency. Never raises."""
    t0 = time.monotonic()
    try:
        ok, detail = fn()
    except Exception as exc:
        ok, detail = False, f"probe error: {type(exc).__name__}: {exc}"
    latency_ms = int((time.monotonic() - t0) * 1000)
    return {"label": label, "ok": bool(ok), "detail": detail, "latency_ms": latency_ms}


def _http_get_head(url: str, *, range_bytes: Optional[int] = None,
                   timeout: float = _PROBE_PER_STEP_TIMEOUT_S) -> tuple[int, dict, int]:
    """Issue a GET (optionally Range-limited) ignoring TLS. Returns
    (status, headers-dict, bytes_received). Used for both HEAD-style probes
    (Range: 0-0) and the blob-streaming probe (Range: 0-N)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "proxvex-skopeo-probe/1")
    if range_bytes is not None:
        req.add_header("Range", f"bytes=0-{max(range_bytes - 1, 0)}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            data = resp.read(range_bytes if range_bytes else 64)
            return resp.status, dict(resp.headers), len(data)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), 0


def _extract_failing_blob_url(stderr: str) -> Optional[str]:
    """If skopeo stderr names a specific failing blob URL, return it.

    Lets us re-probe the exact byte stream that broke — the smoking gun
    for the postgres-16-alpine truncated-blob case."""
    if not stderr:
        return None
    m = _PROBE_BLOB_HASH_RE.search(stderr)
    return m.group(0) if m else None


def probe_registry(image_ref: str, *, stderr: str = "",
                   budget_ms: int = _PROBE_BUDGET_MS_DEFAULT) -> list[dict]:
    """Cheap evidence collection against the registry/mirror serving image_ref.

    Probes (each skipped if the cumulative budget is exhausted):
      1. DNS:                 hostname -> ip
      2. Mirror /v2/ HEAD:    is the registry up and speaking the v2 protocol?
      3. Manifest HEAD:       does the registry claim to have this image?
      4. Control alpine:3 HEAD: same network path, different image —
                              disambiguates image-specific vs mirror-wide
      5. Blob first-N GET:    if skopeo stderr names a failing blob, probe
                              its actual byte stream. The "200 then EOF"
                              signature is what catches mirror cache
                              corruption.

    Returns a list of probe dicts. Never raises; bad probes return
    ok=False with a short detail. If test mode is active, returns []."""
    if _is_test_mode():
        return []
    registry, repo, tag = _parse_image_ref_parts(image_ref)
    steps: list[dict] = []
    t_start = time.monotonic()

    def budget_left() -> bool:
        return int((time.monotonic() - t_start) * 1000) < budget_ms

    if not registry:
        return steps

    # 1. DNS
    if budget_left():
        def _dns() -> tuple[bool, str]:
            ip = socket.gethostbyname(registry)
            return True, f"{registry} -> {ip}"
        steps.append(_probe_step("DNS", _dns))

    # 2. /v2/ reachability
    if budget_left():
        def _v2() -> tuple[bool, str]:
            status, _hdrs, _n = _http_get_head(f"https://{registry}/v2/", range_bytes=0)
            # Registries return 401 with WWW-Authenticate on /v2/ — that's
            # success for the "is it up?" question. Anything in 2xx/4xx
            # means the server is responding.
            return status in (200, 401, 403, 404), f"HTTP {status}"
        steps.append(_probe_step("Mirror /v2/ GET", _v2))

    # 3. Manifest HEAD
    if budget_left() and repo and tag:
        manifest_url = f"https://{registry}/v2/{repo}/manifests/{tag}"
        def _man() -> tuple[bool, str]:
            status, hdrs, _n = _http_get_head(manifest_url, range_bytes=0)
            size = hdrs.get("content-length") or hdrs.get("Content-Length") or "?"
            return status in (200, 401, 403), f"HTTP {status} content-length={size}"
        steps.append(_probe_step("Manifest HEAD", _man))

    # 4. Control image (same network path)
    if budget_left():
        ctrl_url = f"https://{registry}/v2/library/alpine/manifests/3"
        def _ctrl() -> tuple[bool, str]:
            status, hdrs, _n = _http_get_head(ctrl_url, range_bytes=0)
            size = hdrs.get("content-length") or hdrs.get("Content-Length") or "?"
            return status in (200, 401, 403), f"HTTP {status} content-length={size}"
        steps.append(_probe_step(f"Control {_PROBE_CONTROL_IMAGE}", _ctrl))

    # 5. Failing blob — only if skopeo stderr named one
    blob_url = _extract_failing_blob_url(stderr)
    if budget_left() and blob_url:
        def _blob() -> tuple[bool, str]:
            status, hdrs, n = _http_get_head(
                blob_url, range_bytes=_PROBE_BLOB_PROBE_BYTES,
                timeout=_PROBE_PER_STEP_TIMEOUT_S,
            )
            adv = hdrs.get("content-length") or hdrs.get("Content-Length") or "?"
            # A 200/206 that delivered 0 bytes IS the smoking gun for the
            # truncated-blob case — same shape we just saw on postgres
            # 16-alpine. We don't classify it; we just report the bytes.
            return status in (200, 206) and n > 0, (
                f"HTTP {status} advertised={adv} received={n}"
            )
        steps.append(_probe_step(f"Blob GET ({blob_url[-71:]})", _blob))

    return steps


def format_probe_block(probes: list[dict]) -> str:
    """Render a stable, grep-friendly probe block. Labels are part of the
    public schema — keep them stable across versions."""
    if not probes:
        return ""
    width = max(len(p["label"]) for p in probes)
    lines = ["Observations (auto-probed, evidence only — no diagnosis):"]
    for p in probes:
        mark = "ok  " if p["ok"] else "FAIL"
        lines.append(f"  {p['label']:<{width}}  {mark}  {p['latency_ms']}ms  {p['detail']}")
    return "\n".join(lines)


class SkopeoResult:
    """Outcome of a skopeo invocation, with optional probe block on failure."""

    def __init__(self, cmd: list[str], stdout: str, stderr: str, exit_code: int,
                 probes: Optional[list[dict]] = None) -> None:
        self.cmd = cmd
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.probes = probes or []

    def ok(self) -> bool:
        return self.exit_code == 0

    def annotated_stderr(self) -> str:
        """Original skopeo stderr followed by the probe block (if any)."""
        if not self.probes:
            return self.stderr
        block = format_probe_block(self.probes)
        sep = "\n" if self.stderr and not self.stderr.endswith("\n") else ""
        return f"{self.stderr}{sep}{block}"


def run_skopeo(cmd: list[str], *, timeout: int,
               image_ref: Optional[str] = None,
               probe_on_failure: bool = True,
               heartbeat_seconds: int = 30) -> SkopeoResult:
    """Run a `skopeo ...` command, gather probe evidence on non-zero exit.

    The caller decides what to do with the exit code — this function is
    pure observation, not control flow. On failure, probes are run against
    the image_ref (extracted from the command if not given) and skopeo's
    own stderr (used to spot a named failing blob).

    Heartbeat: `skopeo copy` of a single large blob (e.g. an ~1GB Playwright
    layer pulled from `mcr.microsoft.com`) can produce no stdout/stderr for
    several minutes while a download is in progress. The livetest runner's
    watchdog kills any subprocess that goes silent for 120s, so we emit a
    short stderr heartbeat every `heartbeat_seconds` while skopeo is still
    running. The heartbeat thread is daemonised and torn down on exit."""
    import os
    import threading
    import time as _time

    if cmd and cmd[0] != "skopeo":
        cmd = ["skopeo", *cmd]

    started = _time.monotonic()
    done = threading.Event()

    def _heartbeat() -> None:
        # Wait `heartbeat_seconds` before first beat — skopeo usually emits
        # something within a few seconds; only kick in if it actually goes
        # silent.
        while not done.wait(heartbeat_seconds):
            elapsed = int(_time.monotonic() - started)
            ref = image_ref or _last_positional_image(cmd) or "skopeo"
            try:
                sys.stderr.write(f"skopeo {ref}: still running ({elapsed}s elapsed, pid={os.getpid()})\n")
                sys.stderr.flush()
            except Exception:
                # never let a heartbeat failure kill the run
                return

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        stdout, stderr, code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        stderr = (stderr + f"\nskopeo timed out after {timeout}s").lstrip("\n")
        code = 124
    except FileNotFoundError:
        done.set()
        return SkopeoResult(cmd, "", "skopeo: executable not found on PATH", 127)
    finally:
        done.set()

    probes: list[dict] = []
    if probe_on_failure and code != 0:
        ref = image_ref or _last_positional_image(cmd)
        if ref:
            probes = probe_registry(ref, stderr=stderr)
    return SkopeoResult(cmd, stdout, stderr, code, probes)


def _last_positional_image(cmd: list[str]) -> Optional[str]:
    """Heuristic: last argv entry that looks like a `docker://...` or
    `<host>/<repo>:<tag>` image reference. Skopeo image args are always at
    the tail of the command line for inspect/copy."""
    for arg in reversed(cmd):
        if arg.startswith("docker://") or arg.startswith("oci-archive:"):
            return arg if arg.startswith("docker://") else None
        if "/" in arg and ("." in arg.split("/")[0] or ":" in arg):
            return arg
        if ":" in arg and not arg.startswith("-"):
            return arg
    return None
