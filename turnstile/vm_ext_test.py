import asyncio, json, os, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

EXT = "/data/workspace/turnstile-ext"
CHROME = "/data/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
CONFIG = json.loads(Path("/data/workspace/ext-config.json").read_text())
PROFILE = "/data/workspace/ext-chrome-profile-" + str(int(time.time()))
TARGETS = {
    "real": "https://100milionseek.top/recover",
    "test": "https://seleniumbase.github.io/apps/turnstile",
}

async def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "test"
    url = TARGETS[which]
    t0 = time.perf_counter()
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            executable_path=CHROME,
            headless=False,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"],
            env=dict(os.environ, DISPLAY=":1"),
        )
        try:
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker", timeout=15000)
            await sw.evaluate("cfg => chrome.storage.local.set(cfg)", CONFIG)
            print("EXT_SW", sw.url, flush=True)
        except Exception as exc:
            print("EXT_SW_ERROR", type(exc).__name__, str(exc)[:200], flush=True)

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        deadline = time.monotonic() + 100
        token, last = "", None
        while time.monotonic() < deadline:
            try:
                token = await page.evaluate(
                    "() => document.querySelector('input[name=cf-turnstile-response]')?.value || window.__turnstileAutoSolverToken || ''"
                ) or ""
                last = await page.evaluate("() => window.__turnstileAutoSolverLast || null")
            except Exception:
                pass
            if token:
                break
            await asyncio.sleep(1)
        print("RESULT", which, "OK" if token else "FAIL", round((time.perf_counter() - t0) * 1000), "ms", flush=True)
        print("TOKEN_HEAD", token[:60], flush=True)
        print("LAST", json.dumps(last)[:300] if last else "none", flush=True)
        await ctx.close()

asyncio.run(main())
