const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  instaboxApiKey: '',
  instaboxMachineId: 'm_agq7thurpy4svui43m5r735hri',
  instaboxApiUrl: 'https://api.instabox.sh/v1',
  autoSolve: true,
};

api.storage.local.get(DEFAULTS).then((cfg) => {
  $('ibkey').value = cfg.instaboxApiKey || '';
  $('ibmachine').value = cfg.instaboxMachineId || DEFAULTS.instaboxMachineId;
  $('iburl').value = cfg.instaboxApiUrl || DEFAULTS.instaboxApiUrl;
  $('auto').checked = !!cfg.autoSolve;
});

$('save').addEventListener('click', async () => {
  await api.storage.local.set({
    instaboxApiKey: $('ibkey').value.trim(),
    instaboxMachineId: $('ibmachine').value.trim() || DEFAULTS.instaboxMachineId,
    instaboxApiUrl: $('iburl').value.trim() || DEFAULTS.instaboxApiUrl,
    autoSolve: $('auto').checked,
  });
  $('status').textContent = 'Saved.';
});

$('solve').addEventListener('click', async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await api.tabs.sendMessage(tab.id, { type: 'SCAN' });
    $('status').textContent = res && res.status === 'found'
      ? `Solving ${res.siteKey} ...`
      : `No widget found (${res ? res.status : 'no reply'}).`;
  } catch (err) {
    $('status').textContent = String(err);
  }
});
