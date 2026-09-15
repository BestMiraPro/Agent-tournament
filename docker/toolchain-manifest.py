"""Records what the agent image actually contains, at build time.

Usage: toolchain-manifest.py <toolchain-id> <requirements.in> <requirements.lock> <out.json>

Every entry comes from a real check — an executable's own version output, an import, the
installed distribution's metadata — so the inventory cannot drift from the image. A package
whose installed version differs from its pin, or an approved package that fails to import,
fails the build instead of producing an inventory that lies.
"""
import importlib
import importlib.metadata as metadata
import json
import platform
import re
import shutil
import subprocess
import sys

def fail(message):
    print(f"toolchain-manifest: {message}", file=sys.stderr)
    sys.exit(1)


def version_of(command):
    out = subprocess.run(command, capture_output=True, text=True, check=True).stdout.strip()
    match = re.search(r"\d+(?:\.\d+)+", out)
    if not match:
        fail(f"cannot read a version from {' '.join(command)}: {out!r}")
    return match.group(0)


def executable(name):
    path = shutil.which(name)
    if not path:
        fail(f"{name} is not on PATH")
    return path


def names(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip() and not line.strip().startswith("#")]


def pins(path):
    found = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            match = re.match(r"^([A-Za-z0-9_.\-]+)==([^\s\\;]+)", line)
            if match:
                found[match.group(1).lower()] = match.group(2)
    return found


def main():
    if len(sys.argv) != 5:
        fail(__doc__.strip().splitlines()[2])
    toolchain_id, requirements_in, lock, out = sys.argv[1:]
    if not re.fullmatch(r"[0-9a-f]{16}", toolchain_id):
        fail(f"toolchain id must be 16 hex characters, got {toolchain_id!r}")

    locked = pins(lock)
    packages = []
    for name, pinned in sorted(locked.items()):
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            fail(f"{name}=={pinned} is locked but not installed")
        if installed != pinned:
            fail(f"{name} is installed at {installed}, but the lock pins {pinned}")
        packages.append({"name": name, "version": installed})

    # Every approved package here imports under its distribution name.
    for name in names(requirements_in):
        importlib.import_module(name)

    python = sys.executable
    inventory = {
        "schemaVersion": 1,
        "toolchainId": toolchain_id,
        "python": {"version": platform.python_version(), "venv": sys.prefix, "executable": python},
        "tools": [
            {"name": "python3", "version": platform.python_version(), "executable": python},
            {"name": "node", "version": version_of(["node", "--version"]), "executable": executable("node")},
            {"name": "git", "version": version_of(["git", "--version"]), "executable": executable("git")},
            {"name": "opencode", "version": version_of(["opencode", "--version"]), "executable": executable("opencode")},
            {"name": "rg", "version": version_of(["rg", "--version"]), "executable": executable("rg")},
            {"name": "pytest", "version": metadata.version("pytest"), "executable": executable("pytest")},
        ],
        "pythonPackages": packages,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
