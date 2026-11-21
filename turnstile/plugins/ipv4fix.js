export function register(_app, ctx) {
  ctx.events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = {
      ...(options.firefoxUserPrefs || {}),
      'javascript.enabled': true,
      'network.dns.disableIPv6': true,
      'browser.contentblocking.category': 'standard',
      'privacy.trackingprotection.enabled': false,
      'privacy.trackingprotection.pbmode.enabled': false,
      'privacy.trackingprotection.cryptomining.enabled': false,
      'privacy.trackingprotection.fingerprinting.enabled': false,
    };
    try {
      const key = Object.keys(options.env || {}).find(k => /^CAMOU_CONFIG_/.test(k));
      if (key) {
        const cfg = JSON.parse(options.env[key]);
        cfg['javascript.enabled'] = true;
        cfg['network.dns.disableIPv6'] = true;
        cfg['browser.contentblocking.category'] = 'standard';
        cfg['privacy.trackingprotection.enabled'] = false;
        cfg['privacy.trackingprotection.pbmode.enabled'] = false;
        options.env[key] = JSON.stringify(cfg);
      }
    } catch {}
    ctx.log('info', 'ipv4fix: disabled IPv6 DNS in Camoufox');
  });
}
