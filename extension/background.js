/* Turnstile Auto Solver - background worker
 * Backend: InstaBox ONLY. No Apify. The extension calls the InstaBox exec API,
 * which runs our camofox-browser-based solver on the VM and returns a token.
 */
const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  instaboxApiKey: '',
  instaboxMachineId: 'm_agq7thurpy4svui43m5r735hri',
  instaboxApiUrl: 'https://api.instabox.sh/v1',
  solverPath: '/data/workspace/camofox_solve_rust',
  solverPython: '',
  camofoxUrl: 'http://127.0.0.1:9377',
  timeoutMs: 45000,
  autoSolve: true,
};

/**
 * Optional bundled config, written next to this file by the installer.
 *
 * Loading an unpacked extension into Chrome cannot be scripted -- that is a
 * browser security boundary, not a missing feature -- but *configuring* it can
 * be. The installer drops a `config.json` (mode 600, never in git) holding the
 * InstaBox key and machine id it just provisioned, so the extension is usable
 * the moment it is loaded instead of asking the user to paste a key into the
 * popup. Absent file, or unreadable, is normal: DEFAULTS then stand.
 */
async function bundledConfig() {
  try {
    const url = api.runtime.getURL('config.json');
    const response = await fetch(url);
    if (!response.ok) return {};
    const parsed = await response.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Seed storage once, on install, from DEFAULTS overlaid with the bundled file. */
async function seedStorage() {
  const bundled = await bundledConfig();
  const seed = { ...DEFAULTS };
  for (const [key, value] of Object.entries(bundled)) {
    if (value === null || value === undefined || value === '') continue;
    seed[key] = typeof value === 'string' ? cleanValue(value) : value;
  }
  // Never clobber a value the user already set in the popup. onInstalled fires
  // again on update, and re-seeding would silently discard a hand-entered key.
  const existing = await api.storage.local.get(seed);
  const merged = { ...seed, ...existing };
  await api.storage.local.set(merged);
  return merged;
}

api.runtime.onInstalled.addListener(async () => {
  try {
    await seedStorage();
    api.action?.setBadgeBackgroundColor?.({ color: '#1a73e8' });
  } catch (_) {}
});

const busyTabs = new Set();

function setBadge(tabId, text, color) {
  try {
    api.action?.setBadgeText?.({ text: String(text || ''), tabId });
    if (color) api.action?.setBadgeBackgroundColor?.({ color, tabId });
  } catch (_) {}
}

function b64(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
  api.storage.local.get({ autoSolve: true }).then(({ autoSolve }) => {
    if (!autoSolve) return;
    setTimeout(() => api.tabs.sendMessage(tabId, { type: 'SCAN' }).catch(() => {}), 1500);
  });
});

api.tabs.onRemoved.addListener((tabId) => busyTabs.delete(tabId));

async function solveOnInstabox(info, cfg) {
  if (!cfg.instaboxApiKey) throw new Error('Set the InstaBox API key in the extension popup.');

  const payload = {
    url: info.url,
    siteKey: info.siteKey,
    action: info.action || '',
    cdata: info.cdata || '',
    timeoutMs: Number(cfg.timeoutMs) || 45000,
    camofoxUrl: cfg.camofoxUrl || 'http://127.0.0.1:9377',
    // "auto" lets the solver decide: a Turnstile widget yields a token, a
    // Cloudflare Managed Challenge yields a cf_clearance cookie instead, and any
    // other provider yields its own token field.
    mode: info.mode || 'auto',
    // The provider the content script saw, when it could tell. Advisory only:
    // the solver reads every response field regardless, because a page can
    // render a different widget than the one that was detected.
    captcha: info.kind || '',
  };
  const arg = b64(JSON.stringify(payload));
  // solverPython is optional: it is the interpreter for a .py solver. A compiled
  // binary (the Rust solver) must be executed directly, so an empty value has to
  // produce `path arg`, not a leading space that the shell still tolerates but
  // that would break the moment solverPath is quoted.
  const runner = (cfg.solverPython || '').trim();
  const cmd =
    `cd /data/workspace && ${runner ? `${runner} ` : ''}${cfg.solverPath} ${arg}`;

  const endpoint = `${cfg.instaboxApiUrl}/machines/${encodeURIComponent(cfg.instaboxMachineId)}/exec`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.instaboxApiKey },
    body: JSON.stringify({
      cmd,
      timeoutSeconds: Math.ceil(payload.timeoutMs / 1000) + 40,
    }),
  });

  const reply = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(reply?.error?.message || reply?.error || `InstaBox HTTP ${response.status}`);
  }
  const stdout = (reply.stdout || '').trim();
  if (!stdout) throw new Error(reply.stderr || 'InstaBox returned no output');

  let result;
  try {
    result = JSON.parse(stdout.split('\n').filter(Boolean).pop());
  } catch (_) {
    throw new Error('Solver returned a non-JSON response: ' + stdout.slice(0, 200));
  }
  if (result.error) throw new Error(result.error);
  // Two success shapes. A Turnstile widget produces a token for the page to
  // consume; a Cloudflare Managed Challenge produces no token at all, only a
  // cf_clearance cookie (already stored in the browser that solved it, so the
  // page reloads clean). Accepting only a token would report every managed
  // challenge as a failure.
  const hasToken = typeof result.token === 'string' && result.token.length > 0;
  const hasClearance = typeof result.clearance === 'string' && result.clearance.length > 0;
  if (!hasToken && !hasClearance) throw new Error('No token or clearance returned');
  return {
    ok: true,
    token: hasToken ? result.token : null,
    clearance: hasClearance ? result.clearance : null,
    result: result.result || (hasToken ? 'token' : 'clearance'),
    // Which provider answered ("turnstile", "hcaptcha", "recaptcha", ...). The
    // content script needs it to write the token into the right response field
    // and to tell the right provider API about it.
    captcha: result.captcha || info.kind || null,
    challenge: !!result.challenge,
    durationMs: result.durationMs,
    method: result.method || 'camofox-browser',
    error: null,
  };
}

/**
 * Strip CR/newlines and surrounding whitespace from a config value.
 *
 * A `.env` authored on Windows, or a value that travelled through a shell that
 * kept the CR, arrives as "m_abc\r". A machine id with a trailing CR builds a
 * URL that fetch() rejects, so the extension fails to reach the box at all while
 * looking perfectly configured in the popup.
 */
function cleanValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\r\n]/g, '').trim();
}

/** Effective config: DEFAULTS, overlaid with the bundled file, then the user's. */
async function loadConfig() {
  const bundled = await bundledConfig();
  const stored = await api.storage.local.get(DEFAULTS);
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(bundled)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  // A value the user actually typed always wins over the bundled default.
  for (const [key, value] of Object.entries(stored)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  for (const key of Object.keys(merged)) {
    if (typeof merged[key] === 'string') merged[key] = cleanValue(merged[key]);
  }
  return merged;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'SOLVE') {
    const tabId = sender?.tab?.id;
    if (tabId != null && busyTabs.has(tabId)) {
      sendResponse({ ok: false, error: 'Solve already in progress for this tab.' });
      return true;
    }
    if (tabId != null) busyTabs.add(tabId);
    if (tabId != null) setBadge(tabId, '...', '#f9ab00');

    loadConfig()
      .then((cfg) => solveOnInstabox(msg.info || {}, cfg))
      .then((res) => {
        if (tabId != null) setBadge(tabId, res.ok ? 'OK' : 'ERR', res.ok ? '#1e8e3e' : '#d93025');
        sendResponse(res);
      })
      .catch((err) => {
        if (tabId != null) setBadge(tabId, 'ERR', '#d93025');
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      })
      .finally(() => {
        if (tabId != null) busyTabs.delete(tabId);
        if (tabId != null) setTimeout(() => setBadge(tabId, ''), 12000);
      });
    return true;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true, backend: 'instabox' });
    return true;
  }
});
