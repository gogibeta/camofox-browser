# LESSONS

Append-only. One line per lesson, in `TRIGGER -> RULE` form. Never rewrite
history; add a new line if a rule changes.

## Cloudflare Managed Challenge

- Interstitial stays on "Just a moment..." for ever, zero iframes, zero sitekeys on the challenge page -> Set `browser.tabs.remote.useCrossOriginOpenerPolicy = false` (camoufox-js calls this `disable_coop`). It is the single essential pref: with it the challenge frame is created and clears in ~6 s, without it the frame never exists at all.
- `document.querySelectorAll('iframe')` returns 0 on a page that visibly has a challenge widget -> The frame lives in a **shadow root**. Use `page.frames()` (which sees through it) or walk shadow roots explicitly; light-DOM queries cannot find it.
- Page-coordinate click (`POST /tabs/:id/click`) returns `ok: true`, screenshots are identical, title never changes -> The widget is in a **cross-origin child frame** and a synthesized page click cannot cross that boundary. Click the frame *element* through Playwright (`frame.frameElement()` then `.click({position})`), which clears in 1-3 s.
- A coordinate click on a challenge hangs for ~28 s and the solve then reports `410 browser_restarted` -> `native mouse move timed out after 28000ms` surfaces as a misleading restart. Treat a long click as a failed click, and prefer the in-process plugin over any coordinate click on an interstitial.
- Challenge iframe URL is `.../cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/...` for **both** a Turnstile widget and a Managed Challenge -> A frame URL cannot tell them apart, and `window.turnstile` is not a discriminator either (each page ships its own definition; it was `undefined` on all three test sites). Decide from the page: a `.cf-turnstile` container or `data-sitekey` means widget; challenge-wording title with neither means interstitial.
- Solver wall time (20.7 s) far exceeds its own internal measurement (5.6 s) -> `xdotool windowactivate --sync` blocks ~15 s. Spawn xdotool detached with stdio nulled and without `--sync`; `fullscreen_desktop` drops from 15 s to 4 ms.
- A captcha "needs a human" but the log says nothing -> Distinguish a **checkbox** (a short strip or a 76x76 square) from a **puzzle panel** (height >= 220, or width >= 320 and height >= 180) and say which one was seen. Clicking puzzle tiles blindly is worse than doing nothing.
- hCaptcha exposes a 302x76 visible checkbox **and** a 300x150 container parked at `y=-9999` -> `page.frames()` may list the off-screen one first. Rank candidate frames by whether their box is actually on screen before clicking.
- The checkbox is ~28 px from the frame's left edge, vertically centred -> Do not use a proportional offset. `width * 0.15` = 46 px on a 304 px widget lands on the label text and never toggles the box.
- An inner click on a Cloudflare challenge leaves the widget in a loading state whose overlay swallows the frame-element click -> Click the frame element first for Cloudflare; click the inner checkbox first (and only) for hCaptcha/reCAPTCHA, whose parent frame is covered by the puzzle panel.
- An `intercepts pointer events` click error is treated as "needs a human" -> Only when a puzzle panel is actually on screen. Otherwise retry; a transient overlay produces the same message.
- Plugin reports `captcha answered` in a few ms with **zero clicks** on FriendlyCaptcha -> Its `frc-captcha-response` field holds state markers, not solutions: `.UNCONNECTED` while the frame loads, then `.UNACTIVATED` until the proof of work runs. Both are 12 chars, so any length/truthiness check reads one as a solved captcha. Reject dot-prefixed capital markers as values (`/^\.[A-Z][A-Z_]*:?$/`) and give the provider a `click` strategy: measured on the demo page the field stayed at `.UNACTIVATED` for 27 s and produced a real 6.4 KB solution ~3 s after an actual click.
- A benign site banner sits over a captcha checkbox and the plugin reports "needs a human" -> The click is intercepted by a site-wide panel (an incident report, a cookie bar), not by a puzzle. Check for a puzzle panel **first** (and `await` it -- an un-awaited DOM read returns a Promise, which is always truthy), then look for a real close control and retry.
- `if (puzzlePanel(page))` is silently always true -> Any async helper returns a Promise; a Promise is truthy, so the branch fires every time. Every async predicate needs `await`, and a linter will not catch a conditional it is not configured for.
- A deployed binary returns only `token` while the source clearly writes `result`/`captcha` -> The binary was built before the source changed. Rebuild from the uploaded source and print its SHA next to the local one; a stale build looks exactly like a code bug.
- A solver reports "no captcha" on a page that visibly has one -> The widget is below the fold and the finder rejects off-screen elements. `scrollIntoView({block:'center'})` before measuring, then re-measure: FriendlyCaptcha's demo widget sits at y=2376 in a 372 px viewport. The plugin never hit this because Playwright's `frameElement().click()` scrolls by itself.

## Testing

- A plugin test passes after a previous run -> Session state is restored from `~/.camofox/persistence` by `userId`. Use a **fresh `userId`** per run, or the old `cf_clearance` does the work.
- A Turnstile widget page is probed for `cf_clearance` and reported as failed -> A widget sets no `cf_clearance`; it answers with a token. Check both signals: a cookie *or* a populated response field.
- Plugin edits have no effect on the running server -> Plugin modules are loaded at startup. Restart the server after changing a plugin file.
- Prose in a repo file shows mangled dashes and quotes after an edit -> A PowerShell `Get-Content`/`Set-Content` round-trip goes through cp1252 and re-encodes UTF-8, and may prepend a BOM. Edit UTF-8 files with the edit/write tools or Python, and check for the cp1252 lead bytes before committing.

## Install path

- Wiped box, one command, still "ready" but nothing solved -> NEVER trust a
  health check alone. `captchafix OK` in the install log is the only proof the
  plugin loaded; a healthy server without it clears nothing.
- `install-plugin-deps` logged `no plugins dir at /app/plugins` on a VM ->
  `sudo` scrubs the caller's environment, so `VAR=x sudo sh script` loses the
  VAR. Pass it as `sudo env VAR=x sh script`.
- Config lost `vnc` / `interactive.mode` reset to `off` after a re-deploy ->
  never `cat >` a config file. Merge it (`scripts/merge-camofox-config.mjs`).
  `interactive.mode` decides whether a challenge click lands.
- `xdotool` missing is silent -> the solver raises and sizes the
  Camoufox window before clicking, because a background window swallows the OS
  pointer event. `plugins/captchafix/apt.txt` declares it.
- A plugin enabled but its dep absent (`yt-dlp`) -> the plugin loads and
  degrades silently. `scripts/install-plugin-deps.sh` must run on the VM, not
  only in Docker.

## Extension

- `instaboxMachineId` ended with `\r` -> `fetch()` rejected the URL while the
  popup looked configured. Strip `[\r\n]` from every string config value on
  both the writer (install.sh) and the reader (`cleanValue` in background.js).
- `/tabs/:id/evaluate` with a bare arrow function returns `undefined` ->
  it takes an *expression*. Wrap probes in an IIFE.
- `page.evaluate` cannot see content-script globals -> content scripts run in
  an isolated world, so `window.__turnstileAutoSolverLoaded` is always false
  from the page. Verify through the DOM field or the extension's own message.
- Apify kit's `extension/` drifted 143 lines from the fork -> keep it
  byte-identical; two copies of a solver solve differently.
