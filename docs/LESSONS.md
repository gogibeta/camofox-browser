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

## Testing

- A plugin test passes after a previous run -> Session state is restored from `~/.camofox/persistence` by `userId`. Use a **fresh `userId`** per run, or the old `cf_clearance` does the work.
- A Turnstile widget page is probed for `cf_clearance` and reported as failed -> A widget sets no `cf_clearance`; it answers with a token. Check both signals: a cookie *or* a populated response field.
- Plugin edits have no effect on the running server -> Plugin modules are loaded at startup. Restart the server after changing a plugin file.
- Prose in a repo file shows mangled dashes and quotes after an edit -> A PowerShell `Get-Content`/`Set-Content` round-trip goes through cp1252 and re-encodes UTF-8, and may prepend a BOM. Edit UTF-8 files with the edit/write tools or Python, and check for the cp1252 lead bytes before committing.
