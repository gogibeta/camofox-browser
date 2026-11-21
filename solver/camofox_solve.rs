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

const TOKEN_JS: &str = r#"(() => {
  const e = document.querySelector('input[name=cf-turnstile-response]');
  return e && e.value ? e.value : '';
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

fn fullscreen_desktop() {
    let _ = Command::new("xdotool").args(["search", "--class", "camoufox"])
        .env("DISPLAY", ":1").output().map(|out| {
            let wins = String::from_utf8_lossy(&out.stdout);
            if let Some(win) = wins.lines().last() {
                let _ = Command::new("xdotool").args(["windowactivate", "--sync", win])
                    .env("DISPLAY", ":1").output();
                let _ = Command::new("xdotool").args(["windowsize", win, "1530", "619"])
                    .env("DISPLAY", ":1").output();
                let _ = Command::new("xdotool").args(["windowmove", win, "0", "0"])
                    .env("DISPLAY", ":1").output();
            }
        });
}

fn solve(cfg: &J) -> Result<String, String> {
    let url = cfg.get("url").and_then(J::as_str).ok_or("missing url")?;
    let timeout = cfg.get("timeoutMs").and_then(J::as_num).unwrap_or(45_000.0) as u64;
    let camofox_url = cfg.get("camofoxUrl").and_then(J::as_str)
        .unwrap_or("http://127.0.0.1:9377");
    let client = Client::new(camofox_url)?;

    let t0 = Instant::now();
    let tab = client.open(url)?;
    sleep(Duration::from_secs(4));
    let _ = client.evaluate(&tab, CLOSE_POPUPS_JS, 8_000);
    sleep(Duration::from_secs(1));

    let mut token = String::new();
    let mut clicked = false;
    let deadline = t0 + Duration::from_millis(timeout);
    while Instant::now() < deadline {
        if let Ok(Some(v)) = client.evaluate(&tab, TOKEN_JS, 5_000) {
            if let Some(s) = v.as_str() { token = s.to_string(); }
        }
        if !token.is_empty() { break; }
        if !clicked {
            let _ = client.evaluate(&tab, WIDGET_SCROLL_JS, 5_000);
            sleep(Duration::from_millis(400));
            if let Ok(Some(rect)) = client.evaluate(&tab, WIDGET_RECT_JS, 5_000) {
                if let (Some(x), Some(y)) = (
                    rect.get("x").and_then(J::as_num),
                    rect.get("y").and_then(J::as_num),
                ) {
                    if client.click(&tab, x as i64, y as i64).is_ok() { clicked = true; }
                }
            }
        }
        sleep(Duration::from_millis(350));
    }
    client.close(&tab);

    let duration = t0.elapsed().as_millis() as u64;
    let error = if token.is_empty() { Some("No token returned before timeout") } else { None };
    Ok(format!(
        "{{\"token\":{},\"durationMs\":{},\"error\":{},\"method\":\"camofox-rust\",\"clicked\":{},\"url\":{}}}",
        if token.is_empty() { "null".into() } else { esc(&token) },
        duration,
        error.map(esc).unwrap_or_else(|| "null".into()),
        clicked,
        esc(url)
    ))
}

fn main() {
    let raw = env::args().nth(1).unwrap_or_default();
    let decoded = b64decode(&raw).unwrap_or_else(|| raw.clone());
    let cfg = match parse_json(&decoded) {
        Ok(v) => v,
        Err(e) => {
            println!("{{\"token\":null,\"durationMs\":0,\"error\":{},\"method\":\"camofox-rust\"}}", esc(&format!("bad input: {}", e)));
            return;
        }
    };
    fullscreen_desktop();
    match solve(&cfg) {
        Ok(line) => println!("{}", line),
        Err(e) => println!("{{\"token\":null,\"durationMs\":0,\"error\":{},\"method\":\"camofox-rust\"}}", esc(&format!("{}: {}", std::any::type_name::<String>(), e))),
    }
}
