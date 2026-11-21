/**
 * Force IPv4 DNS resolution in the launched Camoufox browser.
 *
 * Some cloud VMs advertise an IPv6 default route that cannot actually reach
 * Cloudflare. getaddrinfo() then returns only AAAA records for
 * challenges.cloudflare.com and Turnstile's api.js fails with NetworkError,
 * so the widget iframe is never created. Disabling IPv6 in Firefox makes it
 * use the working A records instead.
 */
export function register(_app, ctx) {
  ctx.events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = {
      ...(options.firefoxUserPrefs || {}),
      'javascript.enabled': true,
      'network.dns.disableIPv6': true,
      // Camoufox's hardened defaults can flag Cloudflare's challenge host as a
      // tracker, blocking Turnstile's api.js as a cross-site subresource.
      'browser.contentblocking.category': 'standard',
      'privacy.trackingprotection.enabled': false,
      'privacy.trackingprotection.pbmode.enabled': false,
      'privacy.trackingprotection.cryptomining.enabled': false,
      'privacy.trackingprotection.fingerprinting.enabled': false,
    };
    // camoufox-js injects its fingerprint config via CAMOU_CONFIG_<n> env vars;
    // patch that too so the pref survives Camoufox's own config application.
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
