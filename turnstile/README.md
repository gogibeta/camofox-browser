# Turnstile auto-solve kit for camofox-browser

A self-contained Turnstile solver that runs on top of this camofox-browser fork.
No third-party captcha API, no Apify dependency for the extension path.

## What is here

| Path | What it is |
| --- | --- |
| `turnstile/install.sh` | One-shot installer: deps, config, plugins, solver, headed server |
| `solver/camofox_solve.py` | Python solver driving the camofox HTTP API |
| `solver/camofox_solve.rs` | Same solver in std-only Rust (fastest wall time) |
| `extension/` | Chrome MV3 + Firefox MV2 auto-solve extension |
| `turnstile/plugins/ipv4fix.js` | Forces IPv4 DNS + relaxes tracking protection |
| `turnstile/deploy_instabox.py` | Upload the kit to an InstaBox VM over its exec API |
| `turnstile/vm_ext_test.py` | End-to-end extension test in a headed browser |

## Install

```bash
git clone https://github.com/gogibeta/camofox-browser.git
cd camofox-browser
bash turnstile/install.sh
```

That single command installs node deps, writes `camofox.config.json`, installs
the `ipv4fix` plugin, stages the extension and solvers into `/data/workspace`,
compiles the Rust solver when `rustc` is present, and starts a headed browser on
`DISPLAY=:1` bound to `127.0.0.1:9377`. Wait for `HEALTH OK`.

`turnstile/vm_setup_camofox.sh` does the same thing from a VM that already has
the old stack, and clones **this fork** (override with `CAMOFOX_REPO_URL` /
`CAMOFOX_REPO_BRANCH`). It fails loudly if the checkout has no `solver/` or
`extension/`, because a browser without the kit cannot auto-solve.

Install only, without starting the server:

```bash
bash turnstile/install.sh --no-start
```

Re-running is safe; it is idempotent, and it re-stages the solver so a re-install
never keeps an old copy running.

## Solve from the command line

```bash
CFG='{"url":"https://demo.turnstile.workers.dev/","timeoutMs":45000}'
ARG=$(printf '%s' "$CFG" | base64 -w0)
python3 /data/workspace/camofox_solve.py "$ARG"      # Python
/data/workspace/camofox_solve_rust "$ARG"            # Rust (if compiled)
```

One JSON line comes back:

```json
{"token":"XXXX.DUMMY.TOKEN.XXXX","durationMs":7038,"error":null,
 "method":"camofox-browser","popupClosed":0,"clicked":true,"url":"..."}
```

## Which engine runs by default

**The extension runs the Python solver.** `extension/background.js` defaults to
`solverPath: /data/workspace/camofox_solve.py` with
`solverPython: /data/workspace/camoufox-venv/bin/python`, and the popup exposes
both fields if you want to change them.

The Rust solver is installed alongside it at `/data/workspace/camofox_solve_rust`
and is faster (~8.4s vs ~9.5s in the measurements below), but it is **opt-in**:
set `solverPath` to `/data/workspace/camofox_solve_rust` and clear `solverPython`
in the extension popup. The installer always compiles it when `rustc` is present,
so switching is a config change, not a reinstall.

| Engine | Path | Default for | Typical wall |
| --- | --- | --- | --- |
| Python | `camofox_solve.py` | the extension | 9.4–9.6 s |
| Rust | `camofox_solve_rust` | command line / opt-in | 8.3–8.9 s |

Both drive the same camofox-browser HTTP API on `127.0.0.1:9377`; neither talks
to Apify.

## How the click works (the part that took the longest)

Turnstile mounts its challenge iframe inside a **closed shadow root**, so
`document.querySelectorAll('iframe')` returns nothing even while the widget is
live. The solver therefore targets the widget's light-DOM host element:

1. Find the tightest visible box among
   `.cf-turnstile[data-sitekey]`, `[data-sitekey]`, `.cf-turnstile`,
   `[id^=cf-turnstile]`, `[class*=turnstile]`.
2. Scroll it into view with `behavior: 'instant'` — **in a separate call**.
   Pages using `scroll-behavior: smooth` animate `scrollIntoView`, and a rect
   measured in the same tick is pre-scroll, so the click lands on empty space.
3. Wait ~400 ms, measure again, then click `left + 30`, vertical centre — the
   checkbox, not the label text.
4. Poll `input[name=cf-turnstile-response]` until it has a value.

The click is retried up to 4 times, 4 s apart. A cold browser has no clickable
widget iframe for the first second or two, so a single attempt was too few; but
clicking for the whole timeout adds stray clicks to a challenge that is already
solving.

Clicking the host by CSS selector instead would click its **centre**, which is
the label. That passes on some sites and silently fails on others.

## Benchmarks

InstaBox VM, 4 vCPU / 8 GB, headed Camoufox, 2 rounds each, all passing:

| Site | Python wall | Rust wall |
| --- | --- | --- |
| demo.turnstile.workers.dev | 13.7 s | **8.8 s** |
| solvegate.io/demo/managed | 16.4 s | **11.8 s** |
| 100milionseek.top/recover | 16.2 s | **11.9 s** |
| elysium.kinetiq.xyz faucet | 18.9 s | **10.8 s** |
| 2captcha.com demo | 19.3 s | — |

Per-solve Cloudflare time is identical (~6–9 s) in both languages. Rust wins on
wall time because it reuses one keep-alive HTTP connection to camofox-browser
instead of opening a new TCP connection per evaluate/click (~10 per solve).
A naive Rust client that reconnects each request is **slower** (26 s).

## Sites that cannot be solved

`nopecha.com/captcha/turnstile` loads `turnstile/v0/api.js` twice, so Cloudflare
answers `Error: 400070` ("Turnstile already loaded") and both widgets stay empty.
Reproduced in a clean headed Chromium with the duplicate request blocked. This is
a page bug; no solver can fix a page that never renders a widget.

## Operations notes

- Keep `BROWSER_RSS_RESTART_THRESHOLD_MB=6000` and
  `NATIVE_MEM_RESTART_THRESHOLD_MB=3000`. The defaults (1500) restart the browser
  mid-solve once RSS passes ~1.7 GB.
- The plugin config filename is `camofox.config.json` (camoFOX). A file named
  `camoufox.config.json` is silently ignored and plugins never load.
- `/tabs/:id/evaluate` runs in an **isolated world**. `window.turnstile` is
  undefined there while an injected `<script>` in the page sees the real object.
  Never trust `evaluate()` globals for page JS state.
- `evaluate` requires a JS expression; wrap probes in IIFEs, not bare arrow
  functions.

## Extension

Chrome / Edge / Chromium (MV3): `chrome://extensions` → Developer mode → Load
unpacked → select `extension/`.

Firefox / Camoufox (MV2): `about:debugging#/runtime/this-firefox` → Load
Temporary Add-on → select `extension/manifest-firefox.json`.

Open the popup, confirm the backend is `instabox`, and paste your InstaBox API
key. The key lives in extension storage and is never in the source.

Verify end to end on the VM:

```bash
python3 /data/workspace/vm_ext_test.py test   # expects XXXX.DUMMY.TOKEN.XXXX
python3 /data/workspace/vm_ext_test.py real   # expects a real token
```
