/* Turnstile Auto Solver - content script (InstaBox backend via background worker) */
(() => {
  if (window.__turnstileAutoSolverLoaded) return;
  window.__turnstileAutoSolverLoaded = true;

  const api = globalThis.browser || globalThis.chrome;
  let busy = false;
  let scanTimer = null;

  const responseInput = () => document.querySelector('input[name="cf-turnstile-response"]');

  function currentToken() {
    const input = responseInput();
    return input && input.value ? input.value : '';
  }

  function scan() {
    const token = currentToken();
    if (token) return { status: 'already', token };

    const widgets = Array.from(
      document.querySelectorAll('.cf-turnstile[data-sitekey], [data-sitekey]')
    ).filter((el) => /^(0x|1x|2x|3x|4x)/i.test(el.dataset.sitekey || ''));

    if (!widgets.length) return { status: 'none' };

    const el = widgets[0];
    return {
      status: 'found',
      url: location.href,
      siteKey: el.dataset.sitekey,
      action: el.dataset.action || '',
      cdata: el.dataset.cdata || '',
    };
  }

  function applyToken(token) {
    const input = responseInput();
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, token);
      else input.value = token;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const tw = window.turnstile;
    if (tw && typeof tw.setResponse === 'function') {
      const el = document.querySelector('.cf-turnstile[id], [data-sitekey][id]');
      try { tw.setResponse(el ? el.id : undefined, token); } catch (_) {}
      try { tw.setResponse(token); } catch (_) {}
    }

    window.__turnstileAutoSolverToken = token;
    document.dispatchEvent(new CustomEvent('turnstile-auto-solved', { detail: { token } }));
  }

  async function autoSolve() {
    if (busy) return;
    const info = scan();
    if (info.status !== 'found') return;
    busy = true;
    try {
      const reply = await api.runtime.sendMessage({ type: 'SOLVE', info });
      window.__turnstileAutoSolverLast = reply || { ok: false, error: 'no reply' };
      if (reply && reply.ok && reply.token) applyToken(reply.token);
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
      if (info.status === 'found') autoSolve();
      else if (info.status === 'none') scheduleScan(Math.min(delay * 1.6, 8000));
    }, delay);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SCAN') {
      const info = scan();
      sendResponse(info);
      if (info.status === 'found') autoSolve();
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
    if (!busy && scan().status === 'found' && !window.__turnstileAutoSolverToken) {
      scheduleScan(600);
    }
  });
  observer.observe(document.documentElement || document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-sitekey', 'class'],
  });
})();
