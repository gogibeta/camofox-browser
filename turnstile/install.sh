#!/bin/bash
# One-shot installer for the camofox-browser Turnstile kit.
#
# This is the single source of truth for "install everything". It installs, in
# one command and with no manual follow-up:
#
#   1. node dependencies
#   2. system packages the browser and the solver need (Xvfb, xdotool)
#   3. a Rust toolchain, if none is present
#   4. camofox.config.json -- MERGED, never overwritten, so a plugin list that
#      was already correct is not silently replaced by a shorter one
#   5. every enabled plugin's own dependencies: apt.txt packages and
#      post-install.sh hooks (the youtube plugin's pinned yt-dlp is one of them,
#      and without it the plugin loads and then silently degrades)
#   6. the captchafix plugin (ships in this repo; verified present and enabled)
#   7. the extension, staged twice: Chrome MV3 and Firefox MV2
#   8. the Rust solver, compiled from source
#   9. a headed server on 127.0.0.1:9377, gated on /health AND on captchafix
#      actually having loaded
#  10. a doctor pass that reports anything still missing
#
# Usage:
#   bash turnstile/install.sh              # full install + start
#   bash turnstile/install.sh --no-start   # install only
#   bash turnstile/install.sh --no-deps    # skip apt (offline / no sudo)
#   bash turnstile/install.sh --no-rust    # skip toolchain bootstrap
#
# Idempotent: safe to re-run after a git pull.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WS="${WS:-/data/workspace}"
DISPLAY_NUM="${DISPLAY_NUM:-:1}"
PORT="${CAMOFOX_PORT:-9377}"
NO_START=0
NO_DEPS=0
NO_RUST=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --no-deps)  NO_DEPS=1 ;;
    --no-rust)  NO_RUST=1 ;;
    -h|--help)  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

export DISPLAY="$DISPLAY_NUM"
SOLVER="$WS/camofox_solve_rust"
LOG="$WS/camofox-browser.log"

# Optional .env (repo root or installer dir). Used only to seed the extension's
# config.json and the InstaBox target; nothing here prints a value. Real
# environment variables always win, so `INSTABOX_API_KEY=... bash install.sh`
# overrides the file.
for envf in "$REPO/.env" "$SCRIPT_DIR/.env"; do
  if [ -f "$envf" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%"$(printf '\r')"}
      line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
      case "$line" in ''|\#*) continue ;; esac
      case "$line" in *=*) ;; *) continue ;; esac
      key=${line%%=*}
      value=${line#*=}
      value=$(printf '%s' "$value" | sed 's/^["'\'']//;s/["'\'']$//')
      # setdefault: do not override a real environment variable.
      if [ -z "$(printenv "$key" 2>/dev/null || true)" ]; then
        export "$key=$value"
      fi
    done < "$envf"
    echo "loaded $envf (values not printed)"
  fi
done

say()  { echo "==> $*"; }
warn() { echo "    WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# Root, or passwordless sudo. Used only for apt and for hooks that write to
# /usr/local/bin; everything else runs as the invoking user.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
  fi
fi
have_root() { [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; }

apt_install() {
  # Install packages that are not already present. Returns 0 when everything
  # ended up installed, 1 when apt was unavailable or refused.
  local missing="" p
  for p in "$@"; do
    dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
  done
  [ -z "$missing" ] && return 0
  if [ "$NO_DEPS" = "1" ]; then
    warn "not installing:$missing (--no-deps)"
    return 1
  fi
  if ! command -v apt-get >/dev/null 2>&1 || ! have_root; then
    warn "cannot install:$missing (no apt-get, or no root/sudo)"
    return 1
  fi
  say "installing system packages:$missing"
  # shellcheck disable=SC2086
  $SUDO apt-get update -qq || true
  # shellcheck disable=SC2086
  if ! $SUDO apt-get install -y --no-install-recommends $missing; then
    warn "apt-get failed for:$missing"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
say "[1/10] checking prerequisites"
for bin in node npm git curl; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required binary: $bin"
done
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required (found $(node -v))"
[ -f "$REPO/server.js" ] || die "$REPO does not look like a camofox-browser checkout"
mkdir -p "$WS"

# ---------------------------------------------------------------------------
say "[2/10] system packages (Xvfb for the virtual display, xdotool for the solver)"
# xdotool is not optional: the solver raises and sizes the Camoufox window before
# it clicks, because a background window can swallow the OS pointer event that a
# Managed Challenge needs. Without it the solve still "runs" and quietly misses.
DEPS_MISSING=0
apt_install xvfb xdotool ca-certificates curl || DEPS_MISSING=1
for bin in Xvfb xdotool; do
  command -v "$bin" >/dev/null 2>&1 || warn "$bin is not installed; solves may fail to click"
done

# ---------------------------------------------------------------------------
say "[3/10] Rust toolchain"
if ! command -v rustc >/dev/null 2>&1; then
  if [ "$NO_RUST" = "1" ]; then
    die "rustc is required to build the solver (--no-rust was passed)"
  fi
  say "    no rustc found; trying the distro package"
  apt_install rustc || true
  if ! command -v rustc >/dev/null 2>&1; then
    say "    distro package unavailable; bootstrapping rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      || die "could not install a Rust toolchain. Install it manually:
       curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
    # rustup installs outside PATH until the shell profile is re-read.
    for candidate in "$HOME/.cargo/bin/rustc" /root/.cargo/bin/rustc; do
      if [ -x "$candidate" ]; then
        export PATH="$(dirname "$candidate"):$PATH"
        break
      fi
    done
  fi
fi
command -v rustc >/dev/null 2>&1 || die "rustc still not available after bootstrap"
echo "    using $(command -v rustc) ($(rustc --version))"

# ---------------------------------------------------------------------------
say "[4/10] node dependencies"
cd "$REPO"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -5
else
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
fi

# ---------------------------------------------------------------------------
say "[5/10] merging camofox.config.json"
# Merge, do not overwrite. An install must not be able to delete a plugin the
# operator enabled (vnc, a third-party plugin) or reset a tuning value. The
# merge is a node script so the VM path, this installer and the InstaBox
# installer all share one implementation.
[ -f "$REPO/scripts/merge-camofox-config.mjs" ] \
  || die "$REPO/scripts/merge-camofox-config.mjs is missing"
node "$REPO/scripts/merge-camofox-config.mjs" "$REPO/camofox.config.json" \
  --drop ipv4fix --drop cloudflarefix \
  --enable youtube --enable persistence --enable captchafix \
  --interactive desktop

# ---------------------------------------------------------------------------
say "[6/10] plugin dependencies (apt.txt + post-install.sh of every enabled plugin)"
# The youtube plugin is enabled by default and its transcript path needs yt-dlp.
# Nothing used to install it on a VM, so the plugin loaded, logged a warning, and
# every transcript request silently took the slow browser fallback.
if [ -f "$REPO/scripts/install-plugin-deps.sh" ]; then
  # The variables are passed through `env` because the hooks write to
  # /usr/local/bin and therefore have to run under sudo, and `sudo` scrubs the
  # caller's environment by default. A plain `VAR=x sh script` prefix is lost the
  # moment the command is wrapped in $SUDO -- which is exactly how the first
  # version of this ended up reporting "no plugins dir at /app/plugins".
  PLUGIN_DEPS_OK=1
  if [ "$NO_DEPS" = "1" ] || ! have_root; then
    warn "skipping apt (--no-deps or no root); still running the post-install hooks"
    # shellcheck disable=SC2086
    $SUDO env REPO_DIR="$REPO" SUDO="" CAMOFOX_DEPS_APT=0 \
      sh "$REPO/scripts/install-plugin-deps.sh" || PLUGIN_DEPS_OK=0
  else
    # shellcheck disable=SC2086
    $SUDO env REPO_DIR="$REPO" SUDO="" CAMOFOX_DEPS_APT=1 \
      sh "$REPO/scripts/install-plugin-deps.sh" || PLUGIN_DEPS_OK=0
  fi
  [ "$PLUGIN_DEPS_OK" = "1" ] || warn "a plugin dependency step failed (see above)"
else
  warn "scripts/install-plugin-deps.sh is missing; plugin dependencies were not installed"
fi

# ---------------------------------------------------------------------------
say "[7/10] verifying the captchafix plugin"
# captchafix is what makes Cloudflare Managed Challenges and click-through
# captchas solvable at all. With Camoufox's defaults the challenge frame is
# never created (COOP is on), and a page-coordinate click cannot reach a widget
# inside a cross-origin frame. It also supersedes ipv4fix and cloudflarefix.
PLUGIN="$REPO/plugins/captchafix/index.js"
[ -f "$PLUGIN" ] || die "$PLUGIN is missing; Cloudflare challenges and captchas would not be solvable"
node --check "$PLUGIN" 2>/dev/null || die "$PLUGIN does not parse"
rm -rf "$REPO/plugins/ipv4fix" "$REPO/plugins/cloudflarefix"
echo "    using $PLUGIN"

# ---------------------------------------------------------------------------
say "[8/10] staging the extension and compiling the solver"
# Two builds, because two different browsers consume it: Chrome/Edge/Chromium
# read manifest.json (MV3), Firefox/Camoufox read manifest-firefox.json, which
# has to be renamed to manifest.json to be a valid add-on directory.
EXT_SRC="$REPO/extension"
[ -f "$EXT_SRC/manifest.json" ] || die "$EXT_SRC/manifest.json is missing"
CHROME_EXT="$WS/turnstile-ext"
FIREFOX_EXT="$WS/turnstile-ext-firefox"
rm -rf "$CHROME_EXT" "$FIREFOX_EXT"
mkdir -p "$CHROME_EXT" "$FIREFOX_EXT"
for f in "$EXT_SRC"/*.js "$EXT_SRC"/*.html "$EXT_SRC"/*.css "$EXT_SRC"/icons; do
  [ -e "$f" ] || continue
  cp -rf "$f" "$CHROME_EXT/"
  cp -rf "$f" "$FIREFOX_EXT/"
done
cp -f "$EXT_SRC/manifest.json" "$CHROME_EXT/manifest.json"
# MV3 manifest is useless to Firefox; the MV2 one replaces it.
cp -f "$EXT_SRC/manifest-firefox.json" "$FIREFOX_EXT/manifest.json" \
  || die "$EXT_SRC/manifest-firefox.json is missing"
echo "    chromium: $CHROME_EXT"
echo "    firefox:  $FIREFOX_EXT"

# Loading an unpacked extension into a browser cannot be automated -- that is a
# browser security boundary. Configuring it can be, so the key is seeded here
# from the environment instead of asking the operator to paste it into the popup.
# Only written when a key is actually available: a config.json with an empty key
# is worse than no file, because it looks configured.
if [ -n "${INSTABOX_API_KEY:-}" ]; then
  EXT_CFG=$(node -e '
    // Strip CR and surrounding whitespace from every value. A .env written on
    // Windows, or an env var passed through a shell that preserved a CR, gives
    // you "m_abc\r" -- and a machine id with a trailing CR produces a URL that
    // fetch() rejects, so the extension fails to reach the box at all while
    // looking perfectly configured.
    const clean = (v) => String(v == null ? "" : v).replace(/[\r\n]/g, "").trim();
    const cfg = {
      instaboxApiKey: clean(process.env.INSTABOX_API_KEY),
      instaboxMachineId: clean(process.env.INSTABOX_MACHINE_ID),
      instaboxApiUrl: clean(process.env.INSTABOX_API_URL) || "https://api.instabox.sh/v1",
      solverPath: process.argv[1],
      solverPython: "",
      camofoxUrl: `http://127.0.0.1:${clean(process.env.CAMOFOX_PORT) || 9377}`,
      timeoutMs: Number(clean(process.env.TIMEOUT_MS)) || 45000,
      autoSolve: true,
    };
    process.stdout.write(JSON.stringify(cfg, null, 2));
  ' "$SOLVER")
  for dir in "$CHROME_EXT" "$FIREFOX_EXT"; do
    printf '%s\n' "$EXT_CFG" > "$dir/config.json"
    chmod 600 "$dir/config.json"
  done
  echo "    seeded config.json into both extension copies (key not printed)"
else
  # Never leave a stale key from a previous install lying around.
  rm -f "$CHROME_EXT/config.json" "$FIREFOX_EXT/config.json"
  echo "    no INSTABOX_API_KEY in the environment; set the key in the extension popup"
fi

# One engine only: the Rust binary. No interpreter to keep in sync, and it
# starts in ~4 ms. The Python solver stays in the repo as a readable reference
# and is deliberately never installed.
[ -f "$REPO/solver/camofox_solve.rs" ] || die "$REPO/solver/camofox_solve.rs is missing"
echo "    compiling camofox_solve.rs"
rustc --edition 2021 -O "$REPO/solver/camofox_solve.rs" -o "$SOLVER" \
  || die "the Rust solver failed to compile; refusing to start a browser that cannot solve"
chmod +x "$SOLVER"
# A stale Python solver from an earlier install would let someone point
# solverPath at a second, unmaintained code path.
rm -f "$WS/camofox_solve.py" "$WS/instabox_solver.py"
# Smoke it: a compiled binary that cannot even parse an argument is worse than
# no binary, because the failure surfaces 45 s into a solve.
SMOKE=$("$SOLVER" '{}' 2>&1 | tail -1 || true)
case "$SMOKE" in
  *'"error"'*) echo "    solver smoke: ok" ;;
  *) die "the compiled solver did not return a JSON error for empty input: $SMOKE" ;;
esac

# ---------------------------------------------------------------------------
say "[9/10] starting the server on 127.0.0.1:$PORT (headed, DISPLAY=$DISPLAY_NUM)"
BIN="${CAMOUFOX_EXECUTABLE:-/data/home/.cache/camoufox/camoufox-bin}"
if [ ! -x "$BIN" ]; then
  BIN=$(find /data/home/.cache/camoufox /root/.cache/camoufox "$HOME/.cache/camoufox" \
        -name camoufox-bin -type f 2>/dev/null | head -1)
fi
[ -n "${BIN:-}" ] && [ -x "$BIN" ] \
  || die "Camoufox binary not found. Run 'npx camoufox-js fetch' (or npm run fetch-bin) first."
echo "    camoufox: $BIN"

if [ "$NO_START" = "1" ]; then
  say "[10/10] skipped start (--no-start)"
  bash "$SCRIPT_DIR/doctor.sh" --no-server || true
  exit 0
fi

pkill -f "node server.js" 2>/dev/null || true
pkill -f "camoufox-server.py" 2>/dev/null || true
sleep 2
# Truncate: the plugin gate greps this file, and an old "plugin loaded" line from
# a previous run would make a plugin-less server look fine.
: > "$LOG"
cd "$REPO"
nohup env DISPLAY="$DISPLAY_NUM" NODE_ENV=development CAMOFOX_PORT="$PORT" \
  CAMOFOX_INTERACTIVE=desktop CAMOFOX_BIND_HOST=127.0.0.1 \
  CAMOUFOX_EXECUTABLE="$BIN" CAMOFOX_DISABLE_DEFAULT_ADDONS=1 \
  CAMOFOX_CRASH_REPORT_ENABLED=false \
  BROWSER_RSS_RESTART_THRESHOLD_MB=6000 NATIVE_MEM_RESTART_THRESHOLD_MB=3000 \
  node server.js >> "$LOG" 2>&1 &
echo "    server pid $!"

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "HEALTH OK"
    curl -fsS "http://127.0.0.1:$PORT/health"; echo
    # A server that is healthy but running without the plugin still cannot
    # clear a challenge, so prove the plugin loaded before declaring success.
    if ! grep -q 'plugin loaded.*"captchafix"' "$LOG"; then
      echo "captchafix FAILED: the server is up but the plugin did not load" >&2
      grep -E '"plugin (loaded|load failed)"' "$LOG" | tail -10 >&2
      exit 1
    fi
    echo "captchafix OK"
    say "[10/10] doctor"
    bash "$SCRIPT_DIR/doctor.sh"
    exit 0
  fi
  sleep 2
done

echo "server did not become healthy; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
