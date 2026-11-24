#!/bin/sh
# Install a pinned yt-dlp binary (not available via apt).
#
# Idempotent: a re-install must be instant and offline-safe. Re-downloading a
# 3 MB asset on every `install.sh` run made a re-deploy slower than a fresh one
# for no reason, and turned a re-install into a network dependency.
set -e

: "${YT_DLP_VERSION:=2026.08.19}"
: "${YT_DLP_ASSET:=yt-dlp}"
: "${YT_DLP_SHA256:=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6}"
: "${YT_DLP_INSTALL_PATH:=/usr/local/bin/yt-dlp}"

# Already the pinned version: verify the checksum and stop. A corrupted copy is
# still caught, because sha256sum is what decides.
if [ -x "$YT_DLP_INSTALL_PATH" ]; then
  if printf '%s  %s\n' "$YT_DLP_SHA256" "$YT_DLP_INSTALL_PATH" | sha256sum -c - >/dev/null 2>&1; then
    echo "yt-dlp: pinned version already installed at $YT_DLP_INSTALL_PATH"
    exit 0
  fi
  echo "yt-dlp: existing binary does not match the pinned checksum; reinstalling" >&2
fi

# Download to a temp path and move only after the checksum passes, so a failed
# download cannot leave a half-written binary at the install path.
TMP="$YT_DLP_INSTALL_PATH.tmp.$$"
trap 'rm -f "$TMP"' EXIT
curl -fL --retry 3 --connect-timeout 20 \
  "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${YT_DLP_ASSET}" \
  -o "$TMP"
printf '%s  %s\n' "$YT_DLP_SHA256" "$TMP" | sha256sum -c -
chmod 755 "$TMP"
mv -f "$TMP" "$YT_DLP_INSTALL_PATH"
trap - EXIT
echo "yt-dlp: installed $YT_DLP_VERSION at $YT_DLP_INSTALL_PATH"
