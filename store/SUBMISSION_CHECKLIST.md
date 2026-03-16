# ScreenBolt — Chrome Web Store Submission Checklist

## Distribution Package
- **ZIP file:** `screenbolt-v0.6.0.zip` (in workspace root)
- **Size:** ~100KB
- **Contents verified:** manifest.json ✓ | All 12 directories ✓ | 48 files total

## Privacy Policy
- **URL:** https://mcjeikk.github.io/screenbolt/privacy-policy.html
- **Status:** ✅ Live (GitHub Pages, `gh-pages` branch)

## Screenshots (1280×800 PNG)
| # | File | Description |
|---|------|-------------|
| 1 | `store/screenshots/screenshot1-hero.png` | Hero shot: ScreenBolt branding + popup mock showing capture modes |
| 2 | `store/screenshots/screenshot2-modes.png` | Three capture modes: Visible Area, Full Page, Selection with shortcuts |
| 3 | `store/screenshots/screenshot3-editor.png` | Annotation editor: toolbar, canvas with annotations, properties panel |
| 4 | `store/screenshots/screenshot4-recording.png` | Screen recording: source selection, preview with controls, format tags |
| 5 | `store/screenshots/screenshot5-features.png` | Feature grid: History, Themes, Shortcuts, PDF, i18n, Zero Cloud |

## Promotional Images
| Asset | Size | File |
|-------|------|------|
| Small promo tile | 440×280 | `store/promo/small-promo.png` |
| Marquee promo | 1400×560 | `store/promo/marquee-promo.png` |

## Store Listing Details
- **Category:** Productivity
- **Primary language:** English
- **Additional languages:** Spanish, Portuguese (via `_locales/`)
- **Single purpose description:** "ScreenBolt captures screenshots, provides annotation tools, and records screen activity"

## Permissions Justification

| Permission | Justification |
|---|---|
| `activeTab` | Required to capture the visible content of the current tab when the user clicks the extension or uses a keyboard shortcut. Only activates on user gesture. |
| `tabCapture` | Required to capture the tab's video and audio stream when the user initiates screen recording of a browser tab. |
| `desktopCapture` | Required to capture the full screen or a specific application window when the user chooses screen-level recording. |
| `downloads` | Required to save captured screenshots and recordings to the user's Downloads folder. |
| `storage` | Required to persist user preferences (theme, format, shortcuts) and capture history metadata (thumbnails, timestamps) locally. |
| `offscreen` | Required to create an offscreen document for clipboard write operations (copying screenshots to clipboard). |
| `scripting` | Required to inject the area-selection overlay UI into the current tab when the user chooses "Capture Selection" mode. |
| `alarms` | Required to keep the service worker alive during active recording sessions that may last several minutes. |

### Optional Permissions
| Permission | Justification |
|---|---|
| `notifications` | Optionally shows a desktop notification when a capture or recording completes. User must grant permission explicitly. |

### Host Permissions
| Permission | Justification |
|---|---|
| `<all_urls>` | Required to inject the selection overlay (content script) and recording controls widget on any web page the user is viewing. Also needed for full-page screenshot stitching which requires scrolling and capturing on the active page. This permission is only exercised when the user explicitly initiates a capture or recording. |

## Pre-Submission Checks
- [x] manifest.json is valid JSON
- [x] All referenced files exist in ZIP
- [x] Icons: 16px, 32px, 48px, 128px present
- [x] Default locale (en) messages.json present
- [x] ZIP size < 10MB (actual: ~100KB)
- [x] Privacy policy URL accessible (HTTP 200)
- [x] Screenshots are 1280×800 PNG
- [x] Small promo tile is 440×280 PNG
- [x] Marquee promo is 1400×560 PNG
- [x] Version in manifest: 0.6.0

## Upload Steps
1. Go to https://chrome.google.com/webstore/devconsole
2. Click "New Item" → Upload `screenbolt-v0.6.0.zip`
3. Fill store listing:
   - Description: use `store/description.txt`
   - Screenshots: upload all 5 from `store/screenshots/`
   - Promo images: upload from `store/promo/`
   - Category: Productivity
   - Language: English
4. Privacy tab:
   - Privacy policy URL: https://mcjeikk.github.io/screenbolt/privacy-policy.html
   - Single purpose: "ScreenBolt captures screenshots, provides annotation tools, and records screen activity"
   - Permission justifications: copy from table above
5. Submit for review
