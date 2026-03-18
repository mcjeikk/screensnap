# ScreenBolt 📸

> **Free screenshot & screen recording Chrome extension.**
> No limits. No account. No tracking. 100% local.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-22C55E)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.8.8-indigo)](CHANGELOG.md)

---

## ✨ Features

### 📸 Screenshots
- **Visible Area** — Capture what you see, instantly
- **Full Page** — Scroll-and-stitch capture for entire pages
- **Selection** — Click and drag to capture a specific region
- **Keyboard shortcuts** — Alt+Shift+V / F / S for quick access

### ✏️ Annotation Editor
- 🏹 **Arrow** — Point to what matters
- ⬜ **Rectangle** — Highlight areas with rounded-corner outlines
- ⭕ **Ellipse** — Circle important elements
- ➖ **Line** — Draw straight lines
- 🖊️ **Freehand** — Sketch freely
- 🔤 **Text** — Add labels and notes
- 🔲 **Blur/Pixelate** — Redact sensitive information
- 🟡 **Highlight** — Semi-transparent marker
- ✂️ **Crop** — Trim to exactly what you need
- ↩️ **Undo/Redo** — Full history stack (Ctrl+Z / Ctrl+Shift+Z)
- 🎨 **Color picker** + stroke width control
- 💾 **Export** — PNG, JPG, or PDF

### 🎥 Screen Recording
- 📑 **Tab Recording** — Capture a single browser tab
- 🖥️ **Screen/Window** — Record your full screen or any window
- 📷 **Camera Only** — Webcam-only recording
- 🎞️ **PiP Webcam Overlay** — Circular webcam bubble on recordings
- 🎤 **Audio Controls** — Mic + system audio, independently togglable
- ⏸️ **Pause/Resume** — Take breaks during recording
- ⏱️ **No Time Limit** — Record as long as you need
- 🔄 **WebM & MP4** export (native MediaRecorder)

### 📁 History
- Grid view with thumbnails for all captures
- Filter by type (screenshots / recordings)
- Search by name, sort by date/size/name
- One-click re-open in editor

### ⚙️ Settings
- Theme: Dark / Light / System auto-detect
- Screenshot format (PNG/JPG), quality, after-capture action
- Recording resolution (720p/1080p/4K), audio defaults
- Notifications toggle, history limits

### 🎨 Theming
- Beautiful dark theme (default)
- Clean light theme
- System auto-detect via `prefers-color-scheme`

---

## 📷 Screenshots

> *Coming soon — screenshots will be added before Chrome Web Store submission.*

---

## 🚀 Installation

### Development Mode (recommended for now)

1. Clone the repository:
   ```bash
   git clone https://github.com/mcjeikk/screenbolt.git
   cd screenbolt
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the `screenbolt/` folder

5. Pin ScreenBolt to your toolbar for quick access 📌

### Chrome Web Store

> *Coming soon!*

---

## 🏗️ Architecture

```
screenbolt/
├── manifest.json                 # Extension manifest (MV3)
├── background/
│   └── service-worker.js         # Central coordinator & message router (ES modules)
├── popup/
│   └── popup.html/js/css         # Extension popup — screenshots + inline recording config
├── content/
│   ├── content-script.js         # Selection overlay & full-page scroll-stitch capture
│   ├── content-style.css         # Selection overlay styles
│   └── recording-widget.js       # Floating recording controls (shadow DOM) + PiP webcam
├── editor/
│   └── editor.html/js/css        # Canvas-based annotation editor (9 tools)
├── recorder/
│   └── preview.html/js/css       # Post-recording preview & download
├── offscreen/
│   └── recorder-offscreen.html/js # MediaRecorder + audio mixing + clipboard proxy
├── history/
│   └── history.html/js/css       # Capture history browser with search/filter/sort
├── settings/
│   └── settings.html/js/css      # Extension settings (synced via chrome.storage.sync)
├── welcome/
│   └── welcome.html/js/css       # Onboarding slides (shown on first install)
├── permissions/
│   └── permissions.html/js       # Mic/camera permission grant page
├── utils/
│   ├── constants.js              # MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_SETTINGS
│   ├── logger.js                 # Structured logging with module prefixes
│   ├── storage.js                # chrome.storage wrapper with quota handling
│   ├── helpers.js                # Timestamps, formatting, sanitization, debounce
│   ├── messages.js               # Type-safe message passing with validation
│   ├── errors.js                 # ExtensionError class, error codes, withRetry()
│   ├── feature-detection.js      # Cross-browser capability checks
│   └── migration.js              # Versioned data migration runner
├── assets/
│   ├── icons/                    # Extension icons (16/32/48/128px + SVG source)
│   ├── styles/themes.css         # CSS custom properties for dark/light/system themes
│   └── scripts/theme-init.js     # Theme pre-loader (prevents flash)
├── _locales/                     # i18n (English, Spanish, Portuguese)
├── docs/                         # Development guidelines & audit results
├── store/                        # Chrome Web Store assets & publishing guide
├── CHANGELOG.md
└── README.md
```

### Recording Flow (v0.7.0+)

```
Popup (config) → Service Worker (orchestrator)
                  ├→ Offscreen Document (MediaRecorder + audio mixing)
                  ├→ Content Script: Recording Widget (timer, pause, stop)
                  └→ Content Script: PiP Webcam Bubble (visible, captured by tabCapture)
```

### Key Design Decisions

- **Vanilla JS** — No frameworks, no build step, zero dependencies
- **Canvas API** — All annotations rendered directly on canvas
- **MV3 Native** — Service worker, offscreen documents, ES modules
- **Message Router** — Centralized pub/sub pattern in service worker
- **Shadow DOM** — Recording widget CSS-isolated from page styles
- **TabCapture PiP** — Webcam bubble visible on page, captured naturally by tabCapture
- **Theme System** — CSS custom properties for consistent dark/light/system theming
- **Session Storage** — Recording state survives SW restart within a session

---

## 🛠️ Development

### Prerequisites

- Google Chrome 116+ (for Manifest V3 features)
- Basic understanding of Chrome Extension APIs

### Getting Started

```bash
# Clone
git clone https://github.com/mcjeikk/screenbolt.git

# Load in Chrome
# chrome://extensions/ → Developer mode → Load unpacked → select folder

# Make changes → Chrome auto-reloads on save (or click refresh on extension card)
```

### Code Standards

- **JSDoc** on all functions
- **camelCase** for variables/functions, **UPPER_SNAKE** for constants
- **No innerHTML** with user data — use DOM APIs
- **Always** revoke Object URLs and stop MediaStream tracks
- See `docs/BEST_PRACTICES.md` for full guidelines

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes following the code standards above
4. Test in Chrome with the extension loaded
5. Commit: `git commit -m "feat: add my feature"`
6. Push and open a Pull Request

### Commit Convention

- `feat:` — New features
- `fix:` — Bug fixes
- `refactor:` — Code improvements (no behavior change)
- `docs:` — Documentation updates
- `style:` — Formatting, CSS changes

---

## 🔒 Privacy

ScreenBolt is designed with privacy as a core principle:

- **100% Local** — All processing happens in your browser
- **No Server** — No data is sent to any server, ever
- **No Analytics** — No tracking, no telemetry, no cookies
- **No Account** — No sign-up required
- **Open Source** — Inspect every line of code yourself

Your screenshots and recordings never leave your device.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with ❤️ and vanilla JS<br>
  <strong>ScreenBolt</strong> — Screenshot & record, beautifully.
</p>
