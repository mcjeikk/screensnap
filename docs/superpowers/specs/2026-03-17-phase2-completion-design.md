# Phase 2 Completion: E2E Tests + Error Monitoring

**Date:** 2026-03-17
**Status:** Draft
**Scope:** Complete Phase 2 (Core Robustness) with two remaining items

---

## 1. Error Monitoring — Circular Buffer in Logger

### Goal

Capture WARN and ERROR logs in a persistent ring buffer so production issues can be diagnosed without needing to reproduce them with DevTools open.

### Design

Extend the existing `utils/logger.js` `Logger` class. No new files.

**Ring buffer behavior:**
- Max 50 entries (oldest evicted when full)
- Only captures WARN and ERROR levels (not DEBUG/INFO)
- Each entry: `{ timestamp: string, module: string, level: string, message: string }`
- `message` captures the first two arguments: first is stringified via `String(arg)`, second (if Error) uses `err.message + err.stack` truncated to 200 chars. This covers the common pattern `log.error('Save failed', error)`.
- Buffer lives in module-level `let errorBuffer = []` shared across all Logger instances

**Where the capture happens:**
- Inside the private `#log()` method, gated by `level >= LOG_LEVELS.WARN`. This is DRY and guarantees capture for any WARN/ERROR regardless of which public method was called.
- `#log()` has access to `this.#module` to populate the `module` field of each entry.

**Persistence:**
- Flush to `chrome.storage.local` under key `errorLog`
- ERROR level: flush immediately (no debounce) — prevents data loss if the MV3 service worker is terminated shortly after
- WARN level: debounced flush, at most once per 5 seconds, to avoid storage write storms
- The debounce uses `setTimeout`. If the SW is terminated before the timer fires, WARN entries from that window are lost. This is acceptable since WARNs are informational, not critical.
- On module load, hydrate buffer from storage (async, best-effort). Merge strategy: hydrated entries are placed first, any entries captured during the async hydration window are appended after. Duplicates are not possible since each entry has a unique ISO timestamp + module combo.

**API additions (module-level exports, alongside existing `createLogger` and `LOG_LEVELS`):**
- `getErrorLog()` — returns a copy of the current buffer array
- `clearErrorLog()` — empties buffer and removes `errorLog` from `chrome.storage.local`

**Constants:**
- `ERROR_BUFFER_MAX_SIZE = 50`
- `ERROR_BUFFER_FLUSH_DEBOUNCE_MS = 5000`
- Storage key: `errorLog`

### Test plan

Unit tests in `tests/utils/logger.test.js`:
1. Logger captures WARN entries in buffer
2. Logger captures ERROR entries in buffer
3. Logger does NOT capture INFO/DEBUG in buffer
4. Buffer evicts oldest entry when exceeding max size
5. `getErrorLog()` returns current buffer contents
6. `clearErrorLog()` empties buffer and calls `chrome.storage.local.remove`
7. ERROR level triggers immediate flush to `chrome.storage.local.set`
8. WARN level flush is debounced (use `vi.useFakeTimers()` to verify `set` is called after 5s, not before)

---

## 2. Playwright E2E Smoke Tests

### Goal

Verify the extension loads correctly and core UI flows work. Catch regressions that unit tests can't (DOM rendering, extension lifecycle, page navigation).

### Design

**Setup:**
- Install `@playwright/test` as devDependency
- Create `playwright.config.js` at project root
- Create `tests/e2e/` directory for E2E test files
- Add `test:e2e` script to package.json: `"test:e2e": "playwright test"`
- Extension loaded from `dist/` (requires `npm run build` first)

**Playwright config:**
```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  // No global browser config — extensions use persistent context via fixture
});
```

Note: No `channel` in config. The fixture launches Chrome directly via `chromium.launchPersistentContext()`. Playwright's bundled Chromium does NOT support extensions — the fixture's `--load-extension` flag requires a real Chrome install. On CI, `npx playwright install chrome` (not `chromium`) installs the required browser.

**Extension loading pattern (fixture):**
```js
// tests/e2e/fixtures.js
import { test as base, chromium } from '@playwright/test';
import path from 'path';

export const test = base.extend({
  context: async ({}, use) => {
    const extensionPath = path.resolve('dist');
    const context = await chromium.launchPersistentContext('', {
      headless: false,  // Extensions REQUIRE headed mode. --headless=new does NOT work.
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    const id = background.url().split('/')[2];
    await use(id);
  },
});

export const expect = test.expect;
```

**Important:** `headless: false` is a hard requirement. Chrome's `--headless=new` mode does NOT support loading extensions. On CI, `xvfb-run` provides a virtual display.

**Smoke tests (5 tests in `tests/e2e/extension.spec.js`):**

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Extension loads | Service worker is active, extension ID is valid |
| 2 | Popup opens | `popup.html` renders, key buttons exist |
| 3 | Settings page | Navigate to settings, toggle a setting, verify it persists after reload |
| 4 | History page | Navigate to history, page renders without errors |
| 5 | Welcome page | Navigate to welcome, onboarding carousel renders |

**CI integration:**
Add a separate job in `.github/workflows/ci.yml` that depends on the lint/test/build job:

```yaml
  e2e:
    needs: [lint-test-build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install chrome --with-deps
      - run: npm run build
      - run: xvfb-run npm run test:e2e
```

Notes:
- `needs: [lint-test-build]` — avoids wasting CI minutes on E2E if lint/unit tests fail
- `npx playwright install chrome --with-deps` — installs Chrome + system dependencies (including xvfb)
- `xvfb-run` — provides virtual display for headed Chrome on headless Linux

### Test plan

The E2E tests ARE the test plan. Verification:
1. `npm run test:e2e` passes locally
2. CI job passes on push

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Thumbnails to IDB deferred | ~1.5MB vs 10MB quota — no real pressure yet |
| Error buffer in logger, not new file | Logger already imported everywhere; zero wiring needed |
| Immediate flush for ERROR, debounced for WARN | ERRORs must survive SW termination; WARNs are lower priority |
| E2E separate from unit tests | Different runners, different requirements (headed browser) |
| E2E job depends on lint-test-build | Saves CI minutes; no point running E2E if basics fail |
| 5 smoke tests, not exhaustive | Covers extension lifecycle + each major page loads |

## Files Modified

| File | Change |
|------|--------|
| `utils/logger.js` | Add ring buffer in `#log()`, `getErrorLog()`, `clearErrorLog()` exports |
| `tests/utils/logger.test.js` | New: 8 tests for error buffer |
| `playwright.config.js` | New: Playwright config |
| `tests/e2e/fixtures.js` | New: Extension loading fixture |
| `tests/e2e/extension.spec.js` | New: 5 smoke tests |
| `package.json` | Add `@playwright/test`, `test:e2e` script |
| `.github/workflows/ci.yml` | Add `e2e` job with `needs: [lint-test-build]` |
