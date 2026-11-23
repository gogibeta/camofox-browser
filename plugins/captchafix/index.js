/**
 * Captcha support for the Camoufox browser -- every kind, not just Turnstile.
 *
 * The point of this plugin is that most modern captchas are not solved by
 * obtaining a token: they are solved by *clicking the widget in the live
 * browser*, after which the site's own JavaScript receives the token. That makes
 * the browser, not the solver, the thing that has to be able to click, and it
 * puts three hard-won facts in one place:
 *
 * 1. THE CHALLENGE IFRAME OFTEN DOES NOT EXIST AT ALL.
 *    Camoufox defaults keep COOP on, so Cloudflare's challenge frame is never
 *    created: zero iframes, zero sitekeys, "Just a moment..." forever. The fix is
 *    one pref, `browser.tabs.remote.useCrossOriginOpenerPolicy = false`.
 *    Measured by toggling it alone: without it, never clears; with it, ~6s.
 *
 * 2. A COORDINATE CLICK CANNOT REACH A CROSS-ORIGIN FRAME.
 *    A click dispatched at page coordinates (all the HTTP /click route can do)
 *    moves the mouse and never reaches the widget inside the frame. Clicking the
 *    frame *element* through Playwright works in ~1s. So the clicking happens
 *    here, in-process, where the real Page exists.
 *
 * 3. THE WIDGET IS SOMETIMES INSIDE A SHADOW ROOT.
 *    `document.querySelectorAll('iframe')` then returns 0 while page.frames()
 *    still sees it. Frame enumeration is the reliable path.
 *
 * Which captchas this can actually clear is a property of the captcha, not of
 * this code:
 *
 *   CLICK-THROUGH  Turnstile, Cloudflare Managed Challenge, hCaptcha checkbox,
 *                  reCAPTCHA v2 checkbox -- clicking the widget lets the
 *                  provider score the real browser, and it passes or it does not.
 *   SELF-SOLVING   FriendlyCaptcha (proof of work) and reCAPTCHA v3 (invisible):
 *                  they resolve on their own given a browser that does not look
 *                  like a bot. Nothing to click; we just wait.
 *   NEEDS A HUMAN  hCaptcha / reCAPTCHA v2 image grids, GeeTest sliders,
 *                  Arkose FunCaptcha, AWS WAF, DataDome. These demand an answer
 *                  that does not exist in the DOM. No browser-side code can solve
 *                  them, so the plugin reports them instead of pretending.
 *
 * Technique cross-checked against germondai/trawl (AGPL-3.0) and
 * chris124567/cfsolve (MIT); this implementation is independent and MIT.
 */

/** Chunk size camoufox-js uses when emitting CAMOU_CONFIG_<n>. */
const CHUNK_SIZE = 32767;

/**
 * Prefs required for challenge frames to exist and be clickable.
 * Kept deliberately small: every extra pref is another fingerprint tell.
 */
const REQUIRED_PREFS = {
  // THE essential one. Without it challenge frames are never created.
  'browser.tabs.remote.useCrossOriginOpenerPolicy': false,

  // A captcha host must not be treated as a tracker, or its api.js is blocked
  // as a cross-site subresource and the widget never renders.
  'browser.contentblocking.category': 'standard',
  'privacy.trackingprotection.enabled': false,
  'privacy.trackingprotection.pbmode.enabled': false,
  'privacy.trackingprotection.cryptomining.enabled': false,
  'privacy.trackingprotection.fingerprinting.enabled': false,

  // Some cloud VMs advertise an IPv6 default route that cannot reach the
  // captcha CDNs; getaddrinfo then returns only AAAA records and api.js fails.
  'network.dns.disableIPv6': true,

  'javascript.enabled': true,
};

/**
 * Keys merged into the fingerprint config so page scripts can reach widgets
 * that live inside closed shadow roots.
 */
const REQUIRED_CONFIG = {
  // C++-level shadow-root bypass: exposes `shadowRootUnl`.
  forceScopeAccess: true,
  // Lets evaluate() run in the page's own world (`mw:` prefix), required to see
  // the widget's real DOM state.
  allowMainWorld: true,
};

/** Rebuild CAMOU_CONFIG_1..N from the joined chunks, after mutating config. */
function patchConfigEnv(env) {
  const chunkKeys = Object.keys(env)
    .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
  if (!chunkKeys.length) return false;

  let config;
  try {
    config = JSON.parse(chunkKeys.map((k) => env[k]).join(''));
  } catch {
    return false;
  }
  if (!config || typeof config !== 'object') return false;

  Object.assign(config, REQUIRED_CONFIG);

  // Remove the old chunks before writing the new set, so a shorter config does
  // not leave a stale trailing CAMOU_CONFIG_<n> behind. Getting this wrong is
  // what made the old ipv4fix plugin silently ineffective: it patched chunk 1
  // only, and the keys that mattered had spilled into chunk 2.
  for (const k of chunkKeys) delete env[k];

  const text = JSON.stringify(config);
  for (let i = 0, n = 1; i < text.length; i += CHUNK_SIZE, n++) {
    env[`CAMOU_CONFIG_${n}`] = text.slice(i, i + CHUNK_SIZE);
  }
  return true;
}

/**
 * Every captcha family worth recognising.
 *
 * `strategy` decides what the plugin does:
 *   click  -- click the widget frame element, then let the provider score us.
 *   wait   -- nothing to click; the widget resolves itself or it does not.
 *   human  -- needs an answer that is not in the DOM. Report, do not flail.
 *
 * The `frame` patterns are matched against `frame.url()`, which is the only
 * reliable way to find a widget: it works even when the frame is inside a
 * shadow root, and it survives obfuscated element ids.
 */
const CAPTCHAS = [
  {
    kind: 'cf-managed',
    label: 'Cloudflare challenge',
    strategy: 'click',
    // One entry covers both Turnstile widgets and Managed Challenges, because
    // their frames are indistinguishable by URL: a widget uses
    //   .../cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/<id>
    // and so does the managed challenge on nodaroo. The kind is decided from
    // the page instead (see cloudflareKind below), which is the only reliable
    // signal. window.turnstile is useless for this: each page ships its own
    // definition of it, and it was undefined on every site tested, widget and
    // interstitial alike.
    frame: /challenges\.cloudflare\.com|turnstile\.cloudflare\.com|challenge-platform|\/cdn-cgi\/challenge/i,
    response: 'cf-turnstile-response',
    // Cloudflare wants the frame *element* clicked first. Poking the inner
    // checkbox leaves the widget in a loading overlay that then swallows the
    // frame click, so the checkbox list is only a fallback for a provider that
    // has not finished rendering.
    checkbox: ['input[type="checkbox"]', '#challenge-stage input', 'label.cb-lb', '#cf-stage input'],
  },
  {
    kind: 'hcaptcha',
    label: 'hCaptcha',
    strategy: 'click',
    // The parent frame is covered by the puzzle once it opens, so the checkbox
    // inside the frame is the only reachable target.
    innerFirst: true,
    frame: /(?:newassets|assets|js)\.hcaptcha\.com|hcaptcha\.com\/1\/api\.js/i,
    response: 'h-captcha-response',
    checkbox: ['#checkbox', 'input[type="checkbox"]'],
  },
  {
    kind: 'recaptcha-v2',
    label: 'reCAPTCHA v2',
    strategy: 'click',
    // Same reason: reCAPTCHA's bframe panel sits over the anchor frame, so a
    // parent-side coordinate click hits the panel instead of the checkbox.
    innerFirst: true,
    frame: /(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2\/)?(?:anchor|bframe)/i,
    response: 'g-recaptcha-response',
    checkbox: ['#recaptcha-anchor', 'span.recaptcha-checkbox', 'input[type="checkbox"]'],
  },
  {
    kind: 'recaptcha-v3',
    label: 'reCAPTCHA v3 (invisible)',
    strategy: 'wait',
    frame: /recaptcha\/(?:api2\/)?(?:aframe|enterprise)/i,
    response: 'g-recaptcha-response',
  },
  {
    kind: 'friendlycaptcha',
    label: 'FriendlyCaptcha (proof of work)',
    strategy: 'wait',
    frame: /friendlycaptcha\.com|frcapi\.com/i,
    response: 'frc-captcha-response',
  },
  {
    kind: 'geetest',
    label: 'GeeTest (slider)',
    strategy: 'human',
    frame: /geetest\.com|gtimg\.com\/geetest|geevisit\.com/i,
    response: 'geetest_validate',
  },
  {
    kind: 'funcaptcha',
    label: 'Arkose FunCaptcha',
    strategy: 'human',
    frame: /arkoselabs\.com|funcaptcha\.(?:com|co)/i,
    response: 'fc-token',
  },
  {
    kind: 'awswaf',
    label: 'AWS WAF Captcha',
    strategy: 'human',
    frame: /captcha\.awswaf\.com|captcha.awswaf/i,
    response: 'aws-waf-token',
  },
  {
    kind: 'datadome',
    label: 'DataDome',
    strategy: 'human',
    frame: /datadome\.co|captcha-delivery\.com|dd\.js/i,
    response: '',
  },
  {
    kind: 'image-grid',
    label: 'image grid challenge',
    strategy: 'human',
    frame: /recaptcha\/(?:api2\/)?bframe|hcaptcha\.com\/1\/captcha/i,
    response: '',
  },
];

/**
 * Frames that look like a captcha but must never be clicked: they are the
 * invisible plumbing behind a visible or automated flow. Clicking `aframe` in
 * particular just reloads reCAPTCHA's hidden state.
 */
const NEVER_CLICK = /\/aframe|size=invisible|checkbox=false|\.js(?:\?|$)/i;

/**
 * Hard ceiling for one solve attempt.
 *
 * A click-through widget gets the full budget because Cloudflare scores the
 * session after the click and can take several seconds. A self-solving widget
 * gets much less: proof of work finishes in a couple of seconds and reCAPTCHA v3
 * is immediate, so waiting 45s for one would just hold a plugin loop open on
 * every page that happens to carry an invisible widget.
 */
const SOLVE_DEADLINE_MS = 45000;
const WAIT_DEADLINE_MS = 15000;
/**
 * How long to keep looking for a widget frame that has not attached yet.
 *
 * Separate from the solve deadline because "there is nothing here" is a very
 * common, entirely normal outcome (most pages have no captcha), and a plugin
 * that dwells on every ordinary navigation is a plugin that slows the browser
 * down for everyone.
 */
const DISCOVERY_MS = 8000;
/** How long to wait between click attempts. */
const CLICK_INTERVAL_MS = 3000;
/** How many times to click before giving up. */
const MAX_CLICKS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turnstile widget or Managed Challenge?
 *
 * The two are indistinguishable from their frame URLs, so the page decides.
 * A widget page hosts a `.cf-turnstile` container (or a `data-sitekey`) and
 * keeps its own title. An interstitial shows challenge wording and has neither
 * element. `window.turnstile` is not usable for this: the challenge page ships
 * the same script, so it is often defined either way.
 */
async function cloudflareKind(page) {
  try {
    const state = await page.evaluate(() => ({
      boxes: document.querySelectorAll('.cf-turnstile').length,
      sitekeys: document.querySelectorAll('[data-sitekey]').length,
      chlOpt: typeof window._cf_chl_opt !== 'undefined',
      title: document.title,
    }));
    if (state.boxes > 0 || state.sitekeys > 0) return 'turnstile';
    if (state.chlOpt) return 'cf-managed';
    if (CHALLENGE_TITLE.test(String(state.title || ''))) return 'cf-managed';
    return 'turnstile';
  } catch {
    // A detached or cross-origin page: fall back to the neutral label rather
    // than guessing wrong and lying in the log.
    return 'turnstile';
  }
}

/**
 * Is a captcha puzzle panel on screen?
 *
 * Used after a click to decide whether the widget has turned into a puzzle (a
 * human's job) or is simply still working. Measured from the page's own iframes
 * rather than through frame handles: `frameElement()` is unreliable on exactly
 * the providers that matter (Google's frames are replaced during the first
 * click), and the geometry is all that is needed. A shadow-root widget is not
 * covered by this, which is fine: the probing callers only ever ask this about
 * hCaptcha and reCAPTCHA, both of which mount light-DOM iframes.
 */
async function puzzlePanel(page) {
  try {
    return await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('iframe'));
      for (const el of boxes) {
        const src = el.src || '';
        if (!/bframe|hcaptcha.*captcha|arkoselabs|awswaf/i.test(src)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < -1000 || r.left < -1000) continue;
        if (r.width < 20 || r.height < 20) continue;
        // Every provider's puzzle is a tall or wide panel; every checkbox is a
        // 300x80 strip or a 76x76 square.
        if (r.height >= 220 || (r.width >= 320 && r.height >= 180)) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Which captcha, if any, is this page currently showing?
 *
 * Frame URL tells us the provider, but not which of its frames is the widget.
 * hCaptcha and reCAPTCHA each expose several: a visible checkbox plus one or
 * more hidden helpers, and hCaptcha parks a 300x150 container at y=-9999 to keep
 * it laid out. `page.frames()` may list any of them first, so a naive "first
 * match" clicks an off-screen element and never toggles anything. Every
 * candidate is therefore ranked by whether its element is actually on screen.
 */
async function identify(page) {
  if (!page || page.isClosed?.()) return null;
  let frames;
  try {
    frames = page.frames();
  } catch {
    return null;
  }

  const candidates = [];
  for (const frame of frames) {
    let url = '';
    try { url = frame.url(); } catch { /* detached */ }
    if (!url) continue;
    for (const entry of CAPTCHAS) {
      if (!entry.frame.test(url)) continue;
      candidates.push({ entry, frame, url });
      break;
    }
  }
  if (!candidates.length) return null;

  // Rank: on-screen and sensibly sized wins. A frame that cannot even report a
  // box scores last rather than first.
  let best = null;
  for (const c of candidates) {
    let box = null;
    try {
      const el = await c.frame.frameElement();
      if (el) box = await el.boundingBox();
    } catch { /* frameElement is unreliable mid-navigation */ }
    const visible = !!box && box.width >= 20 && box.height >= 15
      && box.y > -1000 && box.x > -1000;
    const score = visible ? 1 : 0;
    if (!best || score > best.score) best = { ...c, box, visible, score };
    // Do not keep probing once a visible widget is found.
    if (visible) break;
  }

  const { entry, frame, url, box } = best;
  // A click-through widget that is invisible is not clickable; downgrade it to
  // "wait" rather than firing clicks at a 1x1 or off-screen frame.
  const clickable = entry.strategy === 'click' && best.visible && !NEVER_CLICK.test(url);
  // The Cloudflare entry covers both a Turnstile widget and a Managed
  // Challenge; ask the page which one this is so the log is trustworthy.
  const kind = entry.kind === 'cf-managed' ? await cloudflareKind(page) : entry.kind;
  return {
    ...entry,
    kind,
    label: kind === 'cf-managed' ? 'Cloudflare Managed Challenge' : entry.label,
    frame,
    url,
    box,
    strategy: clickable ? 'click' : (entry.strategy === 'click' ? 'wait' : entry.strategy),
  };
}

/**
 * Interstitial titles Cloudflare uses for a real challenge.
 *
 * Deliberately narrow. These are the *whole* titles a challenge shows — a page
 * called "Cloudflare Turnstile Managed Demo" is a widget demo, not an
 * interstitial, and matching a bare word like "managed" would misclassify it.
 */
const CHALLENGE_TITLE = /^(just a moment|verify you are human|checking your browser|attention required|one more step|please wait|security verification)\b/i;

/**
 * Frame URL that means "this page is running a Cloudflare challenge".
 *
 * Used as the fallback handle when identification came from the page title
 * rather than from a recognised provider frame.
 */
const CHALLENGE_FRAME = /challenges\.cloudflare\.com|challenge-platform|\/cdn-cgi\//i;

/**
 * Identify a captcha, falling back to the page title.
 *
 * Frame inspection alone is not enough. A Cloudflare Managed Challenge can show
 * its interstitial for several seconds before the challenge frame attaches — or
 * before it attaches at all, since the shell can clear without one. On nodaroo
 * that window is the difference between the plugin clicking and the plugin
 * giving up, so the title is checked too.
 *
 * The title fallback is restricted to real interstitial wording. A Turnstile
 * demo page titled "Cloudflare Turnstile Managed Demo" contains the word
 * "managed" but is a widget page, and treating it as an interstitial would both
 * mislabel it and fire a challenge click at a widget that does not need one.
 */
async function detect(page) {
  const byFrame = await identify(page);
  if (byFrame) return byFrame;

  let title = '';
  try { title = await page.title(); } catch { return null; }
  if (!CHALLENGE_TITLE.test(title)) return null;

  // Resolve the frame lazily: it may appear between this check and the click.
  let frame = null;
  try {
    frame = page.frames().find((f) => {
      try { return CHALLENGE_FRAME.test(f.url()); } catch { return false; }
    }) || null;
  } catch { /* page went away */ }

  const entry = CAPTCHAS.find((c) => c.kind === 'cf-managed');
  return { ...entry, frame, url: '', strategy: frame ? 'click' : 'wait' };
}

/**
 * Is this widget still a checkbox, or has it opened into a puzzle?
 *
 * A checkbox is a small strip or square; once a provider shows an image grid it
 * grows to a panel. That geometry is the only signal available, because the
 * puzzle itself is cross-origin and cannot be inspected from here. Getting this
 * wrong is expensive: clicking a panel's tiles blindly is worse than doing
 * nothing, and it makes the page harder for a human to finish.
 *
 * Measured: Turnstile bar ~300x65, hCaptcha checkbox ~303x78, reCAPTCHA v2
 * checkbox 76x76 (302x76 expanded), reCAPTCHA grid ~400x580, hCaptcha grid
 * ~360x640.
 */
function widgetShape(box) {
  if (!box) return 'unknown';
  if (box.height >= 220) return 'panel';
  if (box.width >= 320 && box.height >= 180) return 'panel';
  return 'checkbox';
}

/** Is the page's response field already populated? */
async function responseFilled(page, name) {
  if (!name) return false;
  try {
    const value = await page.evaluate(
      (field) => {
        const el = document.querySelector(`[name="${field}"], #${field}`);
        return el && el.value ? el.value.length : 0;
      },
      name,
    );
    return Number(value) > 0;
  } catch {
    return false;
  }
}

/** Has the browser stored a cf_clearance cookie for this host? */
async function hasClearance(context, hostHint) {
  try {
    const cookies = await context.cookies();
    return cookies.some((c) => {
      if (c.name !== 'cf_clearance') return false;
      if (!hostHint) return true;
      // A cookie's domain may be a parent of the page host (`.nodaroo.com` for
      // `free.nodaroo.com`), so match on suffix in either direction rather than
      // with a plain includes().
      const domain = String(c.domain || '').replace(/^\./, '');
      return hostHint === domain
        || hostHint.endsWith('.' + domain)
        || domain.endsWith('.' + hostHint);
    });
  } catch {
    return false;
  }
}

/**
 * Click a captcha widget's checkbox.
 *
 * Clicking the frame *element* is the whole trick: a coordinate click on the
 * page never reaches the widget, because the widget lives in a cross-origin
 * child frame and Firefox refuses to route synthesized events across that
 * boundary. The provider then scores the real browser and, if it likes what it
 * sees, calls the page's callback itself.
 *
 * Returns 'clicked', 'panel' (it opened a puzzle -- stop), or 'none'.
 */
async function clickWidget(page, entry) {
  // The frame is resolved lazily on the first click attempt: a managed
  // challenge can show its interstitial for a second or two before the frame
  // attaches, and by then the page object is the only way to find it.
  let frame = entry.frame;
  if (!frame) {
    try {
      frame = page.frames().find((f) => {
        try { return CHALLENGE_FRAME.test(f.url()); } catch { return false; }
      }) || null;
    } catch { return 'none:no-frame'; }
    if (!frame) return 'none:no-frame';
  }

  // Path order is per provider. A Cloudflare challenge listens for a click on
  // its whole surface, and poking an inner input first leaves it in a loading
  // state whose overlay then swallows the real click. hCaptcha and reCAPTCHA
  // are the opposite: their parent frame is covered by the puzzle panel, so the
  // inner checkbox is the only thing that can be reached.
  const innerFirst = entry.innerFirst === true;

  if (innerFirst) {
    const inner = await clickInner(frame, entry);
    if (inner === 'clicked') return 'clicked';
  }

  const outer = await clickOuter(page, frame);
  if (outer === 'clicked') return 'clicked';

  if (!innerFirst) {
    const inner = await clickInner(frame, entry);
    if (inner === 'clicked') return 'clicked';
  }

  return outer;
}

/**
 * Click a checkbox element inside the captcha frame.
 *
 * Playwright drives a cross-origin child frame directly, so the click lands on
 * the real element and no overlay on the parent page can intercept it.
 */
async function clickInner(frame, entry) {
  for (const selector of entry.checkbox || []) {
    let handle;
    try {
      handle = await frame.$(selector);
    } catch { handle = null; }
    if (!handle) continue;

    let box;
    try {
      box = await handle.boundingBox();
    } catch { box = null; }
    if (!box || box.width < 4 || box.height < 4) continue;

    try {
      await handle.click({ timeout: 4000 });
      return 'clicked';
    } catch (err) {
      const msg = err.message || '';
      // An intercepted inner click is not fatal: providers put decorative
      // inputs inside the frame that match a selector but are covered by the
      // widget's own overlay. Try the next selector.
      if (/intercepts pointer events|not visible|does not have a size|subtree/i.test(msg)) {
        continue;
      }
      return `none:inner (${msg.slice(0, 40)})`;
    }
  }
  return 'none:inner-none';
}

/**
 * Click the frame element from the parent page, at the checkbox's usual offset.
 *
 * Returns 'clicked', 'panel' (the widget is a puzzle -- stop), or a 'none:*'
 * reason.
 */
async function clickOuter(page, frame) {
  let el;
  try {
    el = await frame.frameElement();
  } catch (err) {
    // frameElement() fails when the frame belongs to another renderer process
    // mid-navigation, which happens right after a click re-loads the widget.
    return `none:frameElement (${err.message.slice(0, 40)})`;
  }
  if (!el) return 'none:no-element';

  let box;
  try {
    box = await el.boundingBox();
  } catch { return 'none:no-box'; }
  if (!box) return 'none:no-box';
  if (box.width < 20 || box.height < 15) {
    return `none:tiny (${Math.round(box.width)}x${Math.round(box.height)})`;
  }
  // An off-screen frame (hCaptcha parks one at y=-9999) can be measured but
  // cannot be clicked; clicking it throws after a 5s timeout and teaches us
  // nothing.
  if (box.y < -1000 || box.x < -1000) {
    return `none:offscreen (${Math.round(box.width)}x${Math.round(box.height)} @ ${Math.round(box.x)},${Math.round(box.y)})`;
  }

  // Do not click a puzzle. A grid or slider needs an answer that is not in the
  // DOM, and a blind click on it is worse than doing nothing.
  if (widgetShape(box) === 'panel') return 'panel';

  // The checkbox sits at a fixed left margin, vertically centred, for every
  // provider. Measured on real widgets: reCAPTCHA v2 anchor 304x78 with its
  // checkbox centred ~28px in, hCaptcha 302x76 likewise, Turnstile ~300x65.
  // A proportional guess (width * 0.15 = 46px here) lands to the right of the
  // box, on the label text, and never toggles it.
  const pos = {
    x: Math.min(28, box.width - 4),
    y: box.height / 2,
  };

  try {
    await el.hover({ position: pos, timeout: 3000 });
  } catch { /* hover is best-effort */ }

  try {
    await el.click({ position: pos, timeout: 5000 });
    return 'clicked';
  } catch (err) {
    // A click that times out may still have registered; the caller re-checks
    // the response field, so report failure only. The message is preserved
    // because "intercepted by another element" is the signature of a puzzle
    // panel sitting over the checkbox, which is a different situation from a
    // transient navigation.
    const msg = err.message || '';
    if (/intercepts pointer events|not visible|subtree|does not have a size/i.test(msg)) {
      return 'none:covered';
    }
    return `none:click (${msg.slice(0, 40)})`;
  }
}

/**
 * Handle one page's captcha, in the background.
 *
 * Never throws: this runs detached from the request that created the tab, so a
 * failure must not become an unhandled rejection.
 */
async function solveCaptcha(page, context, log, label) {
  const started = Date.now();
  const deadline = started + SOLVE_DEADLINE_MS;
  // Frames attach late: a challenge shell renders, then its cross-origin frame
  // is created, which on a cold browser took over a second. Poll for a while
  // before concluding there is nothing here.
  const discoveryDeadline = started + DISCOVERY_MS;
  let clicks = 0;
  let lastKind = null;
  let lastStrategy = null;
  // Set the first time a self-solving widget is seen; it caps the loop at
  // WAIT_DEADLINE_MS so an invisible widget does not hold the loop for 45s.
  let waitDeadline = null;

  while (Date.now() < deadline) {
    if (page.isClosed?.()) return;
    if (waitDeadline !== null && Date.now() > waitDeadline) {
      log('info', 'captchafix: self-solving captcha finished its window', {
        tab: label, kind: lastKind, ms: Date.now() - started,
      });
      return;
    }

    let host = '';
    try {
      host = new URL(page.url()).hostname;
    } catch { /* about:blank etc. */ }

    const entry = await detect(page);
    if (!entry) {
      // No widget on the page. Before concluding, keep looking for a little
      // while: the frame is created after the shell renders.
      if (lastKind === null && Date.now() < discoveryDeadline) {
        await sleep(600);
        continue;
      }
      // A Cloudflare managed challenge is won by a cf_clearance cookie, so
      // leaving the page is that one case's success signal.
      if (lastKind === 'cf-managed' && host && (await hasClearance(context, host))) {
        log('info', 'captchafix: challenge cleared', {
          tab: label, host, kind: lastKind, clicks, ms: Date.now() - started,
        });
      } else if (lastKind) {
        log('info', 'captchafix: widget gone', {
          tab: label, host, kind: lastKind, clicks, ms: Date.now() - started,
        });
      }
      return;
    }

    lastKind = entry.kind;
    lastStrategy = entry.strategy;

    if (await responseFilled(page, entry.response)) {
      log('info', 'captchafix: captcha answered', {
        tab: label, host, kind: entry.kind, clicks, ms: Date.now() - started,
      });
      return;
    }

    if (entry.strategy === 'click') {
      if (clicks < MAX_CLICKS) {
        const outcome = await clickWidget(page, entry);
        log('info', 'captchafix: clicked widget', {
          tab: label, host, kind: entry.kind, attempt: clicks + 1, outcome,
          frame: (entry.url || '').slice(0, 90),
        });
        if (outcome === 'clicked') {
          clicks++;
          // The click may have been the one that opens a puzzle. Give the
          // provider a moment to lay it out, then check: waiting for the next
          // attempt instead means a multi-second click timeout first, which
          // turns a 5s answer into a 20s non-answer.
          await sleep(1200);
          if (await responseFilled(page, entry.response)) {
            log('info', 'captchafix: captcha answered', {
              tab: label, host, kind: entry.kind, clicks, ms: Date.now() - started,
            });
            return;
          }
          if (await puzzlePanel(page)) {
            log('warn', 'captchafix: captcha opened a puzzle', {
              tab: label, host, kind: entry.kind, label: entry.label,
              ms: Date.now() - started,
            });
            return;
          }
        } else if (outcome === 'panel') {
          // Clicking the checkbox opened an image grid or a slider. Stop: that
          // is a human's job now, and further clicks only damage the page.
          log('warn', 'captchafix: captcha opened a puzzle', {
            tab: label, host, kind: entry.kind, label: entry.label,
            ms: Date.now() - started,
          });
          return;
        } else if (outcome === 'none:covered') {
          // Something is sitting over the checkbox. If it is a puzzle panel,
          // the checkbox has been passed and only a human can continue.
          // Otherwise it is a transient overlay and another attempt is
          // reasonable.
          if (puzzlePanel(page)) {
            log('warn', 'captchafix: captcha needs a human', {
              tab: label, host, kind: entry.kind, label: entry.label,
              reason: 'puzzle covers the checkbox', ms: Date.now() - started,
            });
            return;
          }
          log('info', 'captchafix: click intercepted, retrying', {
            tab: label, host, kind: entry.kind, attempt: clicks + 1,
            ms: Date.now() - started,
          });
          await sleep(1000);
        } else {
          await sleep(500);
        }
      } else {
        // Out of clicks. Stop rather than burning the deadline in silence.
        log('warn', 'captchafix: captcha did not clear after clicks', {
          tab: label, host, kind: entry.kind, clicks, ms: Date.now() - started,
        });
        return;
      }
    } else if (entry.strategy === 'human') {
      // An image grid or a slider needs an answer that does not exist in the
      // DOM. Report it once and stop; clicking here would only make the page
      // harder to use.
      log('warn', 'captchafix: captcha needs a human', {
        tab: label, host, kind: entry.kind, label: entry.label,
        ms: Date.now() - started,
      });
      return;
    }
    // strategy === 'wait': proves itself in its own time. Keep polling until its
    // own deadline so a proof-of-work captcha is noticed when it finishes. A
    // later click-through widget resets the cap, so the two budgets do not leak
    // into each other when a page swaps widgets.
    if (entry.strategy === 'wait') {
      if (waitDeadline === null) waitDeadline = Date.now() + WAIT_DEADLINE_MS;
    } else {
      waitDeadline = null;
    }

    await sleep(CLICK_INTERVAL_MS);
  }

  log('warn', 'captchafix: captcha did not clear before deadline', {
    tab: label, kind: lastKind, strategy: lastStrategy, clicks,
    ms: Date.now() - started,
  });
}

export function register(_app, ctx) {
  const { events, log, sessions, normalizeUserId } = ctx;

  events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = { ...(options.firefoxUserPrefs || {}), ...REQUIRED_PREFS };
    const patched = patchConfigEnv(options.env || {});
    log('info', 'captchafix: enabled challenge-iframe prefs', {
      coopDisabled: options.firefoxUserPrefs['browser.tabs.remote.useCrossOriginOpenerPolicy'] === false,
      configPatched: patched,
    });
  });

  // One in-flight attempt per page. A navigation during a solve must not stack a
  // second loop on the same page.
  const solving = new WeakSet();

  /** Resolve a tab's live page from the session map. */
  const findPage = (userId, tabId) => {
    const session = sessions.get(normalizeUserId(userId));
    if (!session || session._closing) return null;
    for (const group of session.tabGroups.values()) {
      const tabState = group.get(tabId);
      if (tabState) return tabState.page || null;
    }
    return null;
  };

  const maybeSolve = (page, label) => {
    if (!page || page.isClosed?.()) {
      log('debug', 'captchafix: no live page to inspect', { tab: label });
      return;
    }
    if (solving.has(page)) return;

    let host = '';
    try { host = new URL(page.url()).hostname; } catch { return; }
    if (!host) return;

    const context = page.context();
    if (!context) return;

    log('info', 'captchafix: watching tab', { tab: label, host });
    solving.add(page);
    // Defer a beat so the widget has rendered before the first check.
    sleep(1200)
      .then(() => solveCaptcha(page, context, log, label))
      .catch((err) => log('warn', 'captchafix: solve loop failed', { error: err.message }))
      .finally(() => solving.delete(page));
  };

  // `tab:created` carries the live page; later navigations of the same tab are
  // announced without one, so resolve it from the session map.
  events.on('tab:created', ({ userId, tabId, page }) => {
    maybeSolve(page, `${userId}/${tabId}`);
  });

  events.on('tab:navigated', ({ userId, tabId }) => {
    maybeSolve(findPage(userId, tabId), `${userId}/${tabId}`);
  });
}
