#!/usr/bin/env python3
"""Deploy the no-Apify Turnstile kit to the InstaBox VM.

Reads keys from ../.env (never prints them). Uploads the extension, the
camofox-browser based solver, and the setup script, then runs the setup which
stops the old camoufox-server.py stack and starts our camofox-browser server.

Usage:
  python scripts/deploy_instabox.py
  python scripts/deploy_instabox.py --skip-server   # only upload files
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE = "/data/workspace"
PY = f"{REMOTE}/camoufox-venv/bin/python"


def safe_print(text: str) -> None:
    """Print without ever emitting non-ASCII to a cp1252 Windows console."""
    print(text.encode("ascii", "replace").decode("ascii"))


def load_env() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        raise SystemExit("Missing .env - copy .env.example to .env and fill in keys")
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if value and not os.environ.get(key.strip()):
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing {name} in .env")
    return value


def exec_cmd(machine: str, key: str, api: str, cmd: str, timeout: int = 180) -> dict:
    body = json.dumps({"cmd": cmd, "timeoutSeconds": timeout}).encode()
    req = urllib.request.Request(
        f"{api}/machines/{machine}/exec",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout + 60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"InstaBox HTTP {exc.code}: {detail}") from None


def upload_bytes(machine: str, key: str, api: str, data: bytes, path: str) -> None:
    encoded = base64.b64encode(data).decode("ascii")
    result = exec_cmd(machine, key, api, f"echo {encoded} | base64 -d > {path}")
    if result.get("exitCode") not in (0, None):
        raise RuntimeError(f"Upload failed for {path}: {result.get('stderr', '')[:300]}")


def upload_dir(machine: str, key: str, api: str, src: Path, path: str) -> None:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for item in sorted(src.iterdir()):
            if item.is_file():
                tar.add(item, arcname=item.name)
    upload_bytes(machine, key, api, buf.getvalue(), "/tmp/turnstile-ext.tar.gz")
    exec_cmd(machine, key, api, f"rm -rf {path} && mkdir -p {path}")
    result = exec_cmd(
        machine, key, api,
        f"tar -xzf /tmp/turnstile-ext.tar.gz -C {path} && ls {path}",
    )
    if result.get("exitCode") not in (0, None):
        raise RuntimeError(f"Extract failed for {path}: {result.get('stderr', '')[:300]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-server", action="store_true",
                        help="Upload files only; do not restart camofox-browser")
    args = parser.parse_args()

    load_env()
    key = require("INSTABOX_API_KEY")
    machine = require("INSTABOX_MACHINE_ID")
    api = os.environ.get("INSTABOX_API_URL", "https://api.instabox.sh/v1").rstrip("/")

    print(f"Target VM: {machine}")
    print("Uploading extension + solver ...")

    upload_dir(machine, key, api, ROOT / "extension", f"{REMOTE}/turnstile-ext")
    upload_bytes(
        machine, key, api,
        (ROOT / "solver" / "camofox_solve.py").read_bytes(),
        f"{REMOTE}/camofox_solve.py",
    )
    upload_bytes(
        machine, key, api,
        (ROOT / "scripts" / "vm_setup_camofox.sh").read_bytes(),
        f"{REMOTE}/vm_setup_camofox.sh",
    )
    upload_bytes(
        machine, key, api,
        (ROOT / "scripts" / "vm_ext_test.py").read_bytes(),
        f"{REMOTE}/vm_ext_test.py",
    )
    # Optional Rust solver (camofox-rust clone). Uploaded + compiled on the VM
    # so operators can switch solverPath to /data/workspace/camofox_solve_rust.
    rust_src = ROOT / "camofox-rust" / "solver" / "camofox_solve.rs"
    if rust_src.exists():
        upload_bytes(machine, key, api, rust_src.read_bytes(), f"{REMOTE}/camofox_solve.rs")
        result = exec_cmd(machine, key, api,
                          f"cd {REMOTE} && rustc --edition 2021 -O camofox_solve.rs -o camofox_solve_rust 2>&1 | tail -3",
                          timeout=180)
        safe_print("Rust solver: " + (result.get("stdout") or "").strip()[:200])

    config = {
        "instaboxApiKey": key,
        "instaboxMachineId": machine,
        "instaboxApiUrl": api,
        "camofoxUrl": "http://127.0.0.1:9377",
        "solverPath": f"{REMOTE}/camofox_solve.py",
        "solverPython": PY,
        "timeoutMs": int(os.environ.get("TIMEOUT_MS") or 45000),
        "autoSolve": True,
    }
    upload_bytes(
        machine, key, api,
        json.dumps(config).encode(),
        f"{REMOTE}/ext-config.json",
    )
    print("Files uploaded.")

    if args.skip_server:
        return

    print("Replacing old Camoufox stack with camofox-browser (this takes a few minutes) ...")
    exec_cmd(
        machine, key, api,
        f"chmod +x {REMOTE}/vm_setup_camofox.sh && "
        f"nohup bash {REMOTE}/vm_setup_camofox.sh > {REMOTE}/camofox-setup.log 2>&1 & echo started",
        timeout=30,
    )

    out = ""
    for _ in range(90):  # up to ~12 minutes
        time.sleep(8)
        result = exec_cmd(
            machine, key, api,
            f"tail -c 8000 {REMOTE}/camofox-setup.log 2>/dev/null; "
            f"pgrep -f vm_setup_camofox.sh >/dev/null && echo STILL_RUNNING || echo SETUP_DONE",
            timeout=30,
        )
        out = (result.get("stdout") or "").strip()
        if "HEALTH OK" in out:
            break
        if "HEALTH FAILED" in out:
            break
        if "SETUP_DONE" in out and "STILL_RUNNING" not in out:
            break
        print("  ... still working")

    safe_print(out[-6000:] if out else "(no setup output)")
    if "HEALTH OK" not in out:
        raise SystemExit("camofox-browser health check did not pass")
    print("Deploy OK.")


if __name__ == "__main__":
    main()
