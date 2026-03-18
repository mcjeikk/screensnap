# Phase 2 Completion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 2 (Core Robustness) by adding error monitoring to the logger and Playwright E2E smoke tests.

**Architecture:** Extend `utils/logger.js` with a module-level ring buffer that captures WARN/ERROR entries and persists them to `chrome.storage.local`. Add Playwright E2E tests that load the built extension in a real Chrome instance and verify all major pages render correctly.

**Tech Stack:** Vitest (unit tests), Playwright (E2E), Chrome MV3 APIs

**Spec:** `docs/superpowers/specs/2026-03-17-phase2-completion-design.md`

**Note:** Thumbnail migration to IndexedDB is explicitly deferred (see spec Decisions table). The IDB module is ready for future use.

---

## File Structure

| File | Role |
|------|------|
| `utils/logger.js` | Modify: add ring buffer, flush logic, `getErrorLog()`, `clearErrorLog()` |
| `tests/utils/logger.test.js` | Create: 8 unit tests for error buffer |
| `playwright.config.js` | Create: Playwright config |
| `tests/e2e/fixtures.js` | Create: Extension loading fixture |
| `tests/e2e/extension.spec.js` | Create: 5 smoke tests |
| `package.json` | Modify: add `@playwright/test`, `test:e2e` script |
| `.github/workflows/ci.yml` | Modify: add `e2e` job |

---

## Chunk 1: Error Monitoring

### Task 1: Write failing tests for error buffer

**Files:**
- Create: `tests/utils/logger.test.js`

- [ ] **Step 1: Create the test file with all 8 tests**

Important: Use `vi.clearAllMocks()` (NOT `vi.restoreAllMocks()`). `restoreAllMocks` removes mock implementations set by `tests/setup.js`, breaking `chrome.storage.local.get` which must return a Promise for the logger's hydration code.

```js
// tests/utils/logger.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Re-import fresh module per test by using dynamic import + vi.resetModules
let createLogger, getErrorLog, clearErrorLog, LOG_LEVELS;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  // Suppress console output during tests
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});

  const mod = await import('../../utils/logger.js');
  createLogger = mod.createLogger;
  getErrorLog = mod.getErrorLog;
  clearErrorLog = mod.clearErrorLog;
  LOG_LEVELS = mod.LOG_LEVELS;
});

describe('Error buffer', () => {
  it('captures WARN entries in buffer', () => {
    const log = createLogger('TestModule');
    log.warn('something went wrong');
    const entries = getErrorLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('WARN');
    expect(entries[0].module).toBe('TestModule');
    expect(entries[0].message).toContain('something went wrong');
  });

  it('captures ERROR entries in buffer', () => {
    const log = createLogger('TestModule');
    log.error('critical failure', new Error('boom'));
    const entries = getErrorLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('ERROR');
    expect(entries[0].message).toContain('critical failure');
    expect(entries[0].message).toContain('boom');
  });

  it('does NOT capture INFO or DEBUG in buffer', () => {
    const log = createLogger('TestModule');
    log.setLevel(LOG_LEVELS.DEBUG);
    log.debug('debug msg');
    log.info('info msg');
    expect(getErrorLog()).toHaveLength(0);
  });

  it('evicts oldest entry when exceeding max size', () => {
    const log = createLogger('TestModule');
    for (let i = 0; i < 55; i++) {
      log.warn(`warning ${i}`);
    }
    const entries = getErrorLog();
    expect(entries).toHaveLength(50);
    expect(entries[0].message).toContain('warning 5');
    expect(entries[49].message).toContain('warning 54');
  });

  it('getErrorLog returns a copy of the buffer', () => {
    const log = createLogger('TestModule');
    log.warn('test');
    const a = getErrorLog();
    const b = getErrorLog();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('clearErrorLog empties buffer and calls storage.remove', async () => {
    const log = createLogger('TestModule');
    log.warn('test');
    expect(getErrorLog()).toHaveLength(1);
    await clearErrorLog();
    expect(getErrorLog()).toHaveLength(0);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith('errorLog');
  });

  it('ERROR level triggers immediate flush to storage', () => {
    chrome.storage.local.set.mockClear();
    const log = createLogger('TestModule');
    log.error('critical');
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ errorLog: expect.any(Array) }),
    );
  });

  it('WARN level flush is debounced', () => {
    vi.useFakeTimers();
    chrome.storage.local.set.mockClear();
    const log = createLogger('TestModule');
    log.warn('deferred');
    // Not flushed immediately
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    // Flush after debounce period
    vi.advanceTimersByTime(5000);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ errorLog: expect.any(Array) }),
    );
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/utils/logger.test.js`
Expected: FAIL — `getErrorLog` and `clearErrorLog` are not exported from `logger.js`

---

### Task 2: Implement error buffer in logger

**Files:**
- Modify: `utils/logger.js`

- [ ] **Step 3: Add buffer constants, state, and helper functions at module level**

Add after the `LOG_LEVELS` const (line 16), before the `Logger` class (line 18):

```js
// ── Error Buffer ─────────────────────────────────
const ERROR_BUFFER_MAX_SIZE = 50;
const ERROR_BUFFER_FLUSH_DEBOUNCE_MS = 5000;
const ERROR_LOG_STORAGE_KEY = 'errorLog';

/** @type {Array<{timestamp: string, module: string, level: string, message: string}>} */
let errorBuffer = [];

/** @type {ReturnType<typeof setTimeout>|null} */
let flushTimer = null;

/**
 * Format the first two args into a single message string.
 * Covers the common pattern: log.error('Save failed', error)
 * @param {Array} args - Log arguments
 * @returns {string}
 */
function formatBufferMessage(args) {
  let msg = args.length > 0 ? String(args[0]) : '';
  if (args.length > 1) {
    const second = args[1];
    if (second instanceof Error) {
      const detail = `${second.message}${second.stack ? '\n' + second.stack : ''}`;
      msg += ' | ' + detail.slice(0, 200);
    } else {
      msg += ' | ' + String(second).slice(0, 200);
    }
  }
  return msg;
}

/**
 * Flush the error buffer to chrome.storage.local.
 */
function flushBuffer() {
  flushTimer = null;
  try {
    chrome.storage.local.set({ [ERROR_LOG_STORAGE_KEY]: [...errorBuffer] });
  } catch {
    /* best effort — storage may not be available in all contexts */
  }
}

/**
 * Schedule a debounced flush (for WARN level).
 */
function scheduleDebouncedFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushBuffer, ERROR_BUFFER_FLUSH_DEBOUNCE_MS);
}

// Hydrate buffer from storage on module load (async, best-effort)
try {
  chrome.storage.local.get(ERROR_LOG_STORAGE_KEY).then((result) => {
    const stored = result[ERROR_LOG_STORAGE_KEY];
    if (Array.isArray(stored) && stored.length > 0) {
      // Merge: stored entries first, then any captured during hydration
      errorBuffer = [...stored, ...errorBuffer].slice(-ERROR_BUFFER_MAX_SIZE);
    }
  });
} catch {
  /* storage not available (e.g. in test environment) */
}
```

- [ ] **Step 4: Replace the `#log()` method with the version that includes buffer capture**

Replace the entire `#log()` method (lines 58-77) with:

```js
  /**
   * Internal logging method.
   * @param {number} level - Numeric log level
   * @param {string} levelName - Display name for the level
   * @param {...*} args - Values to log
   */
  #log(level, levelName, ...args) {
    if (level < this.#level) return;

    // Capture WARN and ERROR to ring buffer
    if (level >= LOG_LEVELS.WARN) {
      const entry = {
        timestamp: new Date().toISOString(),
        module: this.#module,
        level: levelName,
        message: formatBufferMessage(args),
      };
      errorBuffer.push(entry);
      if (errorBuffer.length > ERROR_BUFFER_MAX_SIZE) {
        errorBuffer = errorBuffer.slice(-ERROR_BUFFER_MAX_SIZE);
      }
      // ERROR: flush immediately. WARN: debounced.
      if (level >= LOG_LEVELS.ERROR) {
        flushBuffer();
      } else {
        scheduleDebouncedFlush();
      }
    }

    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = `[${timestamp}][${EXTENSION_NAME}][${this.#module}][${levelName}]`;

    switch (level) {
      case LOG_LEVELS.ERROR:
        console.error(prefix, ...args);
        break;
      case LOG_LEVELS.WARN:
        console.warn(prefix, ...args);
        break;
      case LOG_LEVELS.INFO:
        console.info(prefix, ...args);
        break;
      default:
        console.debug(prefix, ...args);
    }
  }
```

- [ ] **Step 5: Add `getErrorLog` and `clearErrorLog` exports**

Add before the final `export { LOG_LEVELS };` line:

```js
/**
 * Get a copy of the current error log buffer.
 * @returns {Array<{timestamp: string, module: string, level: string, message: string}>}
 */
export function getErrorLog() {
  return [...errorBuffer];
}

/**
 * Clear the error log buffer and remove from storage.
 * @returns {Promise<void>}
 */
export async function clearErrorLog() {
  errorBuffer = [];
  try {
    await chrome.storage.local.remove(ERROR_LOG_STORAGE_KEY);
  } catch {
    /* best effort */
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/utils/logger.test.js`
Expected: 8 tests PASS

- [ ] **Step 7: Run full test suite and lint**

Run: `npm test && npm run lint`
Expected: All 63+ tests pass, no lint errors

- [ ] **Step 8: Commit**

```bash
git add utils/logger.js tests/utils/logger.test.js
git commit -m "feat: add error monitoring ring buffer to logger

Extends Logger to capture WARN/ERROR entries in a persistent ring buffer.
ERROR flushes immediately to chrome.storage.local, WARN is debounced (5s).
Adds getErrorLog() and clearErrorLog() exports.
8 unit tests covering capture, eviction, flush timing, and cleanup."
```

---

## Chunk 2: Playwright E2E Smoke Tests

### Task 3: Install Playwright and create config

**Files:**
- Modify: `package.json`
- Create: `playwright.config.js`

- [ ] **Step 9: Install Playwright**

Run: `npm install -D @playwright/test`

- [ ] **Step 10: Install Chrome browser for Playwright**

Run: `npx playwright install chrome`

Note: Must be `chrome` not `chromium`. Playwright's bundled Chromium does NOT support extensions. Real Chrome is required for `--load-extension`.

- [ ] **Step 11: Add `test:e2e` script to package.json**

In `package.json` `scripts` section, add:
```json
"test:e2e": "playwright test"
```

- [ ] **Step 12: Create `playwright.config.js`**

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
});
```

No `channel` or `use` config needed. The fixture handles browser launch directly via `chromium.launchPersistentContext()`.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json playwright.config.js
git commit -m "chore: add Playwright for E2E testing"
```

---

### Task 4: Create extension fixture and smoke tests

**Files:**
- Create: `tests/e2e/fixtures.js`
- Create: `tests/e2e/extension.spec.js`

- [ ] **Step 14: Build the extension and verify structure**

Run: `npm run build && ls dist/manifest.json`
Expected: `dist/manifest.json` exists (confirms CRX plugin output structure)

- [ ] **Step 15: Create the extension loading fixture**

`headless: false` is a HARD requirement. Chrome's `--headless=new` mode does NOT support loading extensions. On CI, `xvfb-run` provides a virtual display.

```js
// tests/e2e/fixtures.js
import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const test = base.extend({
  context: async ({}, use) => {
    const extensionPath = path.resolve(__dirname, '../../dist');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
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

- [ ] **Step 16: Create the 5 smoke tests**

Selectors verified against actual HTML:
- Popup: `#btn-visible` (line 38), `#btn-full` (line 48)
- Settings: `#ss-format` (line 27)
- History: `.history-app` (line 12), `#count-label` (line 19)
- Welcome: `.welcome-app` (line 12), `[data-slide="0"]` (line 16)

```js
// tests/e2e/extension.spec.js
import { test, expect } from './fixtures.js';

test('extension loads with active service worker', async ({ extensionId }) => {
  expect(extensionId).toBeTruthy();
  expect(extensionId.length).toBeGreaterThan(10);
});

test('popup page renders with action buttons', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#btn-visible')).toBeVisible();
  await expect(page.locator('#btn-full')).toBeVisible();
});

test('settings page loads and toggles persist', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings/settings.html`);
  await expect(page.locator('#ss-format')).toBeVisible();

  // Change a setting
  await page.selectOption('#ss-format', 'jpg');

  // Reload and verify persistence
  await page.reload();
  await expect(page.locator('#ss-format')).toHaveValue('jpg');
});

test('history page renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/history/history.html`);
  await expect(page.locator('.history-app')).toBeVisible();
  await expect(page.locator('#count-label')).toBeVisible();
});

test('welcome page renders onboarding', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
  await expect(page.locator('.welcome-app')).toBeVisible();
  await expect(page.locator('[data-slide="0"]')).toBeVisible();
});
```

- [ ] **Step 17: Run E2E tests locally**

Run: `npm run test:e2e`
Expected: 5 tests PASS

- [ ] **Step 18: Commit**

```bash
git add tests/e2e/fixtures.js tests/e2e/extension.spec.js
git commit -m "test: add 5 Playwright E2E smoke tests

Tests: extension loads, popup renders, settings persist,
history page renders, welcome onboarding renders.
Uses persistent context fixture to load built extension."
```

---

### Task 5: Add E2E to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 19: Add `e2e` job to CI workflow**

Add after the existing `lint-test-build` job. Key details:
- `needs: [lint-test-build]` — skips E2E if lint/unit tests fail
- `npx playwright install chrome --with-deps` — installs Chrome + system deps (including xvfb)
- `xvfb-run` — provides virtual display for headed Chrome on headless Linux

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

      - name: Install dependencies
        run: npm ci

      - name: Install Chrome for Playwright
        run: npx playwright install chrome --with-deps

      - name: Build extension
        run: npm run build

      - name: Run E2E tests
        run: xvfb-run npm run test:e2e

      - name: Upload test results on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-test-results
          path: test-results/
          retention-days: 7
```

- [ ] **Step 20: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Playwright E2E job (runs after lint-test-build)"
```

---

### Task 6: Final verification

- [ ] **Step 21: Run full verification**

Run: `npm run lint && npm test && npm run build && npm run test:e2e`
Expected: All lint, 63+ unit tests, build, and 5 E2E tests pass

- [ ] **Step 22: Verify Vitest does NOT pick up E2E tests**

Run: `npm test 2>&1 | grep -c "spec.js"`
Expected output: `0` (vitest include pattern `tests/**/*.test.js` excludes `.spec.js` files)
