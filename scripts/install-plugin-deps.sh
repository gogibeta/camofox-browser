#!/bin/sh
# Install system packages and post-install hooks declared by plugins.
#
# Each plugin can ship an `apt.txt` (one package per line, `#` comments) and an
# executable `post-install.sh`. Both are run for every plugin that is ENABLED in
# camofox.config.json.
#
# Historically this only ran during `docker build`, from /app, as root. The VM
# install path did not run it at all, so an enabled plugin's dependencies were
# silently absent: the youtube plugin loaded, logged "yt-dlp not found", and
# every transcript request quietly fell back to the slow browser path. The
# script therefore now also works outside Docker:
#
#   REPO_DIR=<checkout> SUDO="sudo -n" sh scripts/install-plugin-deps.sh
#
# Environment:
#   REPO_DIR          repository root (default /app)
#   SUDO              privilege prefix for apt (default: empty)
#   CAMOFOX_DEPS_APT  1 to install apt packages, 0 to skip them (default 1)
#   CAMOFOX_DEPS_STRICT 1 to exit non-zero when a hook fails (default 0)
set -u

REPO_DIR="${REPO_DIR:-/app}"
CONFIG="$REPO_DIR/camofox.config.json"
PLUGINS_DIR="$REPO_DIR/plugins"
SUDO="${SUDO:-}"
INSTALL_APT="${CAMOFOX_DEPS_APT:-1}"
STRICT="${CAMOFOX_DEPS_STRICT:-0}"
HOOK_FAILURES=0
APT_FAILURES=0

[ -d "$PLUGINS_DIR" ] || { echo "[install-plugin-deps] no plugins dir at $PLUGINS_DIR" >&2; exit 1; }

# Read the enabled plugin list from camofox.config.json, or fall back to every
# plugin directory. The fallback matters for a checkout whose config is missing.
PLUGIN_LIST=""
USE_ALL_PLUGINS=1
if [ -f "$CONFIG" ] && command -v node >/dev/null 2>&1; then
  PLUGIN_LIST=$(node -e '
    const fs = require("fs"), path = require("path");
    let c = {};
    try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { c = {}; }
    const p = c.plugins;
    let names;
    if (Array.isArray(p)) names = p.slice();
    else if (p && typeof p === "object") names = Object.keys(p);
    else { process.exit(0); }
    const enabled = names.filter((name) => {
      const s = Array.isArray(p) ? { enabled: true } : p[name];
      if (s !== false && s?.enabled !== false) return true;
      // A plugin explicitly disabled in config may still be enabled by an env
      // var, which is what plugin.json:enableEnvVar is for.
      try {
        const md = JSON.parse(fs.readFileSync(path.join(process.argv[2], name, "plugin.json"), "utf8"));
        const v = md?.enableEnvVar;
        return typeof v === "string" && v.length > 0 && /^(1|true|yes|on)$/i.test(process.env[v] || "");
      } catch { return false; }
    });
    console.log("selected " + enabled.join(" "));
  ' "$CONFIG" "$PLUGINS_DIR" 2>/dev/null) || PLUGIN_LIST=""
  case "$PLUGIN_LIST" in
    selected*) PLUGIN_LIST=${PLUGIN_LIST#selected }; USE_ALL_PLUGINS=0 ;;
    *) PLUGIN_LIST="" ;;
  esac
fi

if [ "$USE_ALL_PLUGINS" -eq 1 ]; then
  echo "[install-plugin-deps] no usable plugin list in config; using every plugin directory"
  PLUGIN_LIST=""
  for d in "$PLUGINS_DIR"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in _*|.*) continue ;; esac
    PLUGIN_LIST="$PLUGIN_LIST $name"
  done
fi

echo "[install-plugin-deps] plugins:$PLUGIN_LIST"

# --- apt packages ----------------------------------------------------------
PKGS=""
for name in $PLUGIN_LIST; do
  f="$PLUGINS_DIR/$name/apt.txt"
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$(printf '\r')"}
    # Strip leading whitespace so an indented package name still installs.
    line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$line" in \#*|"") continue ;; esac
    PKGS="$PKGS $line"
  done < "$f"
done

# Only ask apt for what is not already present: `apt-get update` on every run is
# slow and fails offline, and a re-install should be near-instant.
MISSING=""
for p in $PKGS; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"
done

if [ -n "$MISSING" ] && [ "$INSTALL_APT" = "1" ] && command -v apt-get >/dev/null 2>&1; then
  echo "[install-plugin-deps] installing:$MISSING"
  # shellcheck disable=SC2086
  $SUDO apt-get update -qq || true
  # shellcheck disable=SC2086
  if ! $SUDO apt-get install -y --no-install-recommends $MISSING; then
    echo "[install-plugin-deps] apt-get failed for:$MISSING" >&2
    APT_FAILURES=1
  fi
elif [ -n "$MISSING" ]; then
  echo "[install-plugin-deps] skipping apt for:$MISSING (apt disabled or unavailable)" >&2
else
  echo "[install-plugin-deps] apt dependencies already satisfied"
fi

# --- post-install hooks ----------------------------------------------------
for name in $PLUGIN_LIST; do
  hook="$PLUGINS_DIR/$name/post-install.sh"
  [ -f "$hook" ] || continue
  if [ ! -x "$hook" ]; then
    # A checkout from Windows can lose the executable bit; chmod it rather than
    # skipping the hook, which is how yt-dlp silently never got installed.
    chmod +x "$hook" 2>/dev/null || true
  fi
  if [ ! -x "$hook" ]; then
    echo "[install-plugin-deps] $name: post-install.sh is not executable; skipping" >&2
    HOOK_FAILURES=$((HOOK_FAILURES + 1))
    continue
  fi
  echo "[install-plugin-deps] running post-install for $name"
  # Hooks may need root (they write /usr/local/bin), so run them under SUDO when
  # one is available. The hook is responsible for being idempotent.
  if ! $SUDO "$hook"; then
    echo "[install-plugin-deps] $name: post-install.sh failed" >&2
    HOOK_FAILURES=$((HOOK_FAILURES + 1))
  fi
done

if [ "$HOOK_FAILURES" -gt 0 ] || [ "$APT_FAILURES" -gt 0 ]; then
  echo "[install-plugin-deps] finished with $APT_FAILURES apt and $HOOK_FAILURES hook failure(s)" >&2
  [ "$STRICT" = "1" ] && exit 1
fi
echo "[install-plugin-deps] done"
exit 0
