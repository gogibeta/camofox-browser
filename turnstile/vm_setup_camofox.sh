#!/bin/bash
# Replace the old InstaBox camoufox-server.py stack with our camofox-browser build.
#
# This script deliberately does almost nothing itself. It exists to solve ONE
# problem: getting the right checkout onto the box. Everything that has to be
# installed is installed by that checkout's own turnstile/install.sh.
#
# Why it is not a second installer any more: it used to write
# camofox.config.json with its own heredoc, compile the solver itself, and
# duplicate the health/plugin gate. Two installers meant two configs, two
# builds, and two chances to disagree -- which is how the live box drifted to a
# commit with ipv4fix and no captchafix, and how its config lost `vnc` and
# reset `interactive.mode`. There is now exactly one installer.
set -u
export DISPLAY="${DISPLAY:-:1}"
WS="${WS:-/data/workspace}"
REPO="${REPO:-$WS/camofox-browser}"
# Override to track a different fork or a pinned tag.
REPO_URL="${CAMOFOX_REPO_URL:-https://github.com/gogibeta/camofox-browser.git}"
REPO_BRANCH="${CAMOFOX_REPO_BRANCH:-master}"

echo "[1/3] stopping the old browser stack"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "camofox-browser" 2>/dev/null || true
pkill -f "camoufox-server.py" 2>/dev/null || true
sleep 2

echo "[2/3] cloning/updating camofox-browser (our fork, with the Turnstile kit)"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --depth=1 origin "$REPO_BRANCH" 2>&1 | tail -3
  # An older install left untracked copies of paths the fork now tracks
  # (plugins/captchafix, extension/, solver/, turnstile/), and `checkout -B`
  # refuses to overwrite them. Remove only those specific untracked paths -- no
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

echo "[3/3] running the checkout's own installer"
# No --no-start and no extra flags: this is the same command a human runs, so a
# deploy exercises the exact path that is documented and tested.
exec bash "$REPO/turnstile/install.sh" "$@"
