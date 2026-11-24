#!/usr/bin/env python3
"""Deploy the no-Apify Turnstile kit to an InstaBox VM.

There is exactly ONE installer: `turnstile/install.sh` in this repo. This script
does not duplicate it. It uploads the extension config (which carries your
InstaBox key, so it cannot live in git), uploads the thin bootstrap that gets
the checkout onto the box, and then runs the checkout's own installer.

Earlier versions uploaded the extension, the solver source, compiles and a
second setup script from here. That duplicated install.sh line for line, and the
two copies drifted: this path wrote config with its own heredoc, so a `vnc`
plugin the operator had enabled was silently deleted by a re-deploy, and
`interactive.mode` reset from "desktop" to "off".

Usage:
  python turnstile/deploy_instabox.py
  python turnstile/deploy_instabox.py --upload-only   # upload, do not install
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE = "/data/workspace"


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upload-only", action="store_true",
                        help="Upload the config and bootstrap; do not install")
    args = parser.parse_args()

    load_env()
    key = require("INSTABOX_API_KEY")
    machine = require("INSTABOX_MACHINE_ID")
    api = os.environ.get("INSTABOX_API_URL", "https://api.instabox.sh/v1").rstrip("/")

    print(f"Target VM: {machine}")
    print("Uploading extension config + bootstrap ...")

    # The extension reads this from beside its own files. Written here rather
    # than committed because it carries the InstaBox key.
    config = {
        "instaboxApiKey": key,
        "instaboxMachineId": machine,
        "instaboxApiUrl": api,
        "camofoxUrl": "http://127.0.0.1:9377",
        "solverPath": f"{REMOTE}/camofox_solve_rust",
        "solverPython": "",
        "timeoutMs": int(os.environ.get("TIMEOUT_MS") or 45000),
        "autoSolve": True,
    }
    upload_bytes(machine, key, api, json.dumps(config).encode(), f"{REMOTE}/ext-config.json")
    exec_cmd(machine, key, api, f"chmod 600 {REMOTE}/ext-config.json")

    bootstrap = ROOT / "turnstile" / "vm_setup_camofox.sh"
    if not bootstrap.exists():
        raise SystemExit(f"{bootstrap} is missing from the checkout")
    upload_bytes(machine, key, api, bootstrap.read_bytes(), f"{REMOTE}/vm_setup_camofox.sh")
    safe_print("Bootstrap: vm_setup_camofox.sh")

    if args.upload_only:
        print("Uploaded. Install with:")
        print(f"  bash {REMOTE}/vm_setup_camofox.sh")
        return

    print("Cloning the fork and running its installer (this takes a few minutes) ...")
    exec_cmd(
        machine, key, api,
        f"chmod +x {REMOTE}/vm_setup_camofox.sh && "
        f"rm -f {REMOTE}/camofox-setup.log && "
        f"INSTABOX_API_KEY={key} INSTABOX_MACHINE_ID={machine} INSTABOX_API_URL={api} "
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
        if "RESULT: ready" in out:
            break
        if "HEALTH FAILED" in out or "ERROR:" in out:
            break
        if "SETUP_DONE" in out and "STILL_RUNNING" not in out:
            break
        print("  ... still working")

    safe_print(out[-6000:] if out else "(no setup output)")
    if "RESULT: ready" not in out:
        raise SystemExit("install did not finish in a ready state; see the log above")
    print("Deploy OK.")


if __name__ == "__main__":
    main()
