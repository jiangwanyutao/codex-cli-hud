"""Evaluate CC Switch expressions in a network-disabled browser Web Worker.

The worker has no Node/Python/file/process APIs. The host performs validated HTTP.
Only JSON crosses stdin/stdout; browser logs and script errors are never relayed.
Requires the already installed Playwright Python package and Chrome/Edge.
"""
import json
import os
from pathlib import Path
import sys

WORKER = r"""
self.onmessage = async ({data}) => {
  try {
    const config = (0, eval)(data.code);
    const result = data.stage === 'request' ? config.request : await config.extractor(data.response);
    const json = JSON.stringify(result);
    if (typeof json !== 'string' || json.length > 262144) throw new Error();
    self.postMessage({ok:true, json});
  } catch { self.postMessage({ok:false}); }
};
"""


def main():
    payload = json.loads(sys.stdin.read(1048577))
    if len(payload.get("code", "")) > 65536:
        raise ValueError()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        candidates = [
            Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
            Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe",
        ]
        executable = next((str(v) for v in candidates if v.is_file()), None)
        kwargs = {"executable_path": executable} if executable else {}
        browser = p.chromium.launch(headless=True, args=["--disable-background-networking", "--js-flags=--max-old-space-size=64"], **kwargs)
        context = browser.new_context(service_workers="block", offline=True)
        context.route("**/*", lambda route: route.abort())
        page = context.new_page()
        page.set_content('''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none'; form-action 'none';">''')
        result = page.evaluate("""({worker, payload}) => new Promise(resolve => {
          const url = URL.createObjectURL(new Blob([worker], {type:'text/javascript'}));
          const task = new Worker(url);
          const done = value => { clearTimeout(timer); task.terminate(); URL.revokeObjectURL(url); resolve(value); };
          const timer = setTimeout(() => done({ok:false, reason:'timeout'}), 1500);
          task.onmessage = event => done(event.data);
          task.onerror = () => done({ok:false});
          task.postMessage(payload);
        })""", {"worker": WORKER, "payload": payload})
        context.close()
        browser.close()
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print('{"ok":false,"reason":"sandbox-unavailable"}')
    except Exception:
        print('{"ok":false,"reason":"script-error"}')
