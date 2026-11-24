const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  instaboxApiKey: '',
  instaboxMachineId: '',
  instaboxApiUrl: 'https://api.instabox.sh/v1',
  solverPath: '/data/workspace/camofox_solve_rust',
  solverPython: '',
  autoSolve: true,
};

/**
 * The installer writes config.json beside background.js with the InstaBox key so
 * the extension works the moment it is loaded. Read it here too, otherwise the
 * popup shows an empty key field for a fully configured install and the first
 * thing a user does is "fix" a value that was never wrong.
 */
async function bundledConfig() {
  try {
    const res = await api.runtime.getURL && fetch(api.runtime.getURL('config.json'));
    if (!res || !res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

(async () => {
  const bundled = await bundledConfig();
  const stored = await api.storage.local.get(DEFAULTS);
  const cfg = { ...DEFAULTS };
  // Bundled first, then anything the user actually saved.
  for (const [k, v] of Object.entries(bundled)) {
    if (v !== null && v !== undefined && v !== '') cfg[k] = v;
  }
  for (const [k, v] of Object.entries(stored)) {
    if (v !== null && v !== undefined && v !== '') cfg[k] = v;
  }
  const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]/g, '').trim();

  $('ibkey').value = clean(cfg.instaboxApiKey);
  $('ibmachine').value = clean(cfg.instaboxMachineId);
  $('iburl').value = clean(cfg.instaboxApiUrl);
  $('solverpath').value = clean(cfg.solverPath);
  $('solverpython').value = clean(cfg.solverPython);
  $('auto').checked = !!cfg.autoSolve;
  if (!$('ibkey').value) {
    $('status').textContent = 'No InstaBox key configured. Paste one and save.';
  }
})();

$('save').addEventListener('click', async () => {
  // Only persist non-empty values. A blank field is "leave it as it was", not
  // "erase the seeded key" -- the fields are pre-filled from config.json, so a
  // blank one means the input was cleared by accident.
  const next = {};
  const put = (key, value) => {
    const v = String(value == null ? '' : value).replace(/[\r\n]/g, '').trim();
    if (v !== '') next[key] = v;
  };
  put('instaboxApiKey', $('ibkey').value);
  put('instaboxMachineId', $('ibmachine').value);
  put('instaboxApiUrl', $('iburl').value);
  put('solverPath', $('solverpath').value);
  // An empty interpreter is meaningful for the Rust binary: store it as such.
  next.solverPython = $('solverpython').value.trim();
  next.autoSolve = $('auto').checked;
  await api.storage.local.set(next);
  $('status').textContent = 'Saved.';
});

$('solve').addEventListener('click', async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await api.tabs.sendMessage(tab.id, { type: 'SCAN' });
    if (!res) {
      $('status').textContent = 'No reply from the page.';
    } else if (res.status === 'found') {
      $('status').textContent = `Solving ${res.siteKey} ...`;
    } else if (res.status === 'challenge') {
      $('status').textContent = 'Solving Cloudflare managed challenge ...';
    } else if (res.status === 'already') {
      $('status').textContent = 'A token is already present on this page.';
    } else {
      $('status').textContent = 'No widget or challenge found.';
    }
  } catch (err) {
    $('status').textContent = String(err);
  }
});
