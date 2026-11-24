import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'merge-camofox-config.mjs');

function withConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-merge-'));
  const file = path.join(dir, 'camofox.config.json');
  if (initial !== undefined) {
    fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  }
  return {
    file,
    run: (...flags) => execFileSync(process.execPath, [SCRIPT, file, ...flags], { encoding: 'utf-8' }),
    read: () => JSON.parse(fs.readFileSync(file, 'utf-8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('merge-camofox-config', () => {
  test('creates a usable config from nothing', () => {
    const c = withConfig(undefined);
    try {
      c.run('--enable', 'captchafix');
      const cfg = c.read();
      expect(cfg.plugins.captchafix).toEqual({ enabled: true });
      expect(cfg.id).toBe('camofox-browser');
      expect(cfg.interactive.mode).toBe('desktop');
    } finally {
      c.cleanup();
    }
  });

  test('promotes the array plugin form to the object form', () => {
    const c = withConfig({ plugins: ['youtube', 'persistence'] });
    try {
      c.run('--enable', 'captchafix');
      const cfg = c.read();
      expect(Array.isArray(cfg.plugins)).toBe(false);
      expect(cfg.plugins.youtube).toEqual({ enabled: true });
      expect(cfg.plugins.captchafix).toEqual({ enabled: true });
    } finally {
      c.cleanup();
    }
  });

  // The regression that motivated the merge: a re-deploy used to overwrite the
  // config, silently deleting a plugin the operator had enabled.
  test('preserves a plugin the config already enabled', () => {
    const c = withConfig({ plugins: { vnc: { enabled: true, resolution: '1920x1080' } } });
    try {
      c.run('--enable', 'captchafix');
      const cfg = c.read();
      expect(cfg.plugins.vnc).toEqual({ enabled: true, resolution: '1920x1080' });
    } finally {
      c.cleanup();
    }
  });

  // "disabled" is a deliberate choice, not an absence to be filled in.
  test('leaves an explicitly disabled plugin disabled', () => {
    const c = withConfig({ plugins: { vnc: { enabled: false, resolution: '1280x720' } } });
    try {
      c.run('--enable', 'vnc');
      const cfg = c.read();
      expect(cfg.plugins.vnc.enabled).toBe(false);
      expect(cfg.plugins.vnc.resolution).toBe('1280x720');
    } finally {
      c.cleanup();
    }
  });

  test('drops superseded plugins', () => {
    const c = withConfig({ plugins: { ipv4fix: { enabled: true }, cloudflarefix: { enabled: true } } });
    try {
      c.run('--drop', 'ipv4fix', '--drop', 'cloudflarefix', '--enable', 'captchafix');
      const cfg = c.read();
      expect(cfg.plugins.ipv4fix).toBeUndefined();
      expect(cfg.plugins.cloudflarefix).toBeUndefined();
      expect(cfg.plugins.captchafix).toEqual({ enabled: true });
    } finally {
      c.cleanup();
    }
  });

  // "desktop" vs "off" decides whether a challenge click lands, so a re-install
  // must not reset it by accident; only an explicit flag changes it.
  test('does not reset interactive.mode unless asked', () => {
    const c = withConfig({ interactive: { mode: 'off' } });
    try {
      c.run('--enable', 'captchafix');
      expect(c.read().interactive.mode).toBe('off');
      c.run('--interactive', 'desktop');
      expect(c.read().interactive.mode).toBe('desktop');
    } finally {
      c.cleanup();
    }
  });

  test('backs up an unparseable config instead of discarding it', () => {
    const c = withConfig('{ not json');
    try {
      c.run('--enable', 'captchafix');
      const dir = path.dirname(c.file);
      const backups = fs.readdirSync(dir).filter((n) => n.includes('.invalid-'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe('{ not json');
      expect(c.read().plugins.captchafix).toEqual({ enabled: true });
    } finally {
      c.cleanup();
    }
  });

  test('does not overwrite existing tuning values', () => {
    const c = withConfig({ newPageTimeoutMs: 5000, name: 'Custom' });
    try {
      c.run('--enable', 'captchafix');
      const cfg = c.read();
      expect(cfg.newPageTimeoutMs).toBe(5000);
      expect(cfg.name).toBe('Custom');
    } finally {
      c.cleanup();
    }
  });

  test('rejects an unknown flag instead of silently ignoring it', () => {
    const c = withConfig({});
    try {
      expect(() => c.run('--nonsense')).toThrow();
    } finally {
      c.cleanup();
    }
  });
});
