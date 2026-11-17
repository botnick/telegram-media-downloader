"""Regression test for coalescing overlapping Telegram dialog requests.
Run: python3 tests/ui/dialog_requests.py (requires Playwright Chromium).
This tests the real helper extracted from app.js with a mocked API transport;
full app/server E2E and external Telegram performance are separate checks.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
source = (root / "core-service/internal/webassets/public/js/app.js").read_text()
match = re.search(r"let dialogsInFlight = null;\nfunction fetchDialogsShared\(\) \{[\s\S]*?\n\}", source)
assert match, "Dialog request deduplication helper missing"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("about:blank")
    page.evaluate("""(helper) => {
      window.calls = 0;
      window.failNext = false;
      window.api = {
        get: async (path) => {
          if (path !== '/api/dialogs') throw Error('unexpected path');
          window.calls++;
          await new Promise((resolve) => setTimeout(resolve, 15));
          if (window.failNext) { window.failNext = false; throw Error('Telegram unavailable'); }
          return { dialogs: [{id: '1', name: 'One'}] };
        }
      };
      // Evaluate the helper as-is, without application imports/bootstrap.
      (0, eval)(helper);
      window.runBatch = async () => Promise.all(Array.from({length: 20}, () => fetchDialogsShared()));
      window.failBatch = async () => {
        window.failNext = true;
        return Promise.allSettled(Array.from({length: 20}, () => fetchDialogsShared()));
      };
    }""", match.group(0))
    result = page.evaluate("runBatch()")
    assert len(result) == 20 and all(x == result[0] for x in result), result
    assert page.evaluate("calls") == 1, "parallel callers must share one request"
    errors = page.evaluate("failBatch()")
    assert all(item["status"] == "rejected" for item in errors), errors
    assert page.evaluate("calls") == 2, "failure batch must share one request"
    result = page.evaluate("runBatch()")
    assert len(result) == 20
    assert page.evaluate("calls") == 3, "settled or failed requests must not stick in cache"
    browser.close()
print("PASS: 20 concurrent dialog callers coalesce and failed calls retry")
