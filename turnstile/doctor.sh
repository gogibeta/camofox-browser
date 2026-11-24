#!/bin/bash
# Report whether this host is actually ready to solve captchas.
#
# install.sh installs; this proves. Everything a solve silently depends on is
# checked here, because every one of these has at some point been missing while
# the server looked healthy:
#
#   - Xvfb and xdotool       the display and the OS-level window activation
#   - the Rust solver        the engine the extension execs
#   - camofox.config.json    captchafix enabled, superseded plugins gone
#   - the plugin loaded      a healthy server without it clears nothing
#   - the extension staged   BOTH manifests, because MV3 is useless to Firefox
#   - yt-dlp                 the youtube plugin degrades silently without it
#   - /health                the server is up
#
# Exit 0 when nothing is missing, 1 when something is. Warnings do not fail.
#
# Usage:
#   bash turnstile/doctor.sh
#   bash turnstile/doctor.sh --no-server   # skip the live server checks
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WS="${WS:-/data/workspace}"
PORT="${CAMOFOX_PORT:-9377}"
LOG="$WS/camofox-browser.log"
SOLVER="$WS/camofox_solve_rust"
CHECK_SERVER=1
for arg in "$@"; do
  [ "$arg" = "--no-server" ] && CHECK_SERVER=0
done

FAILURES=0
WARNINGS=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  warn  %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }

echo "camofox-browser doctor"
echo "  repo: $REPO"
echo "  ws:   $WS"

echo
echo "display"
if command -v Xvfb >/dev/null 2>&1; then ok "Xvfb present"; else bad "Xvfb missing (apt-get install xvfb)"; fi
if command -v xdotool >/dev/null 2>&1; then
  ok "xdotool present (solver can raise its window)"
else
  # Not fatal for an embedded Turnstile widget, fatal-ish for a Managed
  # Challenge, where the click goes through a real OS pointer event.
  bad "xdotool missing (apt-get install xdotool); managed-challenge clicks may miss"
fi

echo
echo "solver"
if [ -x "$SOLVER" ]; then
  SMOKE=$("$SOLVER" '{}' 2>&1 | tail -1)
  case "$SMOKE" in
    *'"error"'*) ok "Rust solver runs ($SOLVER)" ;;
    *)           bad "Rust solver returned unexpected output: ${SMOKE:0:120}" ;;
  esac
else
  bad "Rust solver missing at $SOLVER"
fi
if [ -f "$WS/camofox_solve.py" ] || [ -f "$WS/instabox_solver.py" ]; then
  warn "a stale Python solver is still on disk; the Rust binary is the only engine"
fi

echo
echo "config"
CFG="$REPO/camofox.config.json"
if [ -f "$CFG" ]; then
  if node -e '
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const p = c.plugins;
      const obj = Array.isArray(p) ? Object.fromEntries(p.map(n => [n, { enabled: true }])) : (p || {});
      if (obj.captchafix === undefined) { console.error("captchafix not listed"); process.exit(1); }
      if (obj.captchafix !== false && obj.captchafix?.enabled === false) { console.error("captchafix disabled"); process.exit(1); }
      if (obj.ipv4fix || obj.cloudflarefix) { console.error("superseded plugin still listed"); process.exit(1); }
    ' "$CFG"; then
    ok "captchafix enabled, superseded plugins absent"
  else
    bad "camofox.config.json is not in a solvable state (see above)"
  fi
  # "desktop" versus "off" decides whether a challenge click lands: the solver
  # raises a real OS window before clicking, and a headless window swallows the
  # pointer event. The installer passes CAMOFOX_INTERACTIVE=desktop to the server,
  # but the file is the fallback, and a `git reset --hard` restores the committed
  # value -- so check the file too rather than trusting the launch environment.
  MODE=$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(c.interactive?.mode || "off"));
    } catch { process.stdout.write("unreadable"); }
  ' "$CFG")
  case "$MODE" in
    desktop) ok "interactive.mode is desktop (challenge clicks can land)" ;;
    off)     warn "interactive.mode is off; fine only if CAMOFOX_INTERACTIVE=desktop is set for the server" ;;
    *)       bad "interactive.mode is '$MODE' (expected desktop or off)" ;;
  esac
else
  bad "$CFG is missing"
fi
if [ -f "$REPO/plugins/captchafix/index.js" ]; then
  if node --check "$REPO/plugins/captchafix/index.js" 2>/dev/null; then
    ok "plugins/captchafix/index.js parses"
  else
    bad "plugins/captchafix/index.js does not parse"
  fi
else
  bad "plugins/captchafix/index.js is missing"
fi

echo
echo "extension"
for dir in "$WS/turnstile-ext" "$WS/turnstile-ext-firefox"; do
  if [ -f "$dir/manifest.json" ]; then
    VER=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifest_version)}catch(e){console.log("?")}' "$dir/manifest.json" 2>/dev/null || echo "?")
    ok "$dir (manifest v$VER)"
  else
    bad "$dir/manifest.json is missing"
  fi
done
# The MV3 staged copy must not be the MM2 manifest and vice versa: a Firefox
# build pointed at an MV3 manifest refuses to load with no useful error.
if [ -f "$WS/turnstile-ext/manifest.json" ] && [ -f "$WS/turnstile-ext-firefox/manifest.json" ]; then
  A=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifest_version)}catch(e){}' "$WS/turnstile-ext/manifest.json" 2>/dev/null)
  B=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifest_version)}catch(e){}' "$WS/turnstile-ext-firefox/manifest.json" 2>/dev/null)
  if [ "$A" = "3" ] && [ "$B" = "2" ]; then
    ok "chromium copy is MV3, firefox copy is MV2"
  else
    bad "staged manifests are wrong (chromium=$A, firefox=$B; expected 3 and 2)"
  fi
fi
if [ -f "$WS/ext-config.json" ]; then
  if node -e '
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (!c.instaboxApiKey) throw new Error("instaboxApiKey is empty");
      if (!c.solverPath) throw new Error("solverPath is empty");
      if (c.solverPython) throw new Error("solverPython is set but the engine is a native binary");
    ' "$WS/ext-config.json" 2>/dev/null; then
    ok "ext-config.json points at the Rust binary and has a key"
  else
    warn "ext-config.json is incomplete (the popup can also set these)"
  fi
else
  warn "$WS/ext-config.json is absent; set the InstaBox key in the extension popup"
fi

echo
echo "plugin dependencies"
ENABLED=$(node -e '
  try {
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = c.plugins;
    const obj = Array.isArray(p) ? Object.fromEntries(p.map(n => [n, { enabled: true }])) : (p || {});
    console.log(Object.entries(obj).filter(([, v]) => v !== false && v?.enabled !== false).map(([k]) => k).join(" "));
  } catch {}
' "$CFG" 2>/dev/null)
if command -v yt-dlp >/dev/null 2>&1; then
  ok "yt-dlp present ($(yt-dlp --version 2>/dev/null | head -1))"
elif echo " $ENABLED " | grep -q ' youtube '; then
  warn "yt-dlp missing while youtube is enabled; transcripts fall back to the slow browser path"
else
  ok "yt-dlp not needed (youtube disabled)"
fi

echo
echo "server"
if [ "$CHECK_SERVER" = "1" ]; then
  HEALTH=$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    ok "/health responds on 127.0.0.1:$PORT"
    echo "$HEALTH" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const h=JSON.parse(s);
          console.log(`  ok    engine=${h.engine} browserRunning=${h.browserRunning} tabs=${h.activeTabs}`);
        } catch { console.log("  warn  /health returned non-JSON"); }
      });'
  else
    bad "no /health on 127.0.0.1:$PORT; start the server"
  fi
  if [ -f "$LOG" ]; then
    if grep -q 'plugin loaded.*"captchafix"' "$LOG"; then
      ok "captchafix loaded (log)"
    else
      bad "captchafix did not log a load; challenges will fail"
    fi
    if grep -q '"plugin load failed"' "$LOG"; then
      warn "a plugin failed to load:"
      grep '"plugin load failed"' "$LOG" | tail -3 | sed 's/^/        /'
    fi
    if grep -q 'yt-dlp not found' "$LOG"; then
      warn "the log records a missing yt-dlp from a previous start"
    fi
    # The file's mode is a fallback; this is the value the launch actually used.
    # A server started with CAMOFOX_INTERACTIVE=off cannot land a challenge click,
    # and nothing else in the log says so plainly.
    LAUNCH_MODE=$(grep -o '"interactiveMode":"[a-z]*"' "$LOG" | tail -1 | sed 's/.*:"//;s/"$//')
    case "${LAUNCH_MODE:-}" in
      desktop) ok "server launched in desktop mode" ;;
      off)     bad "server launched with interactiveMode=off; a managed-challenge click cannot land" ;;
      '')      : ;;  # no launch recorded yet; the file check above stands in
      *)       warn "server launched with an unexpected interactiveMode=$LAUNCH_MODE" ;;
    esac
  else
    warn "$LOG does not exist; the server may not have been started by install.sh"
  fi
else
  echo "  skipped (--no-server)"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: $FAILURES problem(s), $WARNINGS warning(s)"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  echo "RESULT: ready, with $WARNINGS warning(s)"
  exit 0
fi
echo "RESULT: ready"
exit 0
