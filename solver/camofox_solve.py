#!/usr/bin/env python3
"""InstaBox-side Turnstile solver that drives OUR camofox-browser server.

No Apify, no direct Playwright connection. This script calls the local
camofox-browser HTTP API (default http://127.0.0.1:9377), opens the target
page in a headed Camoufox window on DISPLAY=:1, dismisses the Cloudflare
outage popup once, clicks the Turnstile widget, and polls for the token.

Input : base64 JSON on argv[1] (or raw JSON on stdin)
        { "url", "siteKey", "action", "cdata", "timeoutMs", "camofoxUrl" }
Output: one compact JSON line
        { "token", "durationMs", "error", "method", "popupClosed", "clicked", "url" }
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

DEFAULT_CAMOFOX = "http://127.0.0.1:9377"
USER_ID = "turnstile-solver"
# Click at most this many times per solve. A widget that has not accepted a click
# by then is not going to; more clicks only add noise to the challenge.
MAX_CLICK_ATTEMPTS = 4

# NOTE: camofox evaluate() takes a JS *expression* string, so these must be
# immediately-invoked function expressions (IIFEs), not bare arrow functions.
CLOSE_POPUPS_JS = """(() => {
  const vis = e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  let n = 0;
  document.querySelectorAll('#outage,[role=dialog],dialog,.modal,.popup').forEach(e => {
    if (vis(e) && !e.hidden) {
      e.hidden = true;
      e.style.setProperty('display', 'none', 'important');
      n++;
    }
  });
  document.querySelectorAll('[data-apology-close],[data-outage-close],[data-close],[aria-label*=Close i]')
    .forEach(e => { try { e.click(); n++; } catch (_) {} });
  return n;
})()"""

TOKEN_JS = """(() => {
  const e = document.querySelector('input[name=cf-turnstile-response]');
  return e && e.value ? e.value : '';
})()"""

# Turnstile mounts its challenge iframe inside a CLOSED shadow root, so
# document.querySelectorAll('iframe') never sees it. The .cf-turnstile host is
# in the light DOM though, and its bounding box is the click target.
#
# Two mount styles must both work:
#   <div class="cf-turnstile" data-sitekey="...">      implicit render
#   <div id="cf-turnstile">                            explicit turnstile.render()
# The explicit form has no data-sitekey attribute, so matching on data-sitekey
# alone silently finds nothing and the solver never clicks.
#
# Scrolling and measuring MUST be separate calls. Pages with CSS
# `scroll-behavior: smooth` animate scrollIntoView, so a rect read in the same
# tick is measured against the pre-scroll position and the click lands on
# whatever used to be there (this is why 2captcha failed only after another tab
# had already scrolled the shared page).
WIDGET_FIND_FN = """function() {
  const vis = e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' &&
      r.width >= 150 && r.height >= 40;
  };
  const seen = new Set();
  const cands = [];
  const add = e => {
    if (!e || seen.has(e) || !vis(e)) return;
    seen.add(e);
    cands.push(e);
  };
  document.querySelectorAll('.cf-turnstile[data-sitekey], [data-sitekey]').forEach(add);
  document.querySelectorAll(
    '.cf-turnstile, [id^=cf-turnstile], [class*=turnstile]'
  ).forEach(add);
  if (!cands.length) return null;
  // Prefer the tightest box: a wrapper can be 100% wide, the widget is ~300px.
  cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  return cands[0];
}"""

# Step 1: scroll instantly (override any smooth scroll-behavior).
WIDGET_SCROLL_JS = """(() => {
  const find = %s;
  const el = find();
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  if (!inView) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
  return true;
})()""" % WIDGET_FIND_FN

# Step 2: measure only, no scrolling. Click the checkbox at the left edge,
# vertically centred in the ~65px widget.
WIDGET_RECT_JS = """(() => {
  const find = %s;
  const el = find();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 150 || r.height < 40) return null;
  return {
    x: Math.round(Math.max(1, Math.min(r.left + 30, r.right - 2))),
    y: Math.round(Math.max(1, Math.min(r.top + r.height / 2, r.bottom - 2))),
  };
})()""" % WIDGET_FIND_FN


def get_args() -> dict:
    raw = (sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()).strip()
    try:
        return json.loads(base64.b64decode(raw, validate=True))
    except Exception:
        return json.loads(raw)


def fullscreen_desktop() -> None:
    """Keep the Camoufox window filling the desktop."""
    try:
        env = dict(os.environ, DISPLAY=":1")
        windows = subprocess.run(
            ["xdotool", "search", "--class", "camoufox"],
            env=env, capture_output=True, text=True, timeout=5,
        ).stdout.strip().splitlines()
        if not windows:
            return
        win = windows[-1]
        subprocess.run(["xdotool", "windowactivate", "--sync", win], env=env, timeout=5)
        subprocess.run(["xdotool", "windowsize", win, "1530", "619"], env=env, timeout=5)
        subprocess.run(["xdotool", "windowmove", win, "0", "0"], env=env, timeout=5)
    except Exception:
        pass


class Camofox:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.session = "solve-" + uuid4().hex[:10]

    def call(self, method: str, path: str, payload: dict | None = None, timeout: int = 30):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"camofox HTTP {exc.code} on {path}: {detail}") from None

    def open(self, url: str) -> str:
        res = self.call("POST", "/tabs", {
            "userId": USER_ID, "sessionKey": self.session, "url": url,
        }, timeout=60)
        tab = res.get("tabId") or res.get("tab_id") or res.get("id")
        if not tab:
            raise RuntimeError(f"camofox /tabs returned no tabId: {str(res)[:300]}")
        return str(tab)

    def evaluate(self, tab: str, expression: str, timeout: int = 8):
        return self.call("POST", f"/tabs/{tab}/evaluate", {
            "userId": USER_ID, "expression": expression, "timeoutMs": timeout * 1000,
        }, timeout=timeout + 10).get("result")

    def click_xy(self, tab: str, x: int, y: int) -> None:
        self.call("POST", f"/tabs/{tab}/click", {
            "userId": USER_ID, "coordinates": {"x": x, "y": y},
        }, timeout=12)

    def click_selector(self, tab: str, selector: str) -> None:
        # Playwright scrolls the live element into view and re-resolves its
        # position at click time. Coordinate clicks are stale when the page
        # animates scrollIntoView, so prefer selectors for the widget host.
        self.call("POST", f"/tabs/{tab}/click", {
            "userId": USER_ID, "selector": selector,
        }, timeout=12)


def solve(cfg: dict) -> dict:
    url = cfg["url"]
    timeout = int(cfg.get("timeoutMs") or 45000)
    camofox = Camofox(cfg.get("camofoxUrl") or DEFAULT_CAMOFOX)

    t0 = time.perf_counter()
    token = ""
    popup_closed = 0
    clicked = False
    next_click_at = 0.0
    click_attempts = 0
    tab = None
    error = None

    try:
        tab = camofox.open(url)
        time.sleep(4)

        try:
            popup_closed = int(camofox.evaluate(tab, CLOSE_POPUPS_JS) or 0)
        except Exception:
            popup_closed = 0
        time.sleep(1)

        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            try:
                token = camofox.evaluate(tab, TOKEN_JS, timeout=5) or ""
            except Exception:
                token = ""
            if token:
                break

            if click_attempts < MAX_CLICK_ATTEMPTS and time.monotonic() >= next_click_at:
                next_click_at = time.monotonic() + 4.0
                click_attempts += 1
                try:
                    camofox.evaluate(tab, WIDGET_SCROLL_JS, timeout=5)
                except Exception:
                    pass
                time.sleep(0.4)
                try:
                    rect = camofox.evaluate(tab, WIDGET_RECT_JS, timeout=5)
                    if rect and "x" in rect and "y" in rect:
                        camofox.click_xy(tab, rect["x"], rect["y"])
                        clicked = True
                except Exception:
                    pass
            time.sleep(0.35)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        if tab:
            try:
                camofox.call("DELETE", f"/tabs/{tab}?userId={USER_ID}", timeout=10)
            except Exception:
                pass

    if not token and not error:
        error = "No token returned before timeout"

    return {
        "token": token or None,
        "durationMs": round((time.perf_counter() - t0) * 1000),
        "error": error,
        "method": "camofox-browser",
        "popupClosed": popup_closed,
        "clicked": clicked,
        "url": url,
    }


def main() -> None:
    cfg = get_args()
    fullscreen_desktop()
    try:
        result = solve(cfg)
    except Exception as exc:
        result = {"token": None, "durationMs": 0,
                  "error": f"{type(exc).__name__}: {exc}",
                  "method": "camofox-browser"}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
