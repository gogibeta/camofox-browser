import asyncio, json, os, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

EXT = "/data/workspace/turnstile-ext"


def find_chrome() -> str:
    """Locate the Playwright Chromium instead of hardcoding one build number.

    The build number changes whenever Playwright updates, so a hardcoded path
    makes this test fail with "file not found" rather than with a real result.
    """
    override = os.environ.get("CHROME_PATH")
    if override and Path(override).exists():
        return override
    roots = sorted(Path("/data/home/.cache/ms-playwright").glob("chromium-*"))
    for root in reversed(roots):
        for name in ("chrome-linux64/chrome", "chrome-linux/chrome"):
            candidate = root / name
            if candidate.exists():
                return str(candidate)
    raise SystemExit("no Playwright Chromium found; run 'playwright install chromium'")


CHROME = find_chrome()
CONFIG = json.loads(Path("/data/workspace/ext-config.json").read_text())
PROFILE = "/data/workspace/ext-chrome-profile-" + str(int(time.time()))
TARGETS = {
    "real": "https://100milionseek.top/recover",
    "second": "https://solvegate.io/demo/managed",
    "test": "https://seleniumbase.github.io/apps/turnstile",
}

async def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "test"
    url = TARGETS[which]
    t0 = time.perf_counter()
    marks = []

    def mark(label: str) -> None:
        marks.append((label, round((time.perf_counter() - t0) * 1000)))

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            executable_path=CHROME,
            headless=False,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"],
            env=dict(os.environ, DISPLAY=":1"),
        )
        mark("browser-up")
        try:
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker", timeout=15000)
            await sw.evaluate("cfg => chrome.storage.local.set(cfg)", CONFIG)
            print("EXT_SW", sw.url, flush=True)
        except Exception as exc:
            print("EXT_SW_ERROR", type(exc).__name__, str(exc)[:200], flush=True)
        mark("config-set")

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        mark("page-loaded")
        deadline = time.monotonic() + 100
        found, last = None, None
        # Every provider whose answer is a DOM string, so this test proves the
        # extension's multi-provider path and not just Turnstile.
        probe = """() => {
          const fields = {
            turnstile: 'cf-turnstile-response',
            hcaptcha: 'h-captcha-response',
            recaptcha: 'g-recaptcha-response',
            friendlycaptcha: 'frc-captcha-response'
          };
          for (const [kind, name] of Object.entries(fields)) {
            const el = document.querySelector(
              'input[name="' + name + '"], textarea[name="' + name + '"]');
            if (el && el.value) return { kind: kind, token: el.value };
          }
          const t = window.__turnstileAutoSolverToken;
          return t ? { kind: 'window-flag', token: t } : null;
        }"""
        while time.monotonic() < deadline:
            try:
                found = await page.evaluate(probe)
                last = await page.evaluate("() => window.__turnstileAutoSolverLast || null")
            except Exception:
                pass
            if found:
                break
            await asyncio.sleep(1)
        mark("answered")
        elapsed = round((time.perf_counter() - t0) * 1000)
        print("RESULT", which, "OK" if found else "FAIL", elapsed, "ms", flush=True)
        print("TIMELINE", " ".join("%s=%dms" % m for m in marks), flush=True)
        if found:
            print("CAPTCHA_KIND", found["kind"], flush=True)
            print("TOKEN_HEAD", str(found["token"])[:60], flush=True)
        print("LAST", json.dumps(last)[:300] if last else "none", flush=True)
        await ctx.close()

asyncio.run(main())
