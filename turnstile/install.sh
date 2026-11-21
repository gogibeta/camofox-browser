#!/bin/bash
# One-shot installer for the camofox-browser Turnstile kit.
#
# Installs the server, the solver (Python + optional Rust), the browser
# extension, and starts a headed browser on DISPLAY=:1 bound to 127.0.0.1:9377.
#
# Usage:
#   bash turnstile/install.sh              # full install + start
#   bash turnstile/install.sh --no-start   # install only
#
# Idempotent: safe to re-run after a git pull.
set -euo pipefail

WS="${WS:-/data/workspace}"
REPO="${REPO:-$WS/camofox-browser}"
DISPLAY_NUM="${DISPLAY_NUM:-:1}"
PORT="${CAMOFOX_PORT:-9377}"
NO_START=0
for arg in "$@"; do
  [ "$arg" = "--no-start" ] && NO_START=1
done

export DISPLAY="$DISPLAY_NUM"

echo "==> [1/8] checking prerequisites"
for bin in node npm git curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required binary: $bin" >&2; exit 1; }
done
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "node >= 18 required (found $(node -v))" >&2
  exit 1
fi

echo "==> [2/8] IPv4 fallback for Cloudflare's challenge host"
if ! grep -q 'challenges.cloudflare.com' /etc/hosts 2>/dev/null; then
  sudo -n sh -c "echo '104.18.94.41 challenges.cloudflare.com' >> /etc/hosts" 2>/dev/null || true
fi

echo "==> [3/8] locating the Camoufox binary"
BIN="${CAMOUFOX_EXECUTABLE:-/data/home/.cache/camoufox/camoufox-bin}"
if [ ! -x "$BIN" ]; then
  BIN=$(find /data/home/.cache/camoufox /root/.cache/camoufox -name camoufox-bin -type f 2>/dev/null | head -1)
fi
if [ -z "${BIN:-}" ] || [ ! -x "$BIN" ]; then
  echo "camoufox binary not found; run 'python -m camoufox fetch' first" >&2
  exit 1
fi
echo "    using: $BIN"

echo "==> [4/8] installing node dependencies"
cd "$REPO"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -5
else
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
fi

echo "==> [5/8] writing camofox config + plugins"
cat > "$REPO/camofox.config.json" <<'JSON'
{
  "id": "camofox-browser",
  "name": "Camofox Browser (Turnstile Kit)",
  "version": "1.6.0",
  "newPageTimeoutMs": 20000,
  "interactive": { "mode": "desktop" },
  "plugins": {
    "youtube": { "enabled": true },
    "persistence": { "enabled": true },
    "ipv4fix": { "enabled": true }
  }
}
JSON
mkdir -p "$REPO/plugins/ipv4fix"
if [ -f "$REPO/turnstile/plugins/ipv4fix.js" ]; then
  cp "$REPO/turnstile/plugins/ipv4fix.js" "$REPO/plugins/ipv4fix/index.js"
fi

echo "==> [6/8] installing the extension and building the Rust solver"
# One engine only: the Rust binary. No interpreter to keep in sync, ~1s faster.
# The Python solver stays in the repo for reference but is not installed.
mkdir -p "$WS/turnstile-ext"
cp -f "$REPO"/extension/* "$WS/turnstile-ext/" 2>/dev/null || true

if ! command -v rustc >/dev/null 2>&1; then
  echo "rustc is required to build the solver and was not found." >&2
  echo "Install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  exit 1
fi
echo "    compiling camofox_solve.rs"
if ! rustc --edition 2021 -O "$REPO/solver/camofox_solve.rs" -o "$WS/camofox_solve_rust"; then
  echo "the Rust solver failed to compile; refusing to start a browser that cannot solve." >&2
  exit 1
fi
chmod +x "$WS/camofox_solve_rust"
rm -f "$WS/camofox_solve.py" "$WS/instabox_solver.py"

echo "==> [7/8] stopping any previous server"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "camoufox-server.py" 2>/dev/null || true
sleep 2

if [ "$NO_START" = "1" ]; then
  echo "==> [8/8] skipped start (--no-start)"
  exit 0
fi

echo "==> [8/8] starting the server on 127.0.0.1:$PORT (headed, DISPLAY=$DISPLAY_NUM)"
cd "$REPO"
nohup env DISPLAY="$DISPLAY_NUM" NODE_ENV=development CAMOFOX_PORT="$PORT" \
  CAMOFOX_INTERACTIVE=desktop CAMOFOX_BIND_HOST=127.0.0.1 \
  CAMOUFOX_EXECUTABLE="$BIN" CAMOFOX_DISABLE_DEFAULT_ADDONS=1 \
  CAMOFOX_CRASH_REPORT_ENABLED=false \
  BROWSER_RSS_RESTART_THRESHOLD_MB=6000 NATIVE_MEM_RESTART_THRESHOLD_MB=3000 \
  node server.js > "$WS/camofox-browser.log" 2>&1 &
echo "    server pid $!"

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "HEALTH OK"
    curl -fsS "http://127.0.0.1:$PORT/health"
    echo
    exit 0
  fi
  sleep 2
done

echo "server did not become healthy; last log lines:" >&2
tail -20 "$WS/camofox-browser.log" >&2
exit 1
