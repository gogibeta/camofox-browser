#!/usr/bin/env node
/**
 * Merge camofox.config.json instead of overwriting it.
 *
 * Every installer used to `cat >` a fixed config over the top of the real one.
 * That is how the live VM lost `vnc` and how `interactive.mode` silently reset
 * from "desktop" to "off" between runs: the written file was a *snapshot* of
 * what one install wanted, not a merge into what was already configured.
 *
 * Rules, in order:
 *   - an unreadable or non-object file is treated as `{}`
 *   - `plugins` as an array is promoted to the object form the loader also accepts
 *   - `--drop NAME` removes a plugin key (superseded plugins)
 *   - `--enable NAME[:json]` sets `{enabled:true}`, preserving any other keys
 *     already on that plugin, and leaving an existing `enabled` value alone
 *     unless it is explicitly false
 *   - scalar defaults are filled in only when absent, never overwritten
 *
 * Usage:
 *   node scripts/merge-camofox-config.mjs <config-path> [flags]
 */
import fs from 'node:fs';

function fail(message) {
  console.error(`merge-camofox-config: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const configPath = argv.shift();
if (!configPath) fail('usage: merge-camofox-config.mjs <config-path> [--drop NAME] [--enable NAME]');

const drops = [];
const enables = [];
let interactiveMode = null;
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === '--drop') {
    if (!value) fail('--drop needs a plugin name');
    drops.push(value);
    i += 1;
  } else if (flag === '--enable') {
    if (!value) fail('--enable needs a plugin name');
    enables.push(value);
    i += 1;
  } else if (flag === '--interactive') {
    if (!value) fail('--interactive needs a mode (desktop|off)');
    interactiveMode = value;
    i += 1;
  } else {
    fail(`unknown flag: ${flag}`);
  }
}

let raw = null;
try {
  raw = fs.readFileSync(configPath, 'utf-8');
} catch {
  raw = null;
}
let config = {};
if (raw && raw.trim()) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    else console.error('merge-camofox-config: existing config is not an object; replacing it');
  } catch (error) {
    // Do not throw the file away silently: keep a copy so the operator can see
    // what was there, then start clean.
    const backup = `${configPath}.invalid-${Date.now()}`;
    try {
      fs.writeFileSync(backup, raw);
      console.error(`merge-camofox-config: existing config was not valid JSON; saved to ${backup}`);
    } catch {
      console.error('merge-camofox-config: existing config was not valid JSON');
    }
    config = {};
  }
}

// Normalise plugins to the object form. The loader accepts both, but only the
// object form can carry per-plugin settings, and a merge needs somewhere to put
// them.
const list = config.plugins;
if (Array.isArray(list)) {
  config.plugins = Object.fromEntries(list.map((name) => [name, { enabled: true }]));
} else if (!config.plugins || typeof config.plugins !== 'object') {
  config.plugins = {};
}

for (const name of drops) delete config.plugins[name];

for (const name of enables) {
  const existing = config.plugins[name];
  const settings = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  // Preserve other settings (vnc.resolution, persistence.profileDir, ...). A
  // plugin that is already explicitly enabled stays enabled; one that was
  // explicitly disabled stays disabled, because that is a deliberate choice.
  if (settings.enabled === undefined) settings.enabled = true;
  config.plugins[name] = settings;
}

// Only fill in what is missing. `interactive.mode` in particular must not be
// reset: "desktop" versus "off" decides whether a challenge click lands.
const defaults = {
  id: 'camofox-browser',
  name: 'Camofox Browser',
  version: '1.6.0',
  newPageTimeoutMs: 20000,
};
for (const [key, value] of Object.entries(defaults)) {
  if (config[key] === undefined) config[key] = value;
}
if (!config.interactive || typeof config.interactive !== 'object') config.interactive = {};
if (interactiveMode) {
  // Explicit request (installer): a challenge click needs a real desktop window.
  config.interactive.mode = interactiveMode;
} else if (config.interactive.mode === undefined) {
  config.interactive.mode = 'desktop';
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const enabled = Object.entries(config.plugins)
  .filter(([, v]) => v !== false && v?.enabled !== false)
  .map(([k]) => k);
console.log(`plugins enabled: ${enabled.join(', ') || '(none)'}`);
