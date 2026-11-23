# Captcha auto-solve kit for camofox-browser

A self-contained solver for Turnstile, Cloudflare Managed Challenges, and the
other captcha families a page can put in front of you, running on top of this
camofox-browser fork. No third-party captcha API, and no Apify dependency for
the extension path.

Coverage is honest rather than total: it clears Cloudflare, it notices captchas
that solve themselves, and it **reports** the ones that need a human instead of
pretending. The table below is the real behaviour, measured.

## What is here

| Path | What it is |
| --- | --- |
| `turnstile/install.sh` | One-shot installer: deps, config, plugins, solver, headed server |
| `solver/camofox_solve.rs` | The solver: std-only Rust, compiled on install |
| `solver/camofox_solve.py` | Same solver in Python, kept as a readable reference (not installed) |
| `plugins/captchafix/` | Makes Cloudflare challenges solvable at all, and clears them in-process |
| `extension/` | Chrome MV3 + Firefox MV2 auto-solve extension |
| `turnstile/deploy_instabox.py` | Upload the kit to an InstaBox VM over its exec API |
| `turnstile/vm_ext_test.py` | End-to-end extension test in a headed browser |

## Install

```bash
git clone https://github.com/gogibeta/camofox-browser.git
cd camofox-browser
bash turnstile/install.sh
```

That single command installs node deps, writes `camofox.config.json`, checks the
`captchafix` plugin is present, stages the extension into `/data/workspace`,
compiles the Rust solver (failing loudly if `rustc` is missing), and starts a
headed browser on `DISPLAY=:1` bound to `127.0.0.1:9377`. It then waits for
`HEALTH OK` **and** verifies the plugin actually loaded, because a healthy
server without it still cannot clear a challenge.

`turnstile/vm_setup_camofox.sh` does the same thing from a VM that already has
the old stack, and clones **this fork** (override with `CAMOFOX_REPO_URL` /
`CAMOFOX_REPO_BRANCH`). It fails loudly if the checkout has no
`solver/camofox_solve.rs` or `extension/`, because a browser without the kit
cannot auto-solve.

Install only, without starting the server:

```bash
bash turnstile/install.sh --no-start
```

Re-running is safe; it is idempotent, and it recompiles the solver so a re-install
never keeps an old binary running.

If `turnstile/install.sh` is run from a checkout that is not at
`/data/workspace/camofox-browser`, set `WS` and `REPO`:

```bash
WS=/data/workspace REPO=$PWD bash turnstile/install.sh
```

## Solve from the command line

```bash
CFG='{"url":"https://demo.turnstile.workers.dev/","timeoutMs":45000}'
ARG=$(printf '%s' "$CFG" | base64 -w0)
/data/workspace/camofox_solve_rust "$ARG"            # the installed engine
```

One JSON line comes back:

```json
{"token":"XXXX.DUMMY.TOKEN.XXXX","clearance":null,"result":"token",
 "captcha":"turnstile","challenge":false,"durationMs":7038,"error":null,
 "method":"camofox-rust","clicked":true,"url":"..."}
```

`result` is `token` (a captcha answer), `clearance` (a Cloudflare challenge was
cleared and the cookie is in `clearance`), or `none`. `captcha` names the provider
that answered, so a caller never has to infer a token's kind from its shape.

## Which captchas this can clear

This is a property of the captcha, not of the code, and it is worth being blunt
about it. There are three buckets:

| Bucket | Captchas | What actually happens |
| --- | --- | --- |
| **Clears** | Turnstile, Cloudflare Managed Challenge, FriendlyCaptcha | The plugin clicks the challenge frame in-process and it passes in 4–8 s. This is the part that is genuinely automated. |
| **Self-solving** | reCAPTCHA v3 (invisible) | Nothing to click. It resolves on its own given a browser that does not look automated, and the plugin notices within 1 s. |
| **Reported, not solved** | hCaptcha checkbox, reCAPTCHA v2 checkbox, hCaptcha / reCAPTCHA v2 **image grids**, GeeTest sliders, Arkose FunCaptcha, AWS WAF, DataDome | The plugin finds and clicks the checkbox, and the provider then opens a puzzle. The answer to a puzzle is not in the DOM, so nothing browser-side can produce it. The plugin says so instead of clicking at tiles blindly. |

The third row is the honest limit, and it was measured rather than assumed:

- A **page-coordinate** click (`POST /tabs/:id/click`) does not even toggle an
  hCaptcha or reCAPTCHA checkbox. The click is delivered (the route returns
  `ok: true`) and the checkbox stays unchecked.
- A click driven **inside the frame** does toggle it. hCaptcha then swaps the
  302×76 checkbox for a panel within ~5 s; reCAPTCHA opens its 300×480 bframe
  within ~2 s. At that point the widget is a puzzle and the plugin stops.
- Those demo widgets are configured to challenge every visitor, so "it opened a
  puzzle" is the expected result on them, not a failure to click.

Clicking a puzzle is worse than doing nothing: it makes the page harder for a
real person to finish and it can look like abuse. The plugin tells a checkbox
from a puzzle by geometry (a checkbox is a short strip or a 76×76 square; a grid
is a panel), which is the only signal available since the puzzle itself is
cross-origin.

On the solver side, every provider whose answer *is* a DOM string is read:
`cf-turnstile-response`, `h-captcha-response`, `g-recaptcha-response`,
`frc-captcha-response`, `geetest_validate`, `fc-token`, `aws-waf-token`, plus
`window.hcaptcha.getResponse()` / `window.grecaptcha.getResponse()`. The reply
carries `captcha` (which provider answered) next to `token`, so a caller never
has to guess a token's kind from its shape.

When the solver finds a widget, clicks it, and no token appears, it stops after
4 attempts plus a 6 s grace period and returns
`captcha widget found and clicked, but it needs a human (image grid or slider)`
in `error` — rather than running out the caller's full timeout and implying a
provider outage.

## How the plugin decides what to do

Every provider has an entry in one table, and the entry decides three things:
how to answer it, which frame to click, and where the answer lands.

| Provider | `kind` | Strategy | Click order |
| --- | --- | --- | --- |
| Cloudflare Turnstile | `turnstile` | `click` | outer frame first |
| Cloudflare Managed Challenge | `cf-managed` | `click` | outer frame first |
| hCaptcha | `hcaptcha` | `click` | inner checkbox first |
| reCAPTCHA v2 | `recaptcha-v2` | `click` | inner checkbox first |
| FriendlyCaptcha | `friendlycaptcha` | `click` (starts the proof of work) | inner checkbox first |
| reCAPTCHA v3 | `recaptcha-v3` | `wait` (invisible) | — |
| GeeTest | `geetest` | `human` (slider) | — |
| Arkose FunCaptcha | `funcaptcha` | `human` | — |
| AWS WAF | `awswaf` | `human` | — |
| DataDome | `datadome` | `human` | — |
| Image grid | `image-grid` | `human` | — |

**Click order is per provider, and it is not cosmetic.** Cloudflare wants the
outer frame element clicked first: poking the inner checkbox leaves the widget
in a loading overlay that then swallows the real click. hCaptcha and reCAPTCHA
are the opposite — their puzzle panel covers the parent frame element, so a
parent-side click hits the panel and the checkbox never toggles. That is why the
order lives in the table rather than in one shared code path.

**Turnstile and a managed challenge cannot be told apart by frame URL.** Both
load `.../cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/<id>`, so the plugin
asks the page instead:

1. a `.cf-turnstile` element or any `[data-sitekey]` → `turnstile`;
2. otherwise `window._cf_chl_opt`, or a narrow interstitial title → `cf-managed`;
3. otherwise `turnstile`.

The page title check is anchored and deliberately narrow (`just a moment`,
`verify you are human`, `checking your browser`, `attention required`, …). An
unanchored match turns a site literally titled "Cloudflare Turnstile Managed
Demo" into an interstitial and sends the plugin looking for a cookie that will
never appear.

**A checkbox is not a puzzle.** After a click the plugin measures the widget
again. A panel (`height >= 220`, or `width >= 320 && height >= 180`) means the
provider opened a puzzle; the plugin logs `captcha opened a puzzle` and stops.
A click that is merely intercepted while no panel is present is retried, because
a transient overlay and a real puzzle produce the same Playwright error.

**A non-empty response field is not an answer.** FriendlyCaptcha writes state
markers into the very field that later holds its solution: `.UNCONNECTED` while
the frame loads, then `.UNACTIVATED` until the proof of work runs. Both are
12-character strings, so a length or truthiness check reads one as a solved
captcha. Measured on the demo page: the field sat at `.UNACTIVATED` for 27 s of
polling and only produced a real 6.4 KB solution ~3 s after an actual click. The
plugin therefore rejects any dot-prefixed capital marker as a value, and
FriendlyCaptcha's strategy is `click` rather than `wait` — the widget is inert
until it is clicked. Before that fix the plugin reported "captcha answered" in
7 ms with zero clicks, which was simply false.

**A widget below the fold is still a widget.** FriendlyCaptcha's demo widget sits
at y=2376 in a 372 px-tall window. A solver that only inspects the viewport finds
nothing, declines to click, and reports "no captcha" on a page that plainly has
one — which is what the Rust engine did until it learned to `scrollIntoView` a
candidate before measuring it. The plugin never had this bug for a different
reason: Playwright's `frameElement().click()` scrolls on its own.

## Turnstile widgets vs Cloudflare Managed Challenges

These are two different problems, and the kit handles both.

| | Turnstile widget | Managed Challenge |
| --- | --- | --- |
| Page has `data-sitekey` | yes | **no** |
| `.cf-turnstile` element | yes | **no** (0 found) |
| `window.turnstile` | undefined on every site tested | undefined too — **no signal at all** |
| Success signal | token in `cf-turnstile-response` | `cf_clearance` cookie only |
| `_cf_chl_opt` | absent | present |

The frame URLs are also identical: both load
`challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/…`,
so a frame URL cannot tell them apart either. That is why the plugin decides from
the page (see the `cloudflareKind` rules above) before it logs a `kind`.

A managed challenge is not a widget, so a widget-targeted solver reports "no
sitekey" and does nothing. It also is not solvable by clicking page
coordinates: the checkbox lives in a **cross-origin child frame**, and a
coordinate click moves the mouse without ever reaching it. Measured on a real
site, a coordinate click lands (`trusted: true`), the screenshots are
byte-identical and the title never changes.

Two things had to be fixed, and both live in the `captchafix` plugin:

1. **The challenge iframe never existed.** Camoufox's defaults keep COOP on, so
   `challenges.cloudflare.com` is never framed: zero iframes, zero sitekeys,
   stuck on "Just a moment..." for as long as you wait. Setting
   `browser.tabs.remote.useCrossOriginOpenerPolicy = false` makes the iframe
   appear, and it then clears in ~6 s. This one pref is the whole difference —
   verified by toggling it alone.
2. **Coordinate clicks cannot solve it.** Clicking the frame *element* through
   Playwright clears a widget in ~1 s and a managed challenge in ~3 s. So the
   plugin solves challenges in-process, where it has the real `Page`, instead of
   going through the HTTP `/click` route.

The plugin watches `tab:created` and `tab:navigated`, and for any tab showing an
interstitial or a captcha widget it polls for a token or a `cf_clearance` cookie,
clicking the widget up to 5 times, 3 s apart, until one appears or 45 s elapse.

The solver cooperates: it reports `challenge: true` and returns the
`cf_clearance` value in a `clearance` field, so a caller does not have to know
which kind of gate it hit.

## Which engine runs

**There is one engine: the Rust solver.** `extension/background.js` defaults to
`solverPath: /data/workspace/camofox_solve_rust` with an empty `solverPython`, so
the binary is executed directly. The popup exposes both fields if you need to
point at something else, but the installer only ever produces the Rust binary.

Shipping both engines had no point: two code paths to keep in sync, two things to
debug, and only one of them ever ran. The Python solver stays in `solver/` as a
readable reference and is **not installed**.

| Engine | Path | Installed | Typical wall |
| --- | --- | --- | --- |
| Rust | `camofox_solve_rust` | always (the only one) | 8.1–9.0 s |
| Python | `camofox_solve.py` | no — reference only | 9.4–9.6 s |

`rustc` is therefore a hard requirement: the installer fails loudly rather than
starting a browser that cannot solve. Both engines drive the same camofox-browser
HTTP API on `127.0.0.1:9377`; neither talks to Apify.

## How the click works (the part that took the longest)

There are two different click problems, and they need two different mechanisms.

**Cloudflare challenges.** Turnstile mounts its challenge iframe inside a
**closed shadow root**, so `document.querySelectorAll('iframe')` returns nothing
even while the widget is live, and a page-coordinate click never reaches it.
Inside the browser process, Playwright can click the frame *element*, which
works: ~1 s for a Turnstile widget, ~3 s for a managed challenge.

The solver, out-of-process over HTTP, has only `/tabs/:id/click` with viewport
coordinates, so for a challenge it leaves the first pass to the plugin and only
falls back to a coordinate click on later passes. That fallback is best-effort:
measured on a real interstitial, the coordinate click lands (`trusted: true`),
the screenshots are byte-identical and the title never changes.

For a Turnstile **widget** in the light DOM the solver still clicks by itself:

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

**hCaptcha and reCAPTCHA.** Their parent frame is covered by a puzzle panel, so
a parent-side click hits the panel, not the checkbox. The plugin therefore
clicks the checkbox *inside* the frame (Playwright drives a cross-origin child
frame directly). That is the only way to toggle it, and it is still not enough to
answer it: the provider responds by opening a puzzle.

## Benchmarks

InstaBox VM, 4 vCPU / 8 GB, headed Camoufox, all passing. The Rust column is what
actually runs now; the Python column is the reference implementation.

| Site | What it is | Plugin (in-process) | Solver (Rust) |
| --- | --- | --- | --- |
| solvegate.io/demo/managed | Turnstile widget | answered 4.3–5.6 s | token, 645 chars, 5.5–6.9 s |
| 100milionseek.top/recover | Turnstile widget | answered 4.3–5.6 s | token, 666 chars, 7.5–8.6 s |
| demo.turnstile.workers.dev | Turnstile widget | — | token, 8.8 s |
| free.nodaroo.com | Managed Challenge | cleared 4.9–8.9 s | clearance, 5.7–7.5 s |
| glassdoor.com | Managed Challenge | cleared 2.4–8.2 s | clearance, 5.7–7.5 s |
| friendlycaptcha.com/demo | FriendlyCaptcha | answered 7.3–9.6 s, 1 click | token, 6421 chars, 12.8–15.4 s |
| accounts.hcaptcha.com/demo | hCaptcha | clicked, then puzzle (5.4 s) | no token, reported at 27 s |
| google.com/recaptcha/api2/demo | reCAPTCHA v2 | clicked, then puzzle (2.0 s) | no token, reported at 25 s |

Every Cloudflare row was measured with a **fresh `userId`** per run, so no
persisted cookie could make a pass look real. The two puzzle rows are expected
outcomes, not regressions: those demo widgets challenge every visitor.

Last full run against the committed code:

```
nodaroo (plugin)      cleared 6.8 s
glassdoor (plugin)    cleared 7.8 s
solvegate (plugin)    answered 3.6 s
100milionseek         answered 4.8 s
hCaptcha (plugin)     clicked, then puzzle, reported 6.3 s
reCAPTCHA v2 (plugin) clicked, then puzzle, reported 2.1 s
friendlycaptcha       answered 7.3 s, 1 click
nodaroo (solver)      clearance, 6.2 s, captcha=cf-managed
glassdoor (solver)    clearance, 7.0 s, captcha=cf-managed
solvegate (solver)    token, 645 chars, 6.1 s, captcha=turnstile
100milionseek         token, 666 chars, 9.0 s, captcha=turnstile
friendlycaptcha       token, 6421 chars, 12.8 s, captcha=friendlycaptcha
hCaptcha (solver)     no token, reported at 28 s
reCAPTCHA v2 (solver) no token, reported at 27 s
```

Fresh-install measurement on a wiped VM: **5/5 on solvegate at 8.1–8.4 s**.

Extension end to end, MV3 loaded unpacked in a headed Chromium, against the
committed extension:

```
100milionseek  OK 14.3 s   browser-up 0.5s, page-loaded 2.1s, answered 14.3s
solvegate      OK 10.0 s   browser-up 0.5s, page-loaded 0.9s, answered 10.0s
```

`vm_ext_test.py` prints that `TIMELINE`, so a slow run can be attributed instead
of guessed at. The first run against a cold box once took 42 s; it was the VM
exec call being cold, not the extension (the same run a minute later was 10 s).
Run it twice before believing a slow number.

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
python3 /data/workspace/vm_ext_test.py real     # 100milionseek, real token
python3 /data/workspace/vm_ext_test.py second   # solvegate, real token
```

It prints `RESULT ... OK`, the answering provider as `CAPTCHA_KIND`, and a
`TIMELINE` of browser-up / config-set / page-loaded / answered. It needs a
Playwright Chromium (`playwright install chromium`), which it locates by glob
rather than by a hardcoded build number; `CHROME_PATH` overrides it.
