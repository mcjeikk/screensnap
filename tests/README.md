# ScreenSnap — Testing Guide

## Overview

ScreenSnap uses a multi-layered testing strategy:

1. **Manual Testing** — Quick smoke tests during development
2. **Unit Tests** — Test shared utilities and pure logic (planned)
3. **E2E Tests** — Puppeteer/Playwright-based extension testing (planned)

---

## Manual Testing Checklist

Run through this checklist before every release.

### 🔧 Extension Loading

- [ ] Load unpacked extension from `chrome://extensions`
- [ ] No errors in the service worker console
- [ ] Extension icon appears in the toolbar
- [ ] Popup opens when clicking the icon
- [ ] Welcome page shows on first install

### 📸 Screenshot — Visible Area

- [ ] Click "Visible Area" from popup → capture opens in editor
- [ ] Keyboard shortcut `Alt+Shift+V` works
- [ ] Works on regular web pages (e.g., example.com)
- [ ] Fails gracefully on `chrome://` pages (shows error, no crash)
- [ ] Fails gracefully on `chrome-extension://` pages
- [ ] Notification appears after capture (if enabled)
- [ ] "Copy to clipboard" after-capture setting works
- [ ] "Save directly" after-capture setting works

### 📸 Screenshot — Full Page

- [ ] Click "Full Page" from popup → scroll-stitch capture works
- [ ] Keyboard shortcut `Alt+Shift+F` works
- [ ] Captures long pages correctly (e.g., Wikipedia article)
- [ ] Original scroll position restored after capture
- [ ] No visible seams in stitched output

### 📸 Screenshot — Selection

- [ ] Click "Selection" from popup → overlay appears on page
- [ ] Crosshair cursor visible
- [ ] Instructions banner visible at top
- [ ] Click and drag selects area with blue border
- [ ] Release captures and crops to selected area
- [ ] ESC key cancels selection
- [ ] Minimum selection size enforced (tiny drags ignored)
- [ ] Keyboard shortcut `Alt+Shift+S` works

### ✏️ Editor

- [ ] Capture loads in editor with correct dimensions
- [ ] All 9 annotation tools work: Arrow, Rect, Ellipse, Line, Pen, Text, Blur, Highlight, Crop
- [ ] Color picker changes annotation color
- [ ] Stroke width affects drawn annotations
- [ ] Undo (`Ctrl+Z`) removes last annotation
- [ ] Redo (`Ctrl+Shift+Z`) restores undone annotation
- [ ] Keyboard shortcuts work: A, R, E, L, P, T, B, H, C
- [ ] ESC deselects current tool
- [ ] Copy to clipboard works (📋 button)
- [ ] Save as PNG works
- [ ] Save as JPG works
- [ ] Export as PDF works (valid PDF with image)
- [ ] Download button works
- [ ] Status bar shows dimensions and file size
- [ ] Crop tool: drag area → Apply Crop button appears → crop applies correctly

### 🎥 Recording — Tab

- [ ] Click "Current Tab" → recorder config page opens
- [ ] Select source, audio options, countdown toggle
- [ ] Click "Start Recording" → countdown plays (if enabled)
- [ ] Recording starts, timer ticks, REC badge appears
- [ ] Floating widget appears on the page
- [ ] Pause/Resume works (timer pauses)
- [ ] Mute/Unmute works
- [ ] Stop → preview page opens with video
- [ ] Download WebM works

### 🎥 Recording — Screen

- [ ] Click "Full Screen" → screen picker appears
- [ ] Select screen or window → recording starts
- [ ] Audio capture works (system audio)
- [ ] Stop via widget or via sharing panel

### 🎥 Recording — Camera

- [ ] Click "Camera" → camera preview shows
- [ ] Recording captures webcam feed
- [ ] Audio (mic) captured

### 🎥 Recording — PiP

- [ ] Enable PiP toggle → webcam bubble appears
- [ ] Position options work (4 corners)
- [ ] Size options work (small/medium/large)
- [ ] Bubble is circular with white border

### 📁 History

- [ ] Captures appear in history with thumbnails
- [ ] Filter tabs work (All / Screenshots / Recordings)
- [ ] Search by name works
- [ ] Sort options work (date, size, name)
- [ ] Click screenshot → opens in editor
- [ ] Delete individual item works
- [ ] "Clear All" → confirmation dialog → clears history
- [ ] Pagination "Load more" works with many items

### ⚙️ Settings

- [ ] All settings load with correct saved values
- [ ] Changing any setting saves automatically (toast appears)
- [ ] Theme switch works (Dark / Light / System)
- [ ] JPG quality slider appears only when format is JPG
- [ ] Keyboard shortcuts section displays correctly
- [ ] Settings persist across browser restarts (sync storage)

### 🎨 Theming

- [ ] Dark theme renders correctly on all pages
- [ ] Light theme renders correctly on all pages
- [ ] System theme follows OS preference
- [ ] Theme transitions are smooth (no flash)

### ♿ Accessibility

- [ ] Tab navigation works through all interactive elements
- [ ] Focus rings visible on keyboard navigation
- [ ] Screen reader reads button labels correctly
- [ ] ARIA roles and states are correct
- [ ] Escape key closes overlays/dialogs

### 🔄 Edge Cases

- [ ] Extension survives service worker restart (recording state persists)
- [ ] Multiple rapid captures don't crash
- [ ] Very long page full-page capture doesn't OOM
- [ ] Opening recorder while recording is active shows error
- [ ] Closing recorder tab during recording cleans up badge
- [ ] Extension works after browser restart

---

## E2E Testing with Puppeteer

### Setup

```bash
# Install dependencies
npm init -y
npm install --save-dev puppeteer

# Create test directory structure
mkdir -p tests/e2e
```

### Configuration

```javascript
// tests/e2e/helpers.js
const puppeteer = require('puppeteer');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../');

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });
}

async function getExtensionId(browser) {
  const workerTarget = await browser.waitForTarget(
    target => target.type() === 'service_worker'
  );
  return workerTarget.url().split('/')[2];
}

module.exports = { launchBrowser, getExtensionId };
```

### Sample Test

```javascript
// tests/e2e/basic.test.js
const { launchBrowser, getExtensionId } = require('./helpers');

describe('ScreenSnap E2E', () => {
  let browser;
  let extensionId;

  beforeAll(async () => {
    browser = await launchBrowser();
    extensionId = await getExtensionId(browser);
  });

  afterAll(async () => {
    await browser.close();
  });

  test('extension loads without errors', async () => {
    expect(extensionId).toBeTruthy();
  });

  test('popup renders with capture buttons', async () => {
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    const visibleBtn = await page.$('#btn-visible');
    const fullBtn = await page.$('#btn-full');
    const selectionBtn = await page.$('#btn-selection');

    expect(visibleBtn).toBeTruthy();
    expect(fullBtn).toBeTruthy();
    expect(selectionBtn).toBeTruthy();

    await page.close();
  });

  test('editor page loads', async () => {
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/editor/editor.html`);

    const canvas = await page.$('#editor-canvas');
    expect(canvas).toBeTruthy();

    await page.close();
  });

  test('settings page loads and saves', async () => {
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/settings/settings.html`);

    const themeSelect = await page.$('#gen-theme');
    expect(themeSelect).toBeTruthy();

    await page.close();
  });

  test('history page loads', async () => {
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/history/history.html`);

    const grid = await page.$('#history-grid');
    expect(grid).toBeTruthy();

    await page.close();
  });
});
```

### Running Tests

```bash
# Run with Jest
npx jest tests/e2e/ --runInBand --testTimeout=30000

# Run with Node directly
node tests/e2e/basic.test.js
```

---

## E2E Testing with Playwright

### Setup

```bash
npm install --save-dev @playwright/test
```

### Configuration

```javascript
// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    headless: false, // Extensions require headed mode
  },
});
```

### Sample Test

```javascript
// tests/e2e/playwright.test.js
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../');

test.describe('ScreenSnap', () => {
  let context;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('popup renders', async () => {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = sw.url().split('/')[2];

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect(page.locator('#btn-visible')).toBeVisible();
    await page.close();
  });
});
```

---

## Test Cases by Feature

| Feature | Test Case | Type |
|---|---|---|
| Popup | All buttons render | E2E |
| Popup | Recording indicator shows when recording | Manual |
| Visible capture | Returns valid dataUrl | E2E |
| Full page | Stitches correctly on long pages | Manual |
| Selection | Overlay appears and captures area | Manual |
| Editor | All 9 tools draw on canvas | Manual |
| Editor | Undo/Redo works | Manual |
| Editor | PDF export generates valid PDF | Manual |
| Recorder | Tab capture starts and stops | Manual |
| Recorder | PiP compositing works | Manual |
| Recorder | MP4 conversion works | Manual |
| History | Items load and filter correctly | E2E |
| Settings | Values persist after reload | E2E |
| Themes | Dark/Light/System render correctly | Manual |
| SW lifecycle | Extension recovers after SW restart | E2E |
| Permissions | Graceful error on chrome:// pages | Manual |
| Context | Refresh banner on extension update | Manual |

---

## CI/CD Integration

For automated testing in CI:

```yaml
# .github/workflows/test.yml
name: Test Extension
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx jest tests/e2e/ --runInBand
```

**Note:** Puppeteer with `headless: 'new'` supports extensions in CI.
Playwright requires headed mode (`headless: false`) + `xvfb-run` on Linux:

```bash
xvfb-run npx playwright test
```
