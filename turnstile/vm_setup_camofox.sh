#!/bin/bash
# Replace the old InstaBox camoufox-server.py stack with our camofox-browser build.
set -u
export DISPLAY=:1
WS=/data/workspace
REPO=$WS/camofox-browser

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

echo "[2/7] cloning/updating camofox-browser"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only 2>&1 | tail -5
else
  rm -rf "$REPO"
  git clone https://github.com/jo-inc/camofox-browser.git "$REPO" 2>&1 | tail -5
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
mkdir -p "$REPO/plugins/ipv4fix"
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

echo "[6/7] starting server on :9377 (headed, DISPLAY=:1)"
nohup env DISPLAY=:1 NODE_ENV=development CAMOFOX_PORT=9377 \
  CAMOFOX_INTERACTIVE=desktop CAMOFOX_BIND_HOST=127.0.0.1 \
  CAMOUFOX_EXECUTABLE="$BIN" CAMOFOX_DISABLE_DEFAULT_ADDONS=1 \
  CAMOFOX_CRASH_REPORT_ENABLED=false \
  BROWSER_RSS_RESTART_THRESHOLD_MB=6000 NATIVE_MEM_RESTART_THRESHOLD_MB=3000 \
  node server.js > "$WS/camofox-browser.log" 2>&1 &
echo "server pid $!"

echo "[7/7] waiting for health"
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
