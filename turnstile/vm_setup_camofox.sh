#!/bin/bash
# Replace the old InstaBox camoufox-server.py stack with our camofox-browser build.
#
# Clones OUR fork, not upstream: the Turnstile kit (solver/, extension/,
# turnstile/) only exists on the fork. Cloning jo-inc/camofox-browser here got a
# working browser with none of the kit, which is why this script used to leave
# the VM unable to auto-solve anything.
set -u
export DISPLAY=:1
WS=/data/workspace
REPO=$WS/camofox-browser
# Override to track a different fork or a pinned tag.
REPO_URL="${CAMOFOX_REPO_URL:-https://github.com/gogibeta/camofox-browser.git}"
REPO_BRANCH="${CAMOFOX_REPO_BRANCH:-master}"

# Best-effort system fallback: prefer IPv4 for Cloudflare's challenge host.
if ! grep -q 'challenges.cloudflare.com' /etc/hosts 2>/dev/null; then
  sudo -n sh -c "echo '104.18.94.41 challenges.cloudflare.com' >> /etc/hosts" 2>/dev/null || true
fi
# camoufox-js downloads its own binary; detect it instead of hardcoding a version.
BIN=/data/home/.cache/camoufox/camoufox-bin
if [ ! -x "$BIN" ]; then
  BIN=$(find /data/home/.cache/camoufox -name camoufox-bin -type f 2>/dev/null | head -1)
fi
echo "using camoufox binary: $BIN"

echo "[1/8] stopping old browser stack"
bash "$WS/stop-browser.sh" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
pkill -f "camofox-browser" 2>/dev/null || true
sleep 2

echo "[2/8] cloning/updating camofox-browser (our fork, with the Turnstile kit)"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --depth=1 origin "$REPO_BRANCH" 2>&1 | tail -3
  # An older install left untracked copies of paths the fork now tracks
  # (plugins/captchafix, extension/, solver/), and `checkout -B` refuses to
  # overwrite them. Remove only those specific untracked paths -- no reset, no
  # broad clean, so anything else in the checkout survives.
  if ! git -C "$REPO" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" 2>/dev/null; then
    echo "    clearing untracked kit paths that the fork now tracks"
    for path in plugins/captchafix plugins/cloudflarefix plugins/ipv4fix extension solver turnstile; do
      if [ -e "$REPO/$path" ] && ! git -C "$REPO" ls-files --error-unmatch "$path" >/dev/null 2>&1; then
        rm -rf "$REPO/$path"
        echo "      removed $path"
      fi
    done
    git -C "$REPO" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" 2>&1 | tail -3
  fi
else
  rm -rf "$REPO"
  git clone --depth=1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO" 2>&1 | tail -5
fi
# The kit is the whole point of this fork; fail loudly rather than silently
# installing a browser that cannot solve.
if [ ! -f "$REPO/solver/camofox_solve.rs" ] || [ ! -d "$REPO/extension" ]; then
  echo "ERROR: $REPO is missing the Turnstile kit (solver/camofox_solve.rs or extension/)." >&2
  echo "       Check CAMOFOX_REPO_URL/BRANCH (now: $REPO_URL @ $REPO_BRANCH)." >&2
  exit 1
fi

echo "[3/8] npm ci"
cd "$REPO" || exit 1
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -20

echo "[4/8] writing config"
# NOTE: the plugin loader reads camofox.config.json (camoFOX), not camoufox.config.json
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
    "captchafix": { "enabled": true }
  }
}
JSON

echo "[5/8] verifying the captchafix plugin"
# captchafix supersedes ipv4fix. It sets the same anti-blocking prefs, but also:
#   - disables COOP, without which challenge frames are never created at all
#     (the page stays on "Just a moment..." forever);
#   - patches every CAMOU_CONFIG_<n> chunk, not just the first, so the
#     fingerprint keys that spilled into later chunks are not silently lost;
#   - clears challenges in-process by clicking the challenge frame element,
#     which a page-coordinate click cannot reach;
#   - handles the other captcha families, and reports the ones that need a human
#     instead of clicking at them blindly.
# The plugin ships in the repo at plugins/captchafix/, so there is no staged copy
# to install from: a second copy of the same 800-line file is a copy that goes
# stale the first time one of them is edited.
if [ ! -f "$REPO/plugins/captchafix/index.js" ]; then
  echo "ERROR: $REPO/plugins/captchafix/index.js is missing." >&2
  echo "       Cloudflare challenges and captchas would not be solvable; refusing to continue." >&2
  exit 1
fi
echo "    using the fork's plugins/captchafix"
# The old plugins must go, or they stay on disk and confuse the next reader.
rm -rf "$REPO/plugins/ipv4fix" "$REPO/plugins/cloudflarefix"

echo "[6/8] staging the extension and building the Rust solver"
# One engine only. The Rust binary is the single solver: no interpreter to keep
# in sync, and it is ~1s faster per solve. The Python solver is still in the repo
# for reference, but it is deliberately not installed.
mkdir -p "$WS/turnstile-ext"
cp -f "$REPO"/extension/* "$WS/turnstile-ext/" 2>/dev/null || true

if ! command -v rustc >/dev/null 2>&1; then
  echo "ERROR: rustc is required to build the solver and is not installed." >&2
  echo "       Install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  exit 1
fi
echo "    compiling camofox_solve.rs"
if ! rustc --edition 2021 -O "$REPO/solver/camofox_solve.rs" -o "$WS/camofox_solve_rust"; then
  echo "ERROR: the Rust solver failed to compile; not starting a browser that cannot solve." >&2
  exit 1
fi
chmod +x "$WS/camofox_solve_rust"
# Remove the Python solver left by an earlier install so nothing can silently
# run the old engine.
rm -f "$WS/camofox_solve.py" "$WS/instabox_solver.py"
ls -la "$WS/camofox_solve_rust" | sed 's/^/    /'

echo "[7/8] starting server on :9377 (headed, DISPLAY=:1)"
nohup env DISPLAY=:1 NODE_ENV=development CAMOFOX_PORT=9377 \
  CAMOFOX_INTERACTIVE=desktop CAMOFOX_BIND_HOST=127.0.0.1 \
  CAMOUFOX_EXECUTABLE="$BIN" CAMOFOX_DISABLE_DEFAULT_ADDONS=1 \
  CAMOFOX_CRASH_REPORT_ENABLED=false \
  BROWSER_RSS_RESTART_THRESHOLD_MB=6000 NATIVE_MEM_RESTART_THRESHOLD_MB=3000 \
  node server.js > "$WS/camofox-browser.log" 2>&1 &
echo "server pid $!"

echo "[8/8] waiting for health"
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:9377/health >/dev/null 2>&1; then
    # A server that is merely healthy is not enough: the plugin is what clears
    # challenges, and a plugin-less server silently fails every one of them.
    sleep 1
    if ! grep -q 'plugin loaded.*"captchafix"' "$WS/camofox-browser.log"; then
      echo "HEALTH FAILED: server is up but the captchafix plugin did not load" >&2
      grep -i 'plugin' "$WS/camofox-browser.log" | tail -20 >&2
      exit 1
    fi
    echo "HEALTH OK"
    echo "captchafix OK"
    curl -fsS http://127.0.0.1:9377/health
    exit 0
  fi
  sleep 2
done
echo "HEALTH FAILED"
tail -80 "$WS/camofox-browser.log"
exit 1
