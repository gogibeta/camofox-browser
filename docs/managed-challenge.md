# Cloudflare Managed Challenge: evidence and resolution

This is the investigation that produced the `captchafix` plugin. It started as
"the Turnstile solver does not work on this site" and ended with a managed
challenge clearing in 5 s.

Measurements taken on InstaBox box `m_agranzllbyqcrmw6gkfbkrp42a` (`camofox-box`,
4 vCPU / 8 GB, headed Camoufox on `DISPLAY=:1`).

## 1. The target was not a Turnstile widget

`https://free.nodaroo.com/` returns a **Cloudflare Managed Challenge**. Straight
from the 403 body:

```
cType: 'managed'
```

| Signal | nodaroo | solvegate.io/demo/managed (control) |
| --- | --- | --- |
| `data-sitekey` elements | **0** | 1 |
| `.cf-turnstile` elements | **0** | 1 |
| `window._cf_chl_opt` | present | absent |
| Challenge script | `…/orchestrate/chl_page/v1?ray=…` | `…/turnstile/f/av0/rch/…` |
| Success signal | `cf_clearance` cookie | token in `cf-turnstile-response` |

A managed challenge has no widget and no sitekey, so a widget-targeted solver has
nothing to click or fill. The original solver timed out at 45 s with
`"clicked": false`.

## 2. The gate is header-triggered and deterministic

Same UA, same IP, only `Accept` differs:

```
Accept: */*        -> 200   (20/20)
Accept: text/html  -> 403   (20/20)
```

A real browser always sends `Accept: text/html`, so it always gets the challenge;
`curl` passes only because it does not look like a browser. The 403 also carries
`critical-ch: Sec-CH-UA-*`, asking for client hints Firefox cannot send. The gate
applies site-wide, including `/assets/*.css`.

This also explains why the box is flagged on some sites and not others — managed
challenges fail on `glassdoor.com` and `tripadvisor.com` but pass on `ufc.com`,
`zillow.com`, `cloudflare.com` and `discord.com`, so it is not purely IP
reputation.

## 3. Root cause: the challenge iframe never existed

Camoufox keeps COOP on by default, and with COOP on `challenges.cloudflare.com`
is never framed at all: zero iframes, zero sitekeys, stuck on "Just a moment..."
indefinitely.

```js
browser.tabs.remote.useCrossOriginOpenerPolicy = false
```

That one pref is the whole difference — verified by toggling it alone with
everything else held constant. With it, the iframe appears and the challenge
clears in ~6 s.

`camoufox-js` calls this `disable_coop`. Two related prefs matter for the plugin's
own code: `main_world_eval` (`allowMainWorld`) and an injected `forceScopeAccess`
(`shadow-root-bypass`) that exposes `shadowRootUnl`.

## 4. Root cause: a coordinate click cannot reach it

The challenge frame lives inside a **shadow root**, so
`document.querySelectorAll('iframe')` returns 0 while `page.frames()` sees it
(`shadowRoots: 1`). And because it is a cross-origin child frame, a page
coordinate click moves the mouse but never reaches the widget: the click lands
(`trusted: true`), the screenshots are byte-identical and the title never changes.

Worse, one run stalled 28 s in `native mouse move timed out after 28000ms` and
surfaced as a misleading `410 browser_restarted`.

What works is clicking the frame *element* through Playwright, from inside the
browser process:

```js
const el = await frame.frameElement();
await el.click({ position: { x: 28, y: box.height / 2 } });
```

That clears Glassdoor in ~1 s and nodaroo in ~3 s. This is why automatic solving
lives in a **plugin**, not in the out-of-process solver.

## 5. Verified result

All runs used a fresh `userId`, so no persisted cookie could make a pass look
real:

| Site | Result |
| --- | --- |
| free.nodaroo.com | cleared in 4.9–8.9 s, `kind: "cf-managed"`, 1 click |
| glassdoor.com | cleared in 2.4–8.2 s, `kind: "cf-managed"`, 1 click |
| solvegate.io/demo/managed | token answered in 4.3–5.6 s, `kind: "turnstile"` |

Solver, for comparison: nodaroo `result: "clearance"` in 5.7–7.5 s, solvegate
`result: "token"` (645 chars) in 5.5–6.9 s.

## 6. The mobile layout is fine

Rendering the real page (challenge bypassed) at 390×844:

- `scrollWidth` 390 = viewport 390, **zero horizontal overflow**
- media queries present and active at 640, 600, 420 and 800 px
- Discord button 308×44 px (meets the WCAG 44 px target)
- layout centred, readable, correctly stacked

The page is not broken on mobile. What breaks is the gate in front of it.

## 7. What this means for a caller

A managed challenge is not a captcha you can "solve" — it is Cloudflare scoring a
browser session, and the deliverable is a `cf_clearance` cookie. So:

- Ask for `result: "clearance"` and use the `clearance` field, or reuse the
  session cookies; there is no token to inject into a form.
- A 403 alone does not mean the browser is flagged; check for
  `cf-mitigated: challenge` on the response first.
- Keep the plugin enabled. A healthy server without it cannot clear a managed
  challenge at all.
