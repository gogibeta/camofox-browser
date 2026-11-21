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

api.runtime.onInstalled.addListener(async () => {
  await api.storage.local.set(DEFAULTS);
  try { api.action?.setBadgeBackgroundColor?.({ color: '#1a73e8' }); } catch (_) {}
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
  if (result.error || !result.token) throw new Error(result.error || 'No token returned');
  return {
    ok: true,
    token: result.token,
    durationMs: result.durationMs,
    method: result.method || 'camofox-browser',
    error: null,
  };
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

    api.storage.local.get(DEFAULTS)
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
