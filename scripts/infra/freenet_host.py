"""The remote test host: a network-mode Freenet node and Node.js, by recipe.

    PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python \\
        scripts/infra/freenet_host.py HOST                 # provision (FreenetHost)
    PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python \\
        scripts/infra/freenet_host.py HOST --task sync     # push spikes/freenet (SyncProbes)
    PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python \\
        scripts/infra/freenet_host.py HOST --task rust     # Rust for the contracts (RustToolchain)
    PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python \\
        scripts/infra/freenet_host.py HOST --task contracts   # push the contract crates
    PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python \\
        scripts/infra/freenet_host.py HOST --task repo     # push the tree + npm ci (SyncRepo)

``HOST`` is an ssh alias (or an envs.core Host id). It is never defaulted: a
machine name does not belong in a fabricfile. ``--help`` lists one flag per
typed field.

What ``FreenetHost`` writes on the target, and nothing else:

    <work_dir>/bin/{freenet,fdev}      the release binaries, SHA256SUMS-verified
    <work_dir>/node/                   the Node.js 24.x tarball, SHASUMS256-verified
    <work_dir>/freenet/{config,data,log,cache}   the node's own directories (cache is
                                       its XDG_CACHE_HOME)
    <work_dir>/tmp/                    the downloads and their checksum lists
    <work_dir>/{spikes,repo}/          empty until ``--task sync`` fills spikes/
    /etc/systemd/system/freenet-node.service   ``freenet network`` as a system
                                       unit running as the login user, WS API on
                                       127.0.0.1 only, auto-update disabled
    distro packages                    curl tar xz rsync ca-certificates (and, for
                                       ``--task rust``, gcc + libc headers)

``work_dir`` defaults to ``~/work/zbterm``. The unit is enabled and started;
the run ends only when the WebSocket port listens and the node's log (under
``freenet/log``, not the journal) shows it joined the ring (a connection added
to it), then records the ``nft`` input policies.

``RustToolchain`` (after ``FreenetHost``, whose ``bin/fdev`` it uses) installs rustup with the
official script into ``<work_dir>/rust/{cargo,rustup}`` (``CARGO_HOME`` / ``RUSTUP_HOME``; the
script's default ``~/.cargo`` and ``~/.rustup`` are never used, and ``--no-modify-path`` leaves
the shell profiles alone), the toolchain pinned to ``RUST_VERSION`` with the
``wasm32-unknown-unknown`` target. ``SyncContracts`` runs on this machine: it rsyncs
``scripts/build-contracts.sh``, ``engine/backends/freenet/blake3.js`` and the contract crates
(no ``target``/``build``, no committed ``.wasm`` or ``hashes.json``) to
``<target>:~/work/zbterm/contracts/``, laid out as in the repo, so the build script runs there
unchanged and writes its own ``hashes.json`` to compare (F5 of
docs/projects/260924_freenet-backend/).

``SyncRepo`` runs on this machine (F9, ``A-15``): it rsyncs this working tree to
``<target>:~/work/zbterm/repo/`` without ``node_modules``, ``out``, ``archive``, ``.git``,
``spikes/*/node_modules`` and the other generated or local paths in ``REPO_EXCLUDES`` (so nothing
there is a git checkout), then runs ``npm ci`` there with the provisioned Node, its cache under
``~/work/zbterm/tmp/npm-cache`` and no Electron download (the host has no display). ``npm ci``
is skipped when the remote ``package-lock.json`` is the one the last run installed (a stamp in
``~/work/zbterm/tmp``).

``SyncProbes`` runs on this machine: it rsyncs the repo's ``spikes/freenet/``
(no ``node_modules``, ``.node-data``, ``out`` or contract ``target`` dirs) to
``<target>:~/work/zbterm/spikes/freenet/`` and runs ``npm ci`` there with the
provisioned Node, its cache under ``~/work/zbterm/tmp/npm-cache``.

Tested on Debian 13 (2026-09-24). The Fedora branch (``dnf``) is written but
untested. Every step is idempotent: it first checks whether its work is done
and reports ``kept`` / ``changed: False`` if so, so a second run changes
nothing on the host. The runtime does not skip completed steps across
invocations here (see the note below the imports), so a re-run re-checks
every step (about 7 s on a provisioned host).

The node's UDP ``network_port`` must be reachable from the internet. A cloud
firewall outside the VM (which this recipe cannot see) that drops it shows up
as ``wait_peers`` never firing while the node keeps trying outbound: that is an
operator action, not a recipe bug.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import shlex
from dataclasses import dataclass
from pathlib import Path

from ubitron.envs.rt.fabric import DEFAULT, Task

# Resume across invocations needs the on-disk run store, which only the om2 rail has; on the
# default (om) rail the store is in memory and every invocation starts a fresh run. Measured
# 2026-09-24: with UBITRON_OM_TYPE=om2, Task.run_task_steps fails before its first step
# (om2/ext/tasks.py UBTask.restart: `n_restarts` is _NotHere), even for a one-step local
# task on an empty store. So the recipe runs on the default rail, and every step checks
# whether its work is already done ("kept") instead: a second run changes nothing.

# No DEFAULT_HOST, deliberately: a machine name never belongs in a fabricfile.

FREENET_VERSION = "0.2.136"
# The latest 24.x on nodejs.org/dist on 2026-09-24 (released 2026-09-07).
NODE_VERSION = "24.21.0"
WORK_DIR = "~/work/zbterm"
WS_PORT = 7509
NETWORK_PORT = 31337

RELEASE_URL = "https://github.com/freenet/freenet-core/releases/download/v{version}"
RELEASE_ASSETS = ("freenet", "fdev")
RELEASE_TRIPLE = "x86_64-unknown-linux-musl"
NODE_URL = "https://nodejs.org/dist/v{version}"

# freenet/cache is the node's XDG_CACHE_HOME: without it the node writes webapp_cache under
# ~/.cache/freenet, outside the work dir (measured 2026-09-24 by the footprint step).
WORK_SUBDIRS = ("bin", "freenet/config", "freenet/data", "freenet/log", "freenet/cache", "node",
                "tmp", "spikes", "repo")

UNIT_NAME = "freenet-node"
UNIT_PATH = f"/etc/systemd/system/{UNIT_NAME}.service"
MANAGED_MARK = "managed by scripts/infra/freenet_host.py"

# `freenet network --help` (0.2.136): "--disable-auto-update  Turn off the node's automatic
# update check." Without it the node exits 42 on a new release for a supervisor to update it,
# and this test host must stay on the pinned version.
AUTO_UPDATE_FLAG = "--disable-auto-update"

# The line that proves the node joined the ring, as the owner's 0.2.136 network-mode node logs
# it at INFO (read from its log on 2026-09-24):
#   freenet::ring::connection_manager: add_connection: successfully added to ring addr=…
PEER_LINE = r"(add_connection: successfully added to ring)"

APT_ENV = "DEBIAN_FRONTEND=noninteractive"
PACKAGES = {
    "debian": "curl tar xz-utils rsync ca-certificates",
    "fedora": "curl tar xz rsync ca-certificates",
}

# The rustc the committed contract .wasm files were built with (`rustc --version` on the
# developer machine, 2026-09-24: "rustc 1.95.0 (59807616e 2026-04-14)").
RUST_VERSION = "1.95.0"
RUSTUP_URL = "https://sh.rustup.rs"
WASM_TARGET = "wasm32-unknown-unknown"
# The host linker cargo needs for build scripts and proc macros, even for a wasm32 target
# (the first remote build failed with "linker `cc` not found", 2026-09-24).
LINKER_PACKAGES = {
    "debian": "gcc libc6-dev",
    "fedora": "gcc glibc-devel",
}

REPO_DIR = Path(__file__).resolve().parents[2]
CONTRACT_FILES = ("scripts/build-contracts.sh", "engine/backends/freenet/blake3.js",
                  "engine/backends/freenet/contracts/src/")
CONTRACT_EXCLUDES = ("target", "build")

SPIKE_DIR = REPO_DIR / "spikes" / "freenet"

# A-15, plus what is generated or local to this machine (cargo output - the spike's is 170 MB,
# the first run spent its 600 s step wait uploading it -, the renderer's vendored assets, the
# agent's settings, packed tarballs). node_modules unanchored: nested ones too.
REPO_EXCLUDES = ("/.git", "/out", "/archive", "node_modules", "/spikes/*/.node-data",
                 "/spikes/*/contracts/*/target",
                 "/engine/backends/freenet/contracts/src/*/target",
                 "/engine/backends/freenet/contracts/src/*/build",
                 "/renderer/vendor", "/.claude", "/.cache", "/todo", "/debug_main.log", "*.tgz")
REPO_REMOTE = "work/zbterm/repo"
NPM_CI_STAMP = "work/zbterm/tmp/repo-npm-ci.sha256"
SPIKE_EXCLUDES = ("node_modules", ".node-data", "out", "contracts/*/target")


def q(value: object) -> str:
    return shlex.quote(str(value))


@dataclass(init=False)
class FreenetHost(Task):
    """Provision a network-mode Freenet node and Node.js under one work directory."""

    version: str = FREENET_VERSION       # freenet/fdev release to install
    node_version: str = NODE_VERSION     # Node.js release to install
    work_dir: str = WORK_DIR             # everything on the host lives under here
    ws_port: int = WS_PORT               # the node's WebSocket API (127.0.0.1 only)
    network_port: int = NETWORK_PORT     # the node's UDP peer port

    # wait_peers retries 24 times with a delay that backs off to 60 s: longer than the default
    # 600 s step wait (the first run timed out there, 2026-09-24).
    _ptask_step_wait_s = 1800

    # —––––––––––––––––––––––––– helpers –––––––––––––––––––––––––—

    def _w(self, *parts: str) -> str:
        """An absolute path under the work directory (resolved in detect_os)."""
        return "/".join((self.work_abs,) + parts)

    def _unit_content(self) -> str:
        w = self._w
        exec_start = " ".join([
            w("bin", "freenet"), "network",
            "--config-dir", w("freenet", "config"),
            "--data-dir", w("freenet", "data"),
            "--log-dir", w("freenet", "log"),
            "--ws-api-address", "127.0.0.1",
            "--ws-api-port", str(int(self.ws_port)),
            "--network-port", str(int(self.network_port)),
            AUTO_UPDATE_FLAG,
        ])
        return (
            f"# {UNIT_PATH} — {MANAGED_MARK}\n"
            "[Unit]\n"
            "Description=Freenet node (network mode) for ZBTerm tests\n"
            "Wants=network-online.target\n"
            "After=network-online.target\n"
            "\n"
            "[Service]\n"
            "Type=simple\n"
            f"User={self.login_user}\n"
            f"WorkingDirectory={w('freenet')}\n"
            f"Environment=PATH={w('node', 'bin')}:{w('bin')}:/usr/local/bin:/usr/bin:/bin\n"
            f"Environment=XDG_CACHE_HOME={w('freenet', 'cache')}\n"
            f"ExecStart={exec_start}\n"
            "Restart=on-failure\n"
            "RestartSec=5\n"
            "\n"
            "[Install]\n"
            "WantedBy=multi-user.target\n"
        )

    def _extract_one(self, tarball: str, member: str, dest: str) -> None:
        """Extract ``member`` from ``tarball`` into ``dest``, however deep it is nested.

        Listed first: the 0.2.136 tarballs hold the bare binary at the top level with mode
        0644, but nothing promises that layout.
        """
        self.bash("tar", "-tzf", tarball, {"tar_entries": [r"^(\S+)$", 1, None]})
        hits = [e for e in self.tar_entries if e.rstrip("/").split("/")[-1] == member]
        if len(hits) != 1:
            raise RuntimeError(f"{tarball} holds {len(hits)} entries named {member}: "
                               f"{self.tar_entries}")
        depth = hits[0].count("/")
        self.bash("tar", "-xzf", tarball, "-C", dest, f"--strip-components={depth}", hits[0])
        self.bash("chmod", "0755", f"{dest}/{member}")

    # —––––––––––––––––––––––––– steps –––––––––––––––––––––––––—

    @Task.step(read_only=True)
    def detect_os(self):
        self.bash("grep '^ID=' /etc/os-release", {"os_id": r"^ID=\"?([A-Za-z0-9._-]+)\"?\s*$"})
        if self.os_id not in PACKAGES:
            raise RuntimeError(f"this recipe drives apt or dnf; the host reports ID={self.os_id}")
        self.bash("printenv HOME", {"home_dir": r"^(/\S*)$"})
        self.bash("id -un", {"login_user": r"^(\S+)$"})
        work = str(self.work_dir)
        if work == "~" or work.startswith("~/"):
            work = self.home_dir + work[1:]
        if not work.startswith("/"):
            raise RuntimeError(f"work_dir must be absolute or start with ~/: {self.work_dir}")
        self.work_abs = work.rstrip("/")
        return {"os": self.os_id, "user": self.login_user, "work_dir": self.work_abs}

    @Task.step
    def base_packages(self):
        wanted = PACKAGES[self.os_id].split()
        if self.os_id == "debian":
            self.bash("dpkg-query -W -f='${Status}\\n' " + " ".join(wanted),
                      {"pkg_ok": [r"^(install ok installed)$"]}, raise_on_error=False)
        else:
            self.bash("rpm -q " + " ".join(wanted), {"pkg_ok": [r"^(\S+\.\S+)$"]},
                      raise_on_error=False)
        if len(self.pkg_ok or []) == len(wanted):
            return {"packages": wanted, "kept": True}
        if self.os_id == "debian":
            # A flaky mirror should not abort a run whose packages may be cached; the install
            # below is the gate.
            self.sudo(f"{APT_ENV} apt-get update -qq", raise_on_error=logging.WARNING,
                      timeout=600)
            self.sudo(f"{APT_ENV} apt-get install -y -qq {PACKAGES['debian']}", timeout=1200)
        else:
            self.sudo(f"dnf install -y {PACKAGES['fedora']}", timeout=1200)
        return {"packages": wanted, "kept": False}

    @Task.step
    def make_dirs(self):
        self.bash("mkdir", "-p", *(self._w(d) for d in WORK_SUBDIRS))
        return list(WORK_SUBDIRS)

    @Task.step
    def fetch_release(self):
        """freenet + fdev from the GitHub release, checked against its SHA256SUMS.txt."""
        freenet = self._w("bin", "freenet")
        have = self.bash(freenet, "--version", {"freenet_version": r"version: (\S+)"},
                         raise_on_error=False)
        if have.ok and self.freenet_version == self.version:
            return {"freenet": self.freenet_version, "kept": True}

        base = RELEASE_URL.format(version=self.version)
        sums = self._w("tmp", f"freenet-{self.version}-SHA256SUMS.txt")
        self.bash("curl", "-fsSL", "-o", sums, f"{base}/SHA256SUMS.txt", timeout=300)
        tarballs = {}
        for name in RELEASE_ASSETS:
            asset = f"{name}-{RELEASE_TRIPLE}.tar.gz"
            tarballs[name] = self._w("tmp", asset)
            self.bash("curl", "-fsSL", "-o", tarballs[name], f"{base}/{asset}", timeout=900)
        # sha256sum -c resolves names against the cwd; prefixing the directory keeps it one
        # command. --ignore-missing skips the other platforms' assets in the list.
        tmp = self._w("tmp")
        self.bash(f"sed 's#  #  {tmp}/#' {q(sums)} | sha256sum -c --ignore-missing -",
                  {"sums_ok": [r"^(\S+): OK$", len(RELEASE_ASSETS)]},
                  raise_on_error="release tarball checksum mismatch")
        for name in RELEASE_ASSETS:
            self._extract_one(tarballs[name], name, self._w("bin"))

        self.bash(freenet, "--version", {"freenet_version": r"version: (\S+)"},
                  raise_on_error="bin/freenet --version failed")
        if self.freenet_version != self.version:
            raise RuntimeError(f"bin/freenet reports {self.freenet_version}, "
                               f"expected {self.version}")
        self.bash(self._w("bin", "fdev"), "--version", {"fdev_version": r"(\d+\.\d+\.\d+)"},
                  raise_on_error=logging.WARNING)
        return {"freenet": self.freenet_version, "fdev": self.fdev_version, "kept": False,
                "verified": self.sums_ok}

    @Task.step
    def install_node(self):
        """Node.js from nodejs.org/dist, checked against its SHASUMS256.txt."""
        node = self._w("node", "bin", "node")
        have = self.bash(node, "--version", {"node_have": r"^v(\S+)$"}, raise_on_error=False)
        if have.ok and self.node_have == self.node_version:
            return {"node": self.node_have, "kept": True}

        base = NODE_URL.format(version=self.node_version)
        asset = f"node-v{self.node_version}-linux-x64.tar.xz"
        sums = self._w("tmp", f"node-v{self.node_version}-SHASUMS256.txt")
        tarball = self._w("tmp", asset)
        self.bash("curl", "-fsSL", "-o", sums, f"{base}/SHASUMS256.txt", timeout=300)
        self.bash("curl", "-fsSL", "-o", tarball, f"{base}/{asset}", timeout=900)
        tmp = self._w("tmp")
        self.bash(f"grep -F '  {asset}' {q(sums)} | sed 's#  #  {tmp}/#' | sha256sum -c -",
                  {"node_sum_ok": [r"^(\S+): OK$", 1]},
                  raise_on_error="Node.js tarball checksum mismatch")
        # The tarball nests everything under node-v<ver>-linux-x64/.
        self.bash("tar", "-xJf", tarball, "-C", self._w("node"), "--strip-components=1")
        self.bash(node, "--version", {"node_have": r"^v(\S+)$"},
                  raise_on_error="node/bin/node --version failed")
        if self.node_have != self.node_version:
            raise RuntimeError(f"node reports {self.node_have}, expected {self.node_version}")
        # npm is a `#!/usr/bin/env node` script: it needs this node on PATH.
        self.bash(f"PATH={q(self._w('node', 'bin'))}:$PATH npm --version",
                  {"npm_have": r"^(\S+)$"}, raise_on_error=logging.WARNING)
        return {"node": self.node_have, "npm": self.npm_have, "kept": False}

    @Task.step
    def write_unit(self):
        # The flag's name is read off the installed binary, so a release that renames it fails
        # here and not as a unit that refuses to start.
        self.bash(f"{q(self._w('bin', 'freenet'))} network --help | grep -o -- "
                  f"{q(AUTO_UPDATE_FLAG)} | head -1",
                  {"auto_update_flag": r"^(--\S+)$"})
        if self.auto_update_flag != AUTO_UPDATE_FLAG:
            raise RuntimeError(f"freenet {self.version} has no {AUTO_UPDATE_FLAG}")

        content = self._unit_content()
        want = hashlib.sha256(content.encode()).hexdigest()
        current = self.bash("sha256sum", UNIT_PATH, {"unit_digest": r"^([0-9a-f]{64})\s"},
                            raise_on_error=False)
        self.unit_changed = not (current.ok and self.unit_digest == want)
        if not self.unit_changed:
            return {"unit": UNIT_PATH, "changed": False, "sha256": want}
        self.bash(f"printf '%s' {q(content)} | sudo tee {q(UNIT_PATH)} >/dev/null")
        self.bash("sha256sum", UNIT_PATH, {"unit_digest": r"^([0-9a-f]{64})\s"})
        if self.unit_digest != want:
            raise RuntimeError(f"{UNIT_PATH} does not hold what was written")
        return {"unit": UNIT_PATH, "changed": True, "sha256": want,
                "auto_update_flag": self.auto_update_flag}

    @Task.step
    def enable_start(self):
        self.bash(f"systemctl is-enabled {UNIT_NAME}",
                  {"unit_enabled": {"enabled": r"^enabled$", "other": DEFAULT}},
                  raise_on_error=False)
        self.bash(f"systemctl is-active {UNIT_NAME}",
                  {"unit_state": {"active": r"^active$", "other": DEFAULT}},
                  raise_on_error=False)
        if self.unit_enabled == "enabled" and self.unit_state == "active" \
                and not self.unit_changed:
            return {"state": self.unit_state, "kept": True}
        was_active = self.unit_state == "active"
        self.sudo("systemctl daemon-reload")
        self.sudo(f"systemctl enable --now {UNIT_NAME}")
        if was_active and self.unit_changed:
            # enable --now leaves a running unit alone; a rewritten one must be restarted.
            self.sudo(f"systemctl restart {UNIT_NAME}")
        self.bash(f"systemctl is-active {UNIT_NAME}",
                  {"unit_state": {"active": r"^active$", "other": DEFAULT}},
                  raise_on_error=False)
        return {"state": self.unit_state, "kept": False}

    @Task.step(read_only=True, retries=12, retry_delay=5)
    def wait_ws(self):
        port = int(self.ws_port)
        self.bash("ss -ltnH",
                  {"ws_listeners": [rf"^LISTEN\s+\d+\s+\d+\s+(\S+:{port})\s", 1, None]},
                  raise_on_error="ss failed")
        return self.ws_listeners

    @Task.step(read_only=True, retries=24, retry_delay=5)
    def wait_peers(self):
        # Not the journal: with --log-dir the node writes its tracing log only to hourly files
        # there, and the journal carries nothing but rate-limit notices (measured 2026-09-24,
        # the first run matched `journalctl -u freenet-node` for 24 tries and never fired).
        logs = self._w("freenet", "log")
        self.bash(f"find {q(logs)} -name '*.log' -mmin -10 -exec grep -h -o "
                  f"{q(PEER_LINE.strip('()'))} {{}} +",
                  {"peer_lines": [PEER_LINE, 1, None]},
                  raise_on_error=False)
        if not self.peer_lines:
            raise RuntimeError(f"no ring connection logged under {logs} in the last 10 min")
        return {"ring_connections_logged": len(self.peer_lines)}

    @Task.step(read_only=True)
    def firewall_facts(self):
        """Record the host's nft input policies. A cloud firewall outside the VM is invisible."""
        self.sudo("nft list ruleset",
                  {"input_policies": [r"hook input priority \S+; policy (\w+);"]},
                  raise_on_error=logging.WARNING)
        policies = self.input_policies or []
        if "drop" in policies:
            logging.warning("nft has a drop policy on input: UDP %s must be allowed explicitly",
                            self.network_port)
        return {"input_policies": policies, "drop_on_input": "drop" in policies}

    @Task.step(read_only=True)
    def footprint(self):
        """List what changed in the login's home outside work_dir since the first download.

        Everything this recipe (and ``--task sync``) writes belongs under work_dir; an entry
        here is something a tool wrote on its own (a cache, a state dir) and is reported, not
        removed.
        """
        marker = self._w("tmp", f"freenet-{self.version}-SHA256SUMS.txt")
        self.bash(f"find {q(self.home_dir)} -mindepth 1 -maxdepth 3 -newer {q(marker)} "
                  f"-not -path {q(self.work_abs)} -not -path {q(self.work_abs + '/*')} "
                  f"-not -path {q(self.home_dir + '/work')}",
                  {"home_changes": [r"^(/.+)$"]}, raise_on_error=False)
        changes = self.home_changes or []
        if changes:
            logging.warning("outside %s: %s", self.work_abs, changes)
        return {"outside_work_dir": changes}


@dataclass(init=False)
class RustToolchain(Task):
    """rustup + a pinned rustc with the wasm32 target, all under work_dir/rust."""

    work_dir: str = WORK_DIR             # everything on the host lives under here
    rust_version: str = RUST_VERSION     # the toolchain the committed contracts were built with

    def _w(self, *parts: str) -> str:
        return "/".join((self.work_abs,) + parts)

    def _env(self) -> str:
        """The environment prefix every rustup/cargo command runs with (one command each)."""
        return (f"CARGO_HOME={q(self._w('rust', 'cargo'))} "
                f"RUSTUP_HOME={q(self._w('rust', 'rustup'))} "
                f"PATH={q(self._w('rust', 'cargo', 'bin'))}:$PATH")

    @Task.step(read_only=True)
    def locate(self):
        self.bash("printenv HOME", {"home_dir": r"^(/\S*)$"})
        work = str(self.work_dir)
        if work == "~" or work.startswith("~/"):
            work = self.home_dir + work[1:]
        if not work.startswith("/"):
            raise RuntimeError(f"work_dir must be absolute or start with ~/: {self.work_dir}")
        self.work_abs = work.rstrip("/")
        # FreenetHost installed fdev; the contract build needs it.
        self.bash(self._w("bin", "fdev"), "--version", {"fdev_version": r"(\d+\.\d+\.\d+)"},
                  raise_on_error="no bin/fdev under work_dir: run the host task first")
        self.bash("grep '^ID=' /etc/os-release", {"os_id": r"^ID=\"?([A-Za-z0-9._-]+)\"?\s*$"})
        if self.os_id not in LINKER_PACKAGES:
            raise RuntimeError(f"this recipe drives apt or dnf; the host reports ID={self.os_id}")
        return {"work_dir": self.work_abs, "fdev": self.fdev_version, "os": self.os_id}

    @Task.step
    def make_dirs(self):
        self.bash("mkdir", "-p", self._w("rust", "cargo"), self._w("rust", "rustup"),
                  self._w("tmp"))
        return ["rust/cargo", "rust/rustup", "tmp"]

    @Task.step
    def linker(self):
        wanted = LINKER_PACKAGES[self.os_id].split()
        if self.os_id == "debian":
            self.bash("dpkg-query -W -f='${Status}\\n' " + " ".join(wanted),
                      {"pkg_ok": [r"^(install ok installed)$"]}, raise_on_error=False)
        else:
            self.bash("rpm -q " + " ".join(wanted), {"pkg_ok": [r"^(\S+\.\S+)$"]},
                      raise_on_error=False)
        if len(self.pkg_ok or []) == len(wanted):
            return {"packages": wanted, "kept": True}
        if self.os_id == "debian":
            self.sudo(f"{APT_ENV} apt-get install -y -qq {LINKER_PACKAGES['debian']}",
                      timeout=1200)
        else:
            self.sudo(f"dnf install -y {LINKER_PACKAGES['fedora']}", timeout=1200)
        return {"packages": wanted, "kept": False}

    @Task.step
    def install_rustup(self):
        """The official rustup-init script, the toolchain pinned, no profile edits."""
        have = self.bash(f"{self._env()} rustc +{q(self.rust_version)} --version",
                         {"rustc_have": r"^rustc (\S+)"}, raise_on_error=False)
        if have.ok and self.rustc_have == self.rust_version:
            return {"rustc": self.rustc_have, "kept": True}
        script = self._w("tmp", "rustup-init.sh")
        self.bash("curl", "--proto", "=https", "--tlsv1.2", "-sSf", "-o", script, RUSTUP_URL,
                  timeout=300)
        self.bash(f"{self._env()} sh {q(script)} -y --no-modify-path --profile minimal "
                  f"--default-toolchain {q(self.rust_version)}", timeout=1800)
        self.bash(f"{self._env()} rustc +{q(self.rust_version)} --version",
                  {"rustc_have": r"^rustc (\S+)"}, raise_on_error="rustc not installed")
        if self.rustc_have != self.rust_version:
            raise RuntimeError(f"rustc reports {self.rustc_have}, expected {self.rust_version}")
        return {"rustc": self.rustc_have, "kept": False}

    @Task.step
    def wasm_target(self):
        self.bash(f"{self._env()} rustup target list --installed "
                  f"--toolchain {q(self.rust_version)}", {"targets": [r"^(\S+)$"]})
        if WASM_TARGET in (self.targets or []):
            return {"target": WASM_TARGET, "kept": True}
        self.bash(f"{self._env()} rustup target add {WASM_TARGET} "
                  f"--toolchain {q(self.rust_version)}", timeout=900)
        return {"target": WASM_TARGET, "kept": False}

    @Task.step
    def pin_default(self):
        """The pinned toolchain is the default, so a bare `cargo` in the build uses it."""
        self.bash(f"{self._env()} rustc --version", {"rustc_default": r"^rustc (\S+)"},
                  raise_on_error=False)
        if self.rustc_default == self.rust_version:
            return {"default": self.rustc_default, "kept": True}
        self.bash(f"{self._env()} rustup default {q(self.rust_version)}")
        return {"default": self.rust_version, "kept": False}

    @Task.step(read_only=True)
    def facts(self):
        self.bash(f"{self._env()} rustc --version", {"rustc_full": r"^(rustc .+)$"})
        self.bash(f"{self._env()} cargo --version", {"cargo_full": r"^(cargo .+)$"})
        # rustup's defaults, which this task must not have created.
        self.bash(f"ls -d {q(self.home_dir + '/.cargo')} {q(self.home_dir + '/.rustup')}",
                  {"strays": [r"^(/.+)$"]}, raise_on_error=False)
        if self.strays:
            logging.warning("rustup defaults present outside work_dir: %s", self.strays)
        return {"rustc": self.rustc_full, "cargo": self.cargo_full,
                "outside_work_dir": self.strays or []}


@dataclass(init=False)
class SyncContracts(Task):
    """Push the contract crates and their build script to the host (runs locally)."""

    target: str = ""                     # ssh alias of the provisioned host

    def validate(self):
        if not self.target:
            raise ValueError("SyncContracts needs a target ssh alias")

    @Task.step
    def rsync(self):
        excludes = [arg for pattern in CONTRACT_EXCLUDES for arg in ("--exclude", pattern)]
        # -R keeps the repo-relative paths; the ./ marks where they start.
        sources = [f"{REPO_DIR}/./{path}" for path in CONTRACT_FILES]
        self.bash("rsync", "-aR", "--delete", *excludes, *sources,
                  f"{self.target}:work/zbterm/contracts/", timeout=600)
        return {"from": list(CONTRACT_FILES), "excluded": list(CONTRACT_EXCLUDES)}


@dataclass(init=False)
class SyncProbes(Task):
    """Push the repo's spikes/freenet/ to the provisioned host and npm ci it there (runs locally)."""

    target: str = ""                     # ssh alias of the provisioned host

    def validate(self):
        if not self.target:
            raise ValueError("SyncProbes needs a target ssh alias")

    @Task.step
    def rsync(self):
        excludes = [arg for pattern in SPIKE_EXCLUDES for arg in ("--exclude", pattern)]
        # A path relative to the remote home: rsync hands a leading ~ to no shell.
        self.bash("rsync", "-a", *excludes, f"{SPIKE_DIR}/",
                  f"{self.target}:work/zbterm/spikes/freenet/", timeout=600)
        return {"from": str(SPIKE_DIR), "excluded": list(SPIKE_EXCLUDES)}

    @Task.step
    def npm_ci(self):
        # --cache keeps npm's cache (and its logs) under the work dir, not in ~/.npm.
        remote = ("cd ~/work/zbterm/spikes/freenet && "
                  "PATH=~/work/zbterm/node/bin:$PATH npm ci --no-audit --no-fund "
                  "--cache ~/work/zbterm/tmp/npm-cache")
        self.bash("ssh", self.target, remote, timeout=1200)
        return "npm ci ok"


@dataclass(init=False)
class SyncRepo(Task):
    """Push this working tree to the provisioned host and npm ci it there (runs locally)."""

    target: str = ""                     # ssh alias of the provisioned host

    # npm ci of the whole tree can outlast the default 600 s step wait.
    _ptask_step_wait_s = 1800

    def validate(self):
        if not self.target:
            raise ValueError("SyncRepo needs a target ssh alias")

    @Task.step
    def rsync(self):
        excludes = [arg for pattern in REPO_EXCLUDES for arg in ("--exclude", pattern)]
        # --delete-excluded mirrors the tree and removes anything excluded that an earlier run
        # left there; the remote's own node_modules (npm ci's) is protected from it.
        # A path relative to the remote home: rsync hands a leading ~ to no shell.
        self.bash("rsync", "-a", "--delete", "--delete-excluded", "--filter", "P node_modules",
                  "--itemize-changes", *excludes, f"{REPO_DIR}/",
                  f"{self.target}:{REPO_REMOTE}/",
                  {"repo_changes": [r"^([<>ch*.][fdLDS]\S* .+)$"]}, timeout=1200)
        changes = self.repo_changes or []
        return {"from": str(REPO_DIR), "to": f"~/{REPO_REMOTE}", "changed": len(changes),
                "kept": not changes}

    @Task.step
    def npm_ci(self):
        self.bash("sha256sum", str(REPO_DIR / "package-lock.json"),
                  {"lock_sha": r"^([0-9a-f]{64})\s"})
        # The stamp the last successful npm ci left; absent on the first run.
        self.bash("ssh", self.target, f"cat {NPM_CI_STAMP}", {"stamp_sha": [r"^([0-9a-f]{64})$"]},
                  raise_on_error=False)
        if (self.stamp_sha or [None])[0] == self.lock_sha:
            return {"lock": self.lock_sha, "kept": True}
        # --cache keeps npm's cache (and its logs) under the work dir, not in ~/.npm.
        remote = ("ELECTRON_SKIP_BINARY_DOWNLOAD=1 PATH=~/work/zbterm/node/bin:$PATH "
                  f"npm ci --prefix ~/{REPO_REMOTE} --no-audit --no-fund "
                  "--cache ~/work/zbterm/tmp/npm-cache")
        self.bash("ssh", self.target, remote, timeout=1800)
        self.bash("ssh", self.target, f"printf '%s\\n' {self.lock_sha} > {NPM_CI_STAMP}")
        return {"lock": self.lock_sha, "kept": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        prog="scripts/infra/freenet_host.py",
        description="Provision a network-mode Freenet node + Node.js on HOST (--task host), "
                    "sync spikes/freenet to it (--task sync), install Rust for the contracts "
                    "(--task rust), push the contract crates (--task contracts) or push this "
                    "tree and npm ci it (--task repo).",
        epilog="The host is required and never defaulted: a machine name does not belong in "
               "a fabricfile.")
    parser.add_argument("host", help="target machine — an ssh alias or envs.core Host id")
    parser.add_argument("--task", choices=("host", "sync", "rust", "contracts", "repo"),
                        default="host")
    parser.add_argument("--rust-version", default=RUST_VERSION, help="pinned rustc (--task rust)")
    parser.add_argument("--version", default=FREENET_VERSION, help="freenet/fdev release")
    parser.add_argument("--node-version", default=NODE_VERSION, help="Node.js release")
    parser.add_argument("--work-dir", default=WORK_DIR, help="everything lives under here")
    parser.add_argument("--ws-port", type=int, default=WS_PORT, help="WebSocket API port")
    parser.add_argument("--network-port", type=int, default=NETWORK_PORT, help="UDP peer port")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if args.task == "sync":
        task = SyncProbes(host="local", state_file=f"SyncProbes-{args.host}.json")
        task.target = args.host
    elif args.task == "repo":
        task = SyncRepo(host="local", state_file=f"SyncRepo-{args.host}.json")
        task.target = args.host
    elif args.task == "contracts":
        task = SyncContracts(host="local", state_file=f"SyncContracts-{args.host}.json")
        task.target = args.host
    elif args.task == "rust":
        task = RustToolchain(host=args.host, state_file=f"RustToolchain-{args.host}.json")
        task.work_dir = args.work_dir
        task.rust_version = args.rust_version
    else:
        task = FreenetHost(host=args.host, state_file=f"FreenetHost-{args.host}.json")
        task.version = args.version
        task.node_version = args.node_version
        task.work_dir = args.work_dir
        task.ws_port = args.ws_port
        task.network_port = args.network_port
    task.run_task_steps()
