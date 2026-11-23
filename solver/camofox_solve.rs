//! Rust replacement for solver/camofox_solve.py.
//! Drives the camofox-browser HTTP API directly; std-only, compiles with:
//!   rustc -O camofox_solve.rs -o camofox_solve
//! Input: base64-encoded JSON on argv[1] (or raw JSON).
//! Output: one JSON line with token / durationMs / error.

use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

// ---------- minimal JSON ----------

#[derive(Clone, Debug)]
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        if let J::Str(s) = self { Some(s) } else { None }
    }
    fn as_num(&self) -> Option<f64> {
        if let J::Num(n) = self { Some(*n) } else { None }
    }
    fn as_arr(&self) -> Option<&[J]> {
        if let J::Arr(v) = self { Some(v) } else { None }
    }
    fn as_bool(&self) -> Option<bool> {
        if let J::Bool(b) = self { Some(*b) } else { None }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self { Self { b: s.as_bytes(), i: 0 } }
    fn ws(&mut self) {
        while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() { self.i += 1; }
    }
    fn parse(&mut self) -> Result<J, String> {
        self.ws();
        if self.i >= self.b.len() { return Err("unexpected end of JSON".into()); }
        match self.b[self.i] {
            b'n' => { self.lit("null")?; Ok(J::Null) }
            b't' => { self.lit("true")?; Ok(J::Bool(true)) }
            b'f' => { self.lit("false")?; Ok(J::Bool(false)) }
            b'"' => Ok(J::Str(self.string()?)),
            b'[' => self.array(),
            b'{' => self.object(),
            b'-' | b'0'..=b'9' => self.number(),
            c => Err(format!("unexpected JSON byte {:?}", c as char)),
        }
    }
    fn lit(&mut self, s: &str) -> Result<(), String> {
        if self.b.get(self.i..self.i + s.len()) == Some(s.as_bytes()) {
            self.i += s.len(); Ok(())
        } else { Err(format!("expected {}", s)) }
    }
    fn string(&mut self) -> Result<String, String> {
        if self.b.get(self.i) != Some(&b'"') { return Err("expected string".into()); }
        self.i += 1;
        let mut out = String::new();
        while self.i < self.b.len() {
            let c = self.b[self.i];
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    if self.i >= self.b.len() { return Err("bad escape".into()); }
                    let e = self.b[self.i]; self.i += 1;
                    match e {
                        b'"' => out.push('"'), b'\\' => out.push('\\'), b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'), b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'), b'r' => out.push('\r'), b't' => out.push('\t'),
                        b'u' => {
                            if self.i + 4 > self.b.len() { return Err("bad unicode escape".into()); }
                            let hex = std::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|_| "bad unicode")?;
                            let cp = u32::from_str_radix(hex, 16).map_err(|_| "bad unicode")?;
                            self.i += 4;
                            if let Some(ch) = char::from_u32(cp) { out.push(ch); }
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                _ => out.push(c as char),
            }
        }
        Err("unterminated string".into())
    }
    fn number(&mut self) -> Result<J, String> {
        let start = self.i;
        while self.i < self.b.len()
            && matches!(self.b[self.i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
        { self.i += 1; }
        let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| "bad number")?;
        s.parse::<f64>().map(J::Num).map_err(|_| "bad number".into())
    }
    fn array(&mut self) -> Result<J, String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.b.get(self.i) == Some(&b']') { self.i += 1; return Ok(J::Arr(out)); }
            out.push(self.parse()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => { self.i += 1; return Ok(J::Arr(out)); }
                _ => return Err("bad array".into()),
            }
        }
    }
    fn object(&mut self) -> Result<J, String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.b.get(self.i) == Some(&b'}') { self.i += 1; return Ok(J::Obj(out)); }
            let k = self.string()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') { return Err("expected colon".into()); }
            self.i += 1;
            let v = self.parse()?;
            out.push((k, v));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => { self.i += 1; return Ok(J::Obj(out)); }
                _ => return Err("bad object".into()),
            }
        }
    }
}

fn parse_json(s: &str) -> Result<J, String> { Parser::new(s).parse() }

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"), c if (c as u32) < 0x20 => out.push_str("\\u0000"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------- base64 ----------

fn b64decode(input: &str) -> Option<String> {
    let clean: Vec<u8> = input.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let val = |c: u8| -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62), b'/' => Some(63), b'-' => Some(62), b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut i = 0;
    while i + 4 <= clean.len() {
        let a = val(clean[i])? as u32;
        let b = val(clean[i + 1])? as u32;
        let c = val(clean[i + 2])? as u32;
        let d = val(clean[i + 3])? as u32;
        let n = (a << 18) | (b << 12) | (c << 6) | d;
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
        out.push(n as u8);
        i += 4;
    }
    let rem = clean.len() - i;
    if rem >= 2 {
        let a = val(clean[i])? as u32;
        let b = val(clean[i + 1])? as u32;
        out.push(((a << 2) | (b >> 4)) as u8);
        if rem == 3 {
            let c = val(clean[i + 2])? as u32;
            out.push(((b << 4) | (c >> 2)) as u8);
        }
    }
    String::from_utf8(out).ok()
}

// ---------- tiny HTTP client (persistent connection) ----------

struct Conn {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
}

impl Conn {
    fn connect(addr: SocketAddr, timeout_ms: u64) -> Result<Self, String> {
        let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms))
            .map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_millis(timeout_ms))).ok();
        stream.set_write_timeout(Some(Duration::from_millis(timeout_ms))).ok();
        stream.set_nodelay(true).ok();
        let reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        Ok(Self { writer: stream, reader })
    }

    fn request(&mut self, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
        let mut req = format!("{} {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n", method, path);
        if let Some(b) = body {
            req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
        }
        req.push_str("\r\n");
        if let Some(b) = body { req.push_str(b); }
        self.writer.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        self.writer.flush().ok();

        // Status line
        let mut line = String::new();
        if self.reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("connection closed".into());
        }
        let status: u16 = line.split_whitespace().nth(1)
            .and_then(|s| s.parse().ok()).ok_or_else(|| "bad status line".to_string())?;

        // Headers
        let mut content_length: Option<usize> = None;
        let mut chunked = false;
        loop {
            let mut h = String::new();
            if self.reader.read_line(&mut h).map_err(|e| e.to_string())? == 0 { break; }
            let t = h.trim_end();
            if t.is_empty() { break; }
            let lower = t.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("content-length:") {
                content_length = v.trim().parse::<usize>().ok();
            } else if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
                chunked = true;
            }
        }

        let body_text = if chunked {
            let mut out = String::new();
            loop {
                let mut sz = String::new();
                if self.reader.read_line(&mut sz).map_err(|e| e.to_string())? == 0 { break; }
                let hex = sz.trim().split(';').next().unwrap_or("0").to_string();
                let size = usize::from_str_radix(&hex, 16).map_err(|_| "bad chunk size".to_string())?;
                if size == 0 {
                    let mut trailer = String::new();
                    let _ = self.reader.read_line(&mut trailer);
                    break;
                }
                let mut buf = vec![0u8; size + 2];
                self.reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
                out.push_str(&String::from_utf8_lossy(&buf[..size]));
            }
            out
        } else if let Some(len) = content_length {
            let mut buf = vec![0u8; len];
            self.reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&buf).to_string()
        } else {
            let mut out = String::new();
            self.reader.read_to_string(&mut out).map_err(|e| e.to_string())?;
            out
        };

        if status >= 400 {
            return Err(format!("camofox HTTP {} on {}: {}", status, path, &body_text[..body_text.len().min(300)]));
        }
        Ok(body_text)
    }
}

// ---------- JS expressions (mirrors solver/camofox_solve.py) ----------

// Click at most this many times per solve. A widget that has not accepted a
// click by then is not going to; more clicks only add noise to the challenge.
const MAX_CLICK_ATTEMPTS: u32 = 4;

// A Managed Challenge is scored by Cloudflare after the click, so give it a
// few spaced attempts rather than hammering it.
const MAX_CHALLENGE_CLICKS: u32 = 5;

// How long to keep polling after the last click before concluding the click did
// nothing. Without this the loop runs to the full timeout on every captcha whose
// answer is not reachable from here, which turns a definite "no" into a 40s wait.
const CLICK_GRACE_MS: u64 = 6_000;

// Window size applied to the Camoufox window before solving. Kept at the value
// the solver has always used: page coordinates are derived from the rendered
// layout, so changing this changes where clicks land.
const WINDOW_SIZE: (&str, &str) = ("1530", "619");

const CLOSE_POPUPS_JS: &str = r#"(() => {
  const vis = e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  let n = 0;
  document.querySelectorAll('#outage,[role=dialog],dialog,.modal,.popup').forEach(e => {
    if (vis(e) && !e.hidden) {
      e.hidden = true;
      e.style.setProperty('display', 'none', 'important');
      n++;
    }
  });
  document.querySelectorAll('[data-apology-close],[data-outage-close],[data-close],[aria-label*=Close i]')
    .forEach(e => { try { e.click(); n++; } catch (_) {} });
  return n;
})()"#;

const WIDGET_SCROLL_JS: &str = r#"(() => {
  const el = (function() {
  const vis = e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' &&
      r.width >= 150 && r.height >= 40;
  };
  const seen = new Set();
  const cands = [];
  const add = e => {
    if (!e || seen.has(e) || !vis(e)) return;
    seen.add(e);
    cands.push(e);
  };
  document.querySelectorAll('.cf-turnstile[data-sitekey], [data-sitekey]').forEach(add);
  document.querySelectorAll(
    '.cf-turnstile, [id^=cf-turnstile], [class*=turnstile]'
  ).forEach(add);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  return cands[0];
})();
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  if (!inView) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  return true;
})()"#;

const WIDGET_RECT_JS: &str = r#"(() => {
  const el = (function() {
  const vis = e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' &&
      r.width >= 150 && r.height >= 40;
  };
  const seen = new Set();
  const cands = [];
  const add = e => {
    if (!e || seen.has(e) || !vis(e)) return;
    seen.add(e);
    cands.push(e);
  };
  document.querySelectorAll('.cf-turnstile[data-sitekey], [data-sitekey]').forEach(add);
  document.querySelectorAll(
    '.cf-turnstile, [id^=cf-turnstile], [class*=turnstile]'
  ).forEach(add);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  return cands[0];
})();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 150 || r.height < 40) return null;
  return {
    x: Math.round(Math.max(1, Math.min(r.left + 30, r.right - 2))),
    y: Math.round(Math.max(1, Math.min(r.top + r.height / 2, r.bottom - 2))),
  };
})()"#;

// ---------- managed-challenge (interstitial) mode ----------

// A Cloudflare Managed Challenge is not a Turnstile widget: the page carries no
// sitekey, no `.cf-turnstile` element and no response field. It renders only an
// obfuscated shell plus a cross-origin iframe at challenges.cloudflare.com, and
// success is signalled by a `cf_clearance` cookie (httpOnly, so it must be read
// from the cookie jar) rather than by a token on the page.
//
// Only signals that are specific to an interstitial belong here. Generic
// containers (`.main-wrapper`) false-positive on ordinary pages that happen to
// use that class, which made a Turnstile widget page look like a challenge.
const PAGE_STATE_JS: &str = r#"(() => {
  const t = document.title || '';
  const challengeTitle = /just a moment|verify you are human|checking your browser|attention required|one more step/i.test(t);
  const hasOpts = typeof window._cf_chl_opt === 'object' && window._cf_chl_opt !== null;
  const shell = !!document.querySelector(
    '#challenge-form, #challenge-stage, #challenge-body-text, #challenge-running'
  );
  const body = document.body ? document.body.innerText.slice(0, 400) : '';
  const bodyShell = /performing security verification|verify you are human|checking your browser/i.test(body);
  return {
    title: t,
    challenge: challengeTitle || hasOpts || shell || bodyShell,
    url: location.href,
    bodyLen: body.length,
  };
})()"#;

// Every captcha response field worth reading, keyed by the field's `name`.
//
// This is the whole of "solve every captcha type" from the solver's side: a
// captcha's answer is a string in a named field, and which field it is depends
// only on the provider. Turnstile and a Cloudflare managed challenge share
// `cf-turnstile-response`; the rest each have their own. Reading them all costs
// one querySelector pass and means a page carrying an hCaptcha is not reported
// as "no widget".
//
// Widgets whose answer is never a DOM string (image grids, sliders, FunCaptcha)
// are absent on purpose: there is nothing to read, and inventing a field would
// only produce false successes. The browser-side plugin reports those.
//
// Read the first populated captcha response field on the page.
//
// `kind` names which provider answered, so a caller can tell a Turnstile token
// from an hCaptcha token without guessing from its shape.
const ANY_TOKEN_JS: &str = r#"(() => {
  const fields = [
    ['turnstile', 'cf-turnstile-response'],
    ['hcaptcha', 'h-captcha-response'],
    ['recaptcha', 'g-recaptcha-response'],
    ['friendlycaptcha', 'frc-captcha-response'],
    ['geetest', 'geetest_validate'],
    ['funcaptcha', 'fc-token'],
    ['awswaf', 'aws-waf-token']
  ];
  for (const [kind, name] of fields) {
    const el = document.querySelector('input[name="' + name + '"], textarea[name="' + name + '"]');
    if (el && el.value) return { kind: kind, field: name, token: el.value };
  }
  // hCaptcha and reCAPTCHA sometimes only expose the token through a callback
  // store; a populated global is the only readable signal in that case.
  try {
    const h = window.hcaptcha;
    if (h && typeof h.getResponse === 'function') {
      const r = h.getResponse();
      if (r) return { kind: 'hcaptcha', field: 'h-captcha-response', token: r };
    }
  } catch (_) {}
  try {
    const g = window.grecaptcha;
    if (g && g.getResponse) {
      const r = g.getResponse();
      if (r) return { kind: 'recaptcha', field: 'g-recaptcha-response', token: r };
    }
  } catch (_) {}
  return null;
})()"#;

// Locate any click-through captcha widget on the page, for the coordinate-click
// fallback.
//
// Turnstile and Cloudflare are handled by CHALLENGE_TARGET_JS below; this covers
// the others by their frame URL, which is the only reliable handle: the widget
// is cross-origin, so its internals are unreadable, and its host element is
// usually an obfuscated div.
const ANY_WIDGET_JS: &str = r#"(() => {
  const out = [];
  const push = (el, kind) => {
    if (!el) return;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return; }
    if (!r || r.width < 20 || r.height < 15) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    // A panel is a puzzle, not a checkbox. Clicking its corner is worse than
    // doing nothing.
    if (r.height >= 220 || (r.width >= 320 && r.height >= 180)) return;
    out.push({
      kind: kind,
      x: Math.round(Math.min(Math.max(0, r.left) + Math.max(12, Math.min(30, r.width * 0.15)), Math.min(r.right, innerWidth) - 2)),
      y: Math.round(Math.min(Math.max(0, r.top) + r.height / 2, innerHeight - 2)),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  };
  const patterns = [
    ['hcaptcha', /(?:newassets|assets|js)\.hcaptcha\.com|hcaptcha\.com\/1\/api\.js/i],
    ['recaptcha', /(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2\/)?anchor/i],
    ['friendlycaptcha', /friendlycaptcha\.com|frcapi\.com/i],
    ['geetest', /geetest\.com|geevisit\.com/i],
    ['funcaptcha', /arkoselabs\.com|funcaptcha\.(?:com|co)/i],
    ['awswaf', /captcha\.awswaf\.com/i]
  ];
  // The frame element may sit in a shadow root, so walk those too.
  const roots = [document];
  const seen = new Set(roots);
  for (let i = 0; i < roots.length && i < 40; i++) {
    let els;
    try { els = roots[i].querySelectorAll('*'); } catch (_) { continue; }
    for (const el of els) {
      if (el.tagName === 'IFRAME') {
        let src = '';
        try { src = el.src || ''; } catch (_) {}
        if (/aframe|size=invisible|checkbox=false/i.test(src)) continue;
        for (const [kind, re] of patterns) {
          if (re.test(src)) { push(el, kind); break; }
        }
      }
      let sr = null;
      try { sr = el.shadowRoot || el.shadowRootUnl || null; } catch (_) { sr = null; }
      if (sr && !seen.has(sr)) { seen.add(sr); roots.push(sr); }
    }
  }
  return { targets: out.slice(0, 4), shadowRoots: roots.length - 1 };
})()"#;

// Locate a clickable target in a Managed Challenge.
//
// The widget iframe is NOT in the top document: Cloudflare puts it inside a
// shadow root, so `document.querySelectorAll('iframe')` finds nothing and a
// naive selector-based solver reports "no widget". This walks shadow roots
// (open ones, plus Camoufox's `shadowRootUnl` bypass) to find the frame, then
// returns page-relative coordinates.
//
// The click is dispatched at page coordinates rather than inside the frame,
// because Firefox's Fission isolation blocks programmatic clicks that
// originate inside a cross-origin child frame.
const CHALLENGE_TARGET_JS: &str = r#"(() => {
  const out = [];
  const pushRect = (el, kind) => {
    if (!el) return;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return; }
    if (!r || r.width < 20 || r.height < 15) return;
    // Reject anything that is not actually on screen.
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    out.push({
      kind: kind,
      x: Math.round(Math.min(Math.max(0, r.left) + Math.max(16, Math.min(30, r.width * 0.15)), Math.min(r.right, innerWidth) - 2)),
      y: Math.round(Math.min(Math.max(0, r.top) + r.height / 2, innerHeight - 2)),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  };
  const isCfFrame = (src) => /challenges\.cloudflare\.com|challenge-platform|\/cdn-cgi\//.test(src || '');

  // Breadth-first walk over the light DOM and every reachable shadow root.
  const roots = [document];
  const seen = new Set(roots);
  for (let i = 0; i < roots.length && i < 40; i++) {
    const root = roots[i];
    let els;
    try { els = root.querySelectorAll('*'); } catch (_) { continue; }
    for (const el of els) {
      if (out.length >= 4 && roots.length > 8) break;
      // The Turnstile frame itself.
      if (el.tagName === 'IFRAME' && isCfFrame(el.src)) pushRect(el, 'iframe');
      // Older / alternate checkbox markup.
      if (el.tagName === 'INPUT' && el.type === 'checkbox') pushRect(el, 'checkbox');
      const role = el.getAttribute && el.getAttribute('role');
      if (role === 'checkbox') pushRect(el, 'role');
      if (el.classList && el.classList.contains('ctp-checkbox-label')) pushRect(el, 'label');
      // Descend into shadow trees (open or bypass-enabled).
      let sr = null;
      try { sr = el.shadowRoot || el.shadowRootUnl || null; } catch (_) { sr = null; }
      if (sr && !seen.has(sr)) { seen.add(sr); roots.push(sr); }
    }
  }

  // Last resort: the obfuscated wrapper div — wide, short, below the header.
  if (!out.length) {
    let best = null;
    document.querySelectorAll('div').forEach(d => {
      let r;
      try { r = d.getBoundingClientRect(); } catch (_) { return; }
      if (r.width >= 200 && r.width <= 460 && r.height >= 40 && r.height <= 100 && r.top > 0) {
        if (!best || r.width * r.height < best.w * best.h) best = { w: r.width, h: r.height, el: d };
      }
    });
    if (best) pushRect(best.el, 'wrapper');
  }
  return { targets: out.slice(0, 4), shadowRoots: roots.length - 1 };
})()"#;

// ---------- solver ----------

struct Client {
    host: String,
    port: u16,
    uid: String,
    conn: std::cell::RefCell<Option<Conn>>,
    addr: SocketAddr,
}

impl Client {
    fn new(url: &str) -> Result<Self, String> {
        let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))
            .ok_or_else(|| "camofoxUrl must be http://".to_string())?;
        let mut parts = rest.splitn(2, '/');
        let authority = parts.next().unwrap_or("127.0.0.1:9377");
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(9377)),
            None => (authority.to_string(), 9377),
        };
        let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?
            .next().ok_or_else(|| "no address".to_string())?;
        Ok(Self {
            host, port,
            uid: format!("solve-{}", std::process::id()),
            conn: std::cell::RefCell::new(None),
            addr,
        })
    }

    fn call(&self, method: &str, path: &str, body: &str, timeout_ms: u64) -> Result<J, String> {
        let mut guard = self.conn.borrow_mut();
        if guard.is_none() {
            *guard = Some(Conn::connect(self.addr, timeout_ms)?);
        }
        let attempt = guard.as_mut().unwrap().request(method, path, Some(body));
        let raw = match attempt {
            Ok(v) => v,
            Err(_) => {
                // Reconnect once (server may have closed the keep-alive).
                *guard = Some(Conn::connect(self.addr, timeout_ms)?);
                guard.as_mut().unwrap().request(method, path, Some(body))?
            }
        };
        parse_json(&raw).map_err(|e| format!("bad JSON from {}: {} (body: {})", path, e, &raw[..raw.len().min(200)]))
    }
    fn open(&self, url: &str) -> Result<String, String> {
        let body = format!(
            "{{\"userId\":{},\"sessionKey\":{},\"url\":{}}}",
            esc(&self.uid), esc(&format!("rust-{}", std::process::id())), esc(url)
        );
        let res = self.call("POST", "/tabs", &body, 60_000)?;
        res.get("tabId").and_then(J::as_str).map(str::to_string)
            .ok_or_else(|| "camofox /tabs returned no tabId".into())
    }
    fn evaluate(&self, tab: &str, expr: &str, timeout_ms: u64) -> Result<Option<J>, String> {
        let body = format!(
            "{{\"userId\":{},\"expression\":{},\"timeoutMs\":{}}}",
            esc(&self.uid), esc(expr), timeout_ms
        );
        let res = self.call("POST", &format!("/tabs/{}/evaluate", tab), &body, timeout_ms + 10_000)?;
        Ok(res.get("result").cloned())
    }
    fn click(&self, tab: &str, x: i64, y: i64) -> Result<(), String> {
        let body = format!(
            "{{\"userId\":{},\"coordinates\":{{\"x\":{},\"y\":{}}}}}",
            esc(&self.uid), x, y
        );
        self.call("POST", &format!("/tabs/{}/click", tab), &body, 12_000)?;
        Ok(())
    }

    /// Read cf_clearance from the server-side cookie jar.
    ///
    /// The cookie is httpOnly, so it is invisible to `document.cookie` and to
    /// page evaluate. The storage-state export (a raw Playwright state object)
    /// is the only way to see it.
    fn clearance(&self) -> Option<String> {
        let state = self.call(
            "GET",
            &format!("/sessions/{}/storage_state", self.uid),
            "",
            20_000,
        ).ok()?;
        let cookies = state.get("cookies")?;
        for c in cookies.as_arr()? {
            if c.get("name").and_then(J::as_str) == Some("cf_clearance") {
                if let Some(v) = c.get("value").and_then(J::as_str) {
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
        None
    }
    fn close(&self, tab: &str) {
        let mut guard = self.conn.borrow_mut();
        if guard.is_none() {
            if let Ok(c) = Conn::connect(self.addr, 10_000) { *guard = Some(c); }
        }
        if let Some(c) = guard.as_mut() {
            let _ = c.request("DELETE", &format!("/tabs/{}?userId={}", tab, self.uid), None);
        }
    }
}

/// Bring the Camoufox window to the foreground and size it.
///
/// Why this exists: a Managed Challenge's click is delivered through a real OS
/// pointer event, and a background/unmapped window can swallow it.
///
/// Why it is fully detached: `xdotool windowactivate --sync` waits for the
/// window manager to confirm the activation, which took 15s on a headful Xvfb
/// host — 75% of the whole solve. Nothing here is worth waiting for, so every
/// call runs detached and its exit status is ignored. `WINDOW_SIZE` matches the
/// viewport camofox is told to use, so page coordinates stay stable.
fn fullscreen_desktop() {
    let run = |args: &[&str]| {
        let _ = Command::new("xdotool")
            .args(args)
            .env("DISPLAY", ":1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    };
    // `--sync` is deliberately absent: it is the call that blocked.
    if let Ok(out) = Command::new("xdotool")
        .args(["search", "--class", "camoufox"])
        .env("DISPLAY", ":1")
        .output()
    {
        let wins = String::from_utf8_lossy(&out.stdout);
        if let Some(win) = wins.lines().last() {
            let win = win.trim();
            if !win.is_empty() {
                run(&["windowactivate", win]);
                run(&["windowsize", win, WINDOW_SIZE.0, WINDOW_SIZE.1]);
                run(&["windowmove", win, "0", "0"]);
            }
        }
    }
}

fn solve(cfg: &J) -> Result<String, String> {
    let url = cfg.get("url").and_then(J::as_str).ok_or("missing url")?;
    let timeout = cfg.get("timeoutMs").and_then(J::as_num).unwrap_or(45_000.0) as u64;
    let camofox_url = cfg.get("camofoxUrl").and_then(J::as_str)
        .unwrap_or("http://127.0.0.1:9377");
    // "auto" (default) handles both: a Turnstile widget returns a token, a
    // Managed Challenge returns a cf_clearance cookie. "widget" / "challenge"
    // force one interpretation.
    let mode = cfg.get("mode").and_then(J::as_str).unwrap_or("auto");
    // Opt-in trace on stderr. stdout must stay a single JSON line, so all
    // diagnostics go to stderr and are only emitted when `debug` is set.
    let debug = cfg.get("debug").and_then(J::as_bool).unwrap_or(false);
    macro_rules! trace {
        ($($arg:tt)*) => { if debug { eprintln!("[solve] {}", format!($($arg)*)); } };
    }
    let client = Client::new(camofox_url)?;

    let t0 = Instant::now();
    let tab = client.open(url)?;
    sleep(Duration::from_secs(4));
    let _ = client.evaluate(&tab, CLOSE_POPUPS_JS, 8_000);
    sleep(Duration::from_secs(1));

    let mut token = String::new();
    // Which provider answered, when the answer was a token. Reported so a caller
    // does not have to guess a token's kind from its shape.
    let mut token_kind = String::new();
    let mut clearance = String::new();
    let mut challenge_seen = false;
    let mut clicked = false;
    let deadline = t0 + Duration::from_millis(timeout);

    // Retry the click, but bound it: a cold browser has no clickable widget
    // iframe for the first second or two, so one attempt is too few; clicking
    // every couple of seconds for the whole timeout is too many.
    let mut next_click_at = Instant::now();
    let mut click_attempts = 0u32;
    // A Managed Challenge needs a separate budget: the click lands in a
    // cross-origin frame and Cloudflare then scores the session, so a couple of
    // attempts spaced 3s apart is the useful shape.
    let mut challenge_clicks = 0u32;
    let mut next_challenge_click_at = Instant::now();
    let mut quiet_samples = 0u32;
    // Reading the cookie jar is a full storage-state export, which is far too
    // heavy to do on every 350ms tick. Poll it on its own slower clock.
    let mut next_clearance_check_at = Instant::now();
    // Set when every click attempt has been spent. The loop then waits only
    // CLICK_GRACE_MS for the effect to show before reporting failure, instead of
    // idling until the caller's timeout.
    let mut exhausted_at: Option<Instant> = None;

    while Instant::now() < deadline {
        // --- widget signal: a response field carrying a real token ---
        // Any provider, not just Turnstile: hCaptcha, reCAPTCHA, FriendlyCaptcha
        // and the rest each have their own field, and all of them are readable
        // the same way.
        if mode != "challenge" {
            match client.evaluate(&tab, ANY_TOKEN_JS, 5_000) {
                Ok(Some(v)) => {
                    if let Some(s) = v.get("token").and_then(J::as_str) {
                        token = s.to_string();
                        token_kind = v.get("kind").and_then(J::as_str).unwrap_or("").to_string();
                    }
                }
                Ok(None) => trace!("token: no result"),
                Err(e) => trace!("token: evaluate error: {}", e),
            }
            if !token.is_empty() { trace!("token found ({})", token_kind); break; }
        }

        // --- challenge signal: cf_clearance in the cookie jar ---
        // Checked on a slow clock, not every tick.
        if mode != "widget" && clearance.is_empty() && Instant::now() >= next_clearance_check_at {
            next_clearance_check_at = Instant::now() + Duration::from_millis(1_500);
            match client.clearance() {
                Some(c) => { trace!("cf_clearance found"); clearance = c; break; }
                None => trace!("cf_clearance: absent"),
            }
        }

        // --- is this an interstitial at all? ---
        let mut on_challenge = false;
        match client.evaluate(&tab, PAGE_STATE_JS, 5_000) {
            Ok(Some(state)) => {
                on_challenge = state.get("challenge").and_then(J::as_bool).unwrap_or(false);
                trace!("state: challenge={} title={:?}", on_challenge,
                       state.get("title").and_then(J::as_str).unwrap_or(""));
            }
            Ok(None) => trace!("state: no result"),
            Err(e) => trace!("state: evaluate error: {}", e),
        }
        if on_challenge {
            challenge_seen = true;
            quiet_samples = 0;
        } else if challenge_seen {
            // Left the interstitial. Cloudflare sets cf_clearance on the way
            // out, so re-check before declaring failure.
            quiet_samples += 1;
            if quiet_samples >= 2 {
                if let Some(c) = client.clearance() { clearance = c; }
                if !clearance.is_empty() { break; }
            }
        }

        if on_challenge && mode != "widget" && challenge_clicks < MAX_CHALLENGE_CLICKS
            && Instant::now() >= next_challenge_click_at
        {            next_challenge_click_at = Instant::now() + Duration::from_millis(3_000);
            challenge_clicks += 1;
            // The cloudflarefix plugin solves interstitials in-process, where it
            // has the real Page and can click the frame *element*. A coordinate
            // click from out here never reaches the widget (it lives in a
            // cross-origin child frame) and on some sites blocks for 28s in a
            // native mouse move. So give the plugin the first pass, and only
            // fall back to a coordinate click on later passes.
            if challenge_clicks >= 2 {
                if let Ok(Some(found)) = client.evaluate(&tab, CHALLENGE_TARGET_JS, 5_000) {
                    let list = found.get("targets").and_then(J::as_arr)
                        .or_else(|| found.as_arr());
                    match list.and_then(|l| l.first()) {
                        Some(first) => {
                            if let (Some(x), Some(y)) = (
                                first.get("x").and_then(J::as_num),
                                first.get("y").and_then(J::as_num),
                            ) {
                                trace!("coordinate click {},{} ({:?})", x, y,
                                       first.get("kind").and_then(J::as_str));
                                match client.click(&tab, x as i64, y as i64) {
                                    Ok(()) => { clicked = true; trace!("click ok"); }
                                    Err(e) => trace!("click error: {}", e),
                                }
                            }
                        }
                        None => trace!("no clickable target; plugin owns this one"),
                    }
                }
            } else {
                trace!("pass 1: leaving the click to the cloudflarefix plugin");
            }
        } else if !on_challenge && click_attempts < MAX_CLICK_ATTEMPTS
            && Instant::now() >= next_click_at
            && mode != "challenge"
        {
            // --- embedded widget path (unchanged behaviour) ---
            next_click_at = Instant::now() + Duration::from_millis(4_000);
            click_attempts += 1;
            let _ = client.evaluate(&tab, WIDGET_SCROLL_JS, 5_000);
            sleep(Duration::from_millis(400));
            // Turnstile first (it has precise rects), then any other provider's
            // widget. A page can carry only one captcha in practice, so the
            // first hit is the right one.
            let mut rect = None;
            match client.evaluate(&tab, WIDGET_RECT_JS, 5_000) {
                Ok(Some(v)) if v.get("x").is_some() => rect = Some(v),
                Ok(_) => {}
                Err(e) => trace!("widget: evaluate error: {}", e),
            }
            if rect.is_none() {
                if let Ok(Some(v)) = client.evaluate(&tab, ANY_WIDGET_JS, 5_000) {
                    let list = v.get("targets").and_then(J::as_arr);
                    if let Some(first) = list.and_then(|l| l.first()) {
                        if first.get("x").is_some() {
                            trace!("other captcha widget: {:?}",
                                   first.get("kind").and_then(J::as_str));
                            rect = Some(first.clone());
                        }
                    }
                }
            }
            if let Some(rect) = rect {
                if let (Some(x), Some(y)) = (
                    rect.get("x").and_then(J::as_num),
                    rect.get("y").and_then(J::as_num),
                ) {
                    trace!("widget click {},{}", x, y);
                    if client.click(&tab, x as i64, y as i64).is_ok() { clicked = true; }
                } else {
                    trace!("widget: no rect");
                }
            } else {
                trace!("widget: no result");
            }
        } else if !on_challenge && click_attempts >= MAX_CLICK_ATTEMPTS && exhausted_at.is_none() {
            // Every click has been spent and no token has appeared. Clicking
            // again cannot help, so stop after a short grace period rather than
            // waiting out the caller's whole timeout.
            exhausted_at = Some(Instant::now());
        }
        if let Some(at) = exhausted_at {
            if at.elapsed().as_millis() as u64 >= CLICK_GRACE_MS {
                trace!("click attempts exhausted; giving up early");
                break;
            }
        }
        sleep(Duration::from_millis(350));
    }
    client.close(&tab);

    // Final sweep: a challenge may clear right as we stop clicking.
    if token.is_empty() && clearance.is_empty() && mode != "widget" {
        if let Some(c) = client.clearance() { clearance = c; }
    }

    let duration = t0.elapsed().as_millis() as u64;
    let ok = !token.is_empty() || !clearance.is_empty();
    let error = if ok {
        None
    } else if challenge_seen || mode == "challenge" {
        Some("Cloudflare challenge did not clear before timeout")
    } else if clicked {
        // A widget was found and clicked, but its answer never appeared. That is
        // the honest description for an image grid or a slider, whose answer
        // does not exist in the DOM and cannot be produced from out here.
        Some("captcha widget found and clicked, but it needs a human (image grid or slider)")
    } else {
        Some("No captcha token returned before timeout")
    };
    // Which provider answered. A token's kind comes from the field it was read
    // from; a clearance is always Cloudflare's managed challenge.
    let kind = if !token_kind.is_empty() {
        token_kind.clone()
    } else if !clearance.is_empty() {
        "cf-managed".to_string()
    } else {
        String::new()
    };
    let result = if !token.is_empty() {
        "token"
    } else if !clearance.is_empty() {
        "clearance"
    } else {
        "none"
    };
    Ok(format!(
        "{{\"token\":{},\"clearance\":{},\"result\":{},\"captcha\":{},\"challenge\":{},\"durationMs\":{},\"error\":{},\"method\":\"camofox-rust\",\"clicked\":{},\"url\":{}}}",
        if token.is_empty() { "null".into() } else { esc(&token) },
        if clearance.is_empty() { "null".into() } else { esc(&clearance) },
        esc(result),
        if kind.is_empty() { "null".to_string() } else { esc(&kind) },
        challenge_seen,
        duration,
        error.map(esc).unwrap_or_else(|| "null".into()),
        clicked,
        esc(url)
    ))
}

fn main() {
    let t_start = Instant::now();
    let raw = env::args().nth(1).unwrap_or_default();
    let decoded = b64decode(&raw).unwrap_or_else(|| raw.clone());
    let cfg = match parse_json(&decoded) {
        Ok(v) => v,
        Err(e) => {
            println!("{{\"token\":null,\"durationMs\":0,\"error\":{},\"method\":\"camofox-rust\"}}", esc(&format!("bad input: {}", e)));
            return;
        }
    };
    let debug = cfg.get("debug").and_then(J::as_bool).unwrap_or(false);
    if debug { eprintln!("[solve] cfg parsed at {}ms", t_start.elapsed().as_millis()); }
    fullscreen_desktop();
    if debug { eprintln!("[solve] fullscreen done at {}ms", t_start.elapsed().as_millis()); }
    match solve(&cfg) {
        Ok(line) => {
            if debug { eprintln!("[solve] solve returned at {}ms", t_start.elapsed().as_millis()); }
            println!("{}", line);
            if debug { eprintln!("[solve] printed at {}ms", t_start.elapsed().as_millis()); }
        }
        Err(e) => println!("{{\"token\":null,\"durationMs\":0,\"error\":{},\"method\":\"camofox-rust\"}}", esc(&format!("{}: {}", std::any::type_name::<String>(), e))),
    }
    if debug { eprintln!("[solve] exiting at {}ms", t_start.elapsed().as_millis()); }
}
