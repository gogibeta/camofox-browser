/* Turnstile Auto Solver - content script (InstaBox backend via background worker) */
(() => {
  if (window.__turnstileAutoSolverLoaded) return;
  window.__turnstileAutoSolverLoaded = true;

  const api = globalThis.browser || globalThis.chrome;
  let busy = false;
  let scanTimer = null;

  /**
   * Every captcha whose answer is a string in a named field.
   *
   * A page can carry more than one provider's markup, and the field name is the
   * only thing that identifies which answered. Turnstile is listed first because
   * it is the common case and the extension's original target.
   *
   * Image grids, sliders and FunCaptcha are absent on purpose: their answer is
   * never a DOM string, so there is nothing to read and nothing to inject.
   */
  const CAPTCHA_FIELDS = [
    { kind: 'turnstile', field: 'cf-turnstile-response', mode: 'widget', selector: '.cf-turnstile, [id^=cf-turnstile]' },
    { kind: 'hcaptcha', field: 'h-captcha-response', mode: 'widget', selector: '.h-captcha, [data-hcaptcha-widget-id]' },
    { kind: 'recaptcha', field: 'g-recaptcha-response', mode: 'widget', selector: '.g-recaptcha, [data-sitekey][data-callback], .grecaptcha-badge' },
    { kind: 'friendlycaptcha', field: 'frc-captcha-response', mode: 'widget', selector: '.frc-captcha' },
  ];

  /** Read the first populated captcha field on the page. */
  function currentResponse() {
    for (const entry of CAPTCHA_FIELDS) {
      const el = document.querySelector(`input[name="${entry.field}"], textarea[name="${entry.field}"]`);
      if (el && el.value) return { kind: entry.kind, field: entry.field, token: el.value };
    }
    return null;
  }

  const currentToken = () => {
    const r = currentResponse();
    return r ? r.token : '';
  };

  /** Interstitial titles Cloudflare uses across challenge variants. */
  const CHALLENGE_TITLE = /just a moment|verify you are human|checking your browser|attention required|one more step/i;

  /**
   * Is this page a Cloudflare Managed Challenge?
   *
   * A managed challenge is not a Turnstile widget: there is no sitekey, no
   * `.cf-turnstile` element and no response field. It shows a challenge shell
   * and a cross-origin iframe, and the only success signal is a cf_clearance
   * cookie. Detection therefore has to look for the interstitial itself, and the
   * text check has to run against `document.body` *text*, not innerHTML, because
   * the shell's wording lives in a script-adjacent element.
   */
  function isManagedChallenge() {
    if (!CHALLENGE_TITLE.test(document.title || '')) return false;
    // Require a challenge-specific marker so a normal page that merely mentions
    // "Just a moment" in its title is not treated as an interstitial.
    return (
      !!document.querySelector('#challenge-form, #challenge-stage, #challenge-body-text, #challenge-running') ||
      typeof window._cf_chl_opt === 'object'
    );
  }

  function scan() {
    const resp = currentResponse();
    if (resp) return { status: 'already', token: resp.token, kind: resp.kind };

    // Managed challenge: no sitekey to report, but still worth solving.
    if (isManagedChallenge()) {
      return { status: 'challenge', url: location.href, mode: 'challenge' };
    }

    // Turnstile first: it is the original target and by far the most common.
    const turnstile = Array.from(
      document.querySelectorAll('.cf-turnstile[data-sitekey], [data-sitekey]')
    ).find((el) => /^(0x|1x|2x|3x|4x)/i.test(el.dataset.sitekey || ''));
    if (turnstile) {
      return {
        status: 'found',
        url: location.href,
        siteKey: turnstile.dataset.sitekey,
        action: turnstile.dataset.action || '',
        cdata: turnstile.dataset.cdata || '',
        mode: 'widget',
        kind: 'turnstile',
      };
    }

    // Then any other provider by its own markup.
    for (const entry of CAPTCHA_FIELDS) {
      if (entry.kind === 'turnstile') continue;
      const el = document.querySelector(entry.selector);
      if (!el) continue;
      // hCaptcha and reCAPTCHA hang the sitekey off either the widget or a child.
      const holder = el.dataset.sitekey ? el : el.querySelector('[data-sitekey]');
      return {
        status: 'found',
        url: location.href,
        siteKey: (holder && holder.dataset.sitekey) || '',
        action: (holder && holder.dataset.action) || '',
        cdata: (holder && holder.dataset.cdata) || '',
        mode: 'widget',
        kind: entry.kind,
      };
    }

    return { status: 'none' };
  }

  function applyToken(token, kind) {
    const entry = CAPTCHA_FIELDS.find((c) => c.kind === kind) || CAPTCHA_FIELDS[0];
    const input = document.querySelector(
      `input[name="${entry.field}"], textarea[name="${entry.field}"]`
    );
    if (input) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
      if (setter) setter.call(input, token);
      else input.value = token;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Tell the provider too: several pages read the token from the provider's
    // own API rather than from the field, and a provider that does not know
    // about the token will wipe it on its next refresh.
    if (kind === 'turnstile' || !kind) {
      const tw = window.turnstile;
      if (tw && typeof tw.setResponse === 'function') {
        const el = document.querySelector('.cf-turnstile[id], [data-sitekey][id]');
        try { tw.setResponse(el ? el.id : undefined, token); } catch (_) {}
        try { tw.setResponse(token); } catch (_) {}
      }
    }
    if (kind === 'hcaptcha') {
      try { window.hcaptcha?.setResponse?.(token); } catch (_) {}
    }
    if (kind === 'recaptcha') {
      try { window.grecaptcha?.getResponse; } catch (_) {}
      try {
        const el = document.querySelector('.g-recaptcha');
        const id = el && el.dataset && el.dataset.callback;
        if (id && typeof window[id] === 'function') window[id](token);
      } catch (_) {}
    }

    window.__captchaAutoSolverToken = token;
    window.__turnstileAutoSolverToken = token;
    document.dispatchEvent(new CustomEvent('turnstile-auto-solved', { detail: { token, kind } }));
    document.dispatchEvent(new CustomEvent('captcha-auto-solved', { detail: { token, kind } }));
  }

  async function autoSolve() {
    if (busy) return;
    const info = scan();
    // 'challenge' is a managed challenge: there is no token to inject, so the
    // win condition is a reload after the solver stores cf_clearance.
    if (info.status !== 'found' && info.status !== 'challenge') return;
    busy = true;
    try {
      const reply = await api.runtime.sendMessage({ type: 'SOLVE', info });
      window.__turnstileAutoSolverLast = reply || { ok: false, error: 'no reply' };
      if (reply && reply.ok) {
        if (reply.token) {
          applyToken(reply.token, reply.captcha || info.kind);
        } else if (reply.clearance || reply.result === 'clearance') {
          // cf_clearance is httpOnly and already in the browser's cookie jar.
          // Reloading is what turns it into an actual page view.
          document.dispatchEvent(new CustomEvent('turnstile-auto-cleared', {
            detail: { clearance: reply.clearance || null },
          }));
          setTimeout(() => location.reload(), 250);
        }
      }
    } catch (err) {
      window.__turnstileAutoSolverLast = { ok: false, error: String(err) };
    } finally {
      busy = false;
    }
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const info = scan();
      if (info.status === 'found' || info.status === 'challenge') autoSolve();
      else if (info.status === 'none') scheduleScan(Math.min(delay * 1.6, 8000));
    }, delay);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SCAN') {
      const info = scan();
      sendResponse(info);
      if (info.status === 'found' || info.status === 'challenge') autoSolve();
      else if (info.status === 'none') scheduleScan(1800);
      return true;
    }
    if (msg && msg.type === 'STATUS') {
      sendResponse({
        scan: scan(),
        last: window.__turnstileAutoSolverLast || null,
        token: window.__turnstileAutoSolverToken || currentToken(),
      });
      return true;
    }
  });

  // Initial attempts: widgets sometimes render a little after DOMContentLoaded.
  setTimeout(autoSolve, 800);
  scheduleScan(2200);

  // React to widgets injected later by client-side frameworks.
  const observer = new MutationObserver(() => {
    if (busy || window.__turnstileAutoSolverToken) return;
    const status = scan().status;
    if (status === 'found' || status === 'challenge') scheduleScan(600);
  });
  observer.observe(document.documentElement || document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-sitekey', 'class'],
  });
})();
