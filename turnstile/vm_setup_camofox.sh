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

echo "[1/7] stopping old browser stack"
bash "$WS/stop-browser.sh" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
pkill -f "camofox-browser" 2>/dev/null || true
sleep 2

echo "[2/7] cloning/updating camofox-browser (our fork, with the Turnstile kit)"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --depth=1 origin "$REPO_BRANCH" 2>&1 | tail -3
  # An older install left untracked copies of paths the fork now tracks
  # (plugins/ipv4fix, extension/, solver/), and `checkout -B` refuses to
  # overwrite them. Remove only those specific untracked paths -- no reset, no
  # broad clean, so anything else in the checkout survives.
  if ! git -C "$REPO" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" 2>/dev/null; then
    echo "    clearing untracked kit paths that the fork now tracks"
    for path in plugins/ipv4fix extension solver turnstile; do
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
if [ ! -f "$REPO/solver/camofox_solve.py" ] || [ ! -d "$REPO/extension" ]; then
  echo "ERROR: $REPO is missing the Turnstile kit (solver/ or extension/)." >&2
  echo "       Check CAMOFOX_REPO_URL/BRANCH (now: $REPO_URL @ $REPO_BRANCH)." >&2
  exit 1
fi

echo "[3/7] npm ci"
cd "$REPO" || exit 1
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -20

echo "[4/7] writing config"
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
    "ipv4fix": { "enabled": true }
  }
}
JSON

echo "[5/7] installing ipv4fix plugin"
# Prefer the fork's own plugin; the inline copy below is only a fallback for a
# checkout that somehow lacks it.
mkdir -p "$REPO/plugins/ipv4fix"
if [ -f "$REPO/turnstile/plugins/ipv4fix.js" ]; then
  cp -f "$REPO/turnstile/plugins/ipv4fix.js" "$REPO/plugins/ipv4fix/index.js"
  echo "    using the fork's plugins/ipv4fix"
else
  cat > "$REPO/plugins/ipv4fix/index.js" <<'JS'
export function register(_app, ctx) {
  ctx.events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = {
      ...(options.firefoxUserPrefs || {}),
      'javascript.enabled': true,
      'network.dns.disableIPv6': true,
      'browser.contentblocking.category': 'standard',
      'privacy.trackingprotection.enabled': false,
      'privacy.trackingprotection.pbmode.enabled': false,
      'privacy.trackingprotection.cryptomining.enabled': false,
      'privacy.trackingprotection.fingerprinting.enabled': false,
    };
    try {
      const key = Object.keys(options.env || {}).find(k => /^CAMOU_CONFIG_/.test(k));
      if (key) {
        const cfg = JSON.parse(options.env[key]);
        cfg['javascript.enabled'] = true;
        cfg['network.dns.disableIPv6'] = true;
        cfg['browser.contentblocking.category'] = 'standard';
        cfg['privacy.trackingprotection.enabled'] = false;
        cfg['privacy.trackingprotection.pbmode.enabled'] = false;
        options.env[key] = JSON.stringify(cfg);
      }
    } catch {}
    ctx.log('info', 'ipv4fix: disabled IPv6 DNS in Camoufox');
  });
}
JS
fi

echo "[6/8] staging the solver and extension"
# The browser is useless for auto-solving without these, and a re-install must
# refresh them: a stale /data/workspace/camofox_solve.py from an earlier build
# silently keeps running the old click-once logic.
mkdir -p "$WS/turnstile-ext"
cp -f "$REPO"/extension/* "$WS/turnstile-ext/" 2>/dev/null || true
cp -f "$REPO/solver/camofox_solve.py" "$WS/camofox_solve.py"
cp -f "$REPO/solver/camofox_solve.py" "$WS/instabox_solver.py"
if command -v rustc >/dev/null 2>&1 && [ -f "$REPO/solver/camofox_solve.rs" ]; then
  echo "    compiling the Rust solver"
  rustc --edition 2021 -O "$REPO/solver/camofox_solve.rs" -o "$WS/camofox_solve_rust" 2>&1 \
    | grep -E '^error' || true
fi
ls -la "$WS/camofox_solve.py" "$WS/camofox_solve_rust" 2>/dev/null | sed 's/^/    /'

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
    echo "HEALTH OK"
    curl -fsS http://127.0.0.1:9377/health
    exit 0
  fi
  sleep 2
done
echo "HEALTH FAILED"
tail -80 "$WS/camofox-browser.log"
exit 1
