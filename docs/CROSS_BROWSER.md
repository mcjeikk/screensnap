# ScreenSnap — Cross-Browser Porting Notes

This document identifies Chrome-specific APIs vs standard WebExtensions APIs used by ScreenSnap, and outlines what would be needed to port to Firefox and Edge.

> **Status:** Documentation only. No porting work has been done yet.

---

## API Usage Analysis

### ✅ Standard WebExtensions APIs (Cross-Browser Compatible)

These APIs work across Chrome, Firefox, and Edge with minimal or no changes:

| API | Used In | Notes |
|---|---|---|
| `chrome.runtime.onMessage` | Everywhere | Firefox supports `browser.runtime.onMessage` natively |
| `chrome.runtime.sendMessage` | Everywhere | |
| `chrome.runtime.onInstalled` | service-worker.js | |
| `chrome.runtime.getURL` | Multiple | |
| `chrome.runtime.getManifest` | service-worker.js | |
| `chrome.storage.local` | Multiple | |
| `chrome.storage.sync` | settings.js, editor.js | |
| `chrome.tabs.create` | Multiple | |
| `chrome.tabs.query` | service-worker.js | |
| `chrome.tabs.onRemoved` | service-worker.js | |
| `chrome.downloads.download` | Multiple | |
| `chrome.action` (MV3) | service-worker.js | `chrome.browserAction` in MV2 Firefox |
| `chrome.commands` | manifest.json | |
| `chrome.notifications` | service-worker.js | |
| `chrome.permissions` | Not currently used | |

### ⚠️ Chrome-Specific APIs (Require Polyfill or Alternative)

| API | Used In | Firefox Alternative | Edge |
|---|---|---|---|
| `chrome.storage.session` | service-worker.js | ✅ Supported in Firefox 115+ | ✅ Supported |
| `chrome.scripting.executeScript` | service-worker.js | ✅ Supported in Firefox 102+ | ✅ Supported |
| `chrome.scripting.insertCSS` | service-worker.js | ✅ Supported in Firefox 102+ | ✅ Supported |
| `chrome.offscreen` | service-worker.js, offscreen.js | ❌ **Not available** | ✅ Supported |
| `chrome.tabCapture` | recorder.js | ❌ **Not available** | ✅ Supported |
| `chrome.desktopCapture` | service-worker.js | ❌ **Not available** (use `getUserMedia` with `getDisplayMedia`) | ✅ Supported |
| `chrome.action.setBadgeText` | service-worker.js | ✅ `browser.action.setBadgeText` | ✅ Supported |
| `chrome.action.setBadgeBackgroundColor` | service-worker.js | ✅ Supported | ✅ Supported |
| `chrome.alarms` | service-worker.js | ✅ Supported | ✅ Supported |
| `chrome.runtime.getContexts` | service-worker.js | ❌ **Not available** (Firefox doesn't use offscreen) | ✅ Supported |

### 🔴 Major Blocking Issues for Firefox

1. **`chrome.offscreen`** — Firefox background scripts have DOM access, so offscreen documents aren't needed. The clipboard copy code would need a Firefox-specific path.

2. **`chrome.tabCapture`** — Not available in Firefox. Firefox uses `browser.tabs.captureTab()` for screenshots and `getDisplayMedia()` for recording.

3. **`chrome.desktopCapture`** — Not available in Firefox. Use `navigator.mediaDevices.getDisplayMedia()` directly.

4. **Service Worker vs Background Script** — Firefox MV3 uses background scripts (not service workers). The manifest would need `background.scripts` instead of `background.service_worker`.

---

## Manifest Changes for Firefox

```json
// Firefox MV3 manifest differences
{
  // background: use scripts instead of service_worker
  "background": {
    "scripts": ["background/service-worker.js"]
  },

  // Firefox-specific settings
  "browser_specific_settings": {
    "gecko": {
      "id": "screensnap@example.com",
      "strict_min_version": "115.0"
    }
  }

  // Remove chrome.offscreen permission
  // Remove chrome.tabCapture permission (not available)
}
```

---

## Manifest Changes for Edge

Edge is Chromium-based, so the manifest works as-is. Only changes:

```json
{
  // Remove auto-update URL if present (not in ScreenSnap)
  // Everything else is identical to Chrome
}
```

---

## Porting Strategy

### Phase 1: Use `webextension-polyfill`

Mozilla's [webextension-polyfill](https://github.com/nicolo-ribaudo/browser-polyfill) normalizes the `chrome.*` → `browser.*` API:

```javascript
// Instead of:
chrome.runtime.sendMessage(msg);

// Use:
import browser from 'webextension-polyfill';
browser.runtime.sendMessage(msg);
```

This handles callback-to-Promise conversion automatically.

### Phase 2: Feature Detection

```javascript
// Detect available APIs
const hasOffscreen = typeof chrome !== 'undefined' && !!chrome.offscreen;
const hasTabCapture = typeof chrome !== 'undefined' && !!chrome.tabCapture;
const hasDesktopCapture = typeof chrome !== 'undefined' && !!chrome.desktopCapture;
const hasStorageSession = typeof chrome !== 'undefined' && !!chrome.storage?.session;

// Use feature detection to branch behavior
if (hasOffscreen) {
  await ensureOffscreenDocument();
  // Chrome/Edge path
} else {
  // Firefox path: direct clipboard access in background script
  await navigator.clipboard.write([...]);
}
```

### Phase 3: Platform-Specific Builds

Use a build system to generate platform-specific ZIPs:

```
build/
├── chrome/     → Chrome Web Store
├── firefox/    → Firefox Add-ons (AMO)
└── edge/       → Microsoft Edge Add-ons
```

Each gets a merged manifest with platform-specific fields.

---

## Effort Estimate

| Task | Effort | Priority |
|---|---|---|
| Edge port | Trivial (works as-is) | High |
| Firefox clipboard (remove offscreen dependency) | Medium | High |
| Firefox recording (replace tabCapture/desktopCapture) | High | Medium |
| Firefox manifest (background scripts) | Low | High |
| Build pipeline for multi-platform | Medium | Medium |
| webextension-polyfill integration | Low | High |

**Total estimated effort for Firefox port:** 3-5 days
**Total estimated effort for Edge port:** < 1 day (testing only)

---

## References

- [Firefox Chrome Incompatibilities](https://developer.mozilla.org/Add-ons/WebExtensions/Chrome_incompatibilities)
- [Porting to Firefox](https://extensionworkshop.com/documentation/develop/porting-a-google-chrome-extension/)
- [Porting to Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/port-chrome-extension)
- [webextension-polyfill](https://github.com/nicolo-ribaudo/browser-polyfill)
- [Firefox MV3 Support](https://blog.mozilla.org/addons/2022/11/17/manifest-v3-signing-available-november-21-on-firefox-nightly/)
