# ScreenSnap 📸

> **Free screenshot & screen recording Chrome extension.**
> No limits. No account. No tracking. 100% local.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-22C55E)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.2-indigo)](CHANGELOG.md)

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
- 🔄 **WebM & MP4** export (MP4 via ffmpeg.wasm)

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
   git clone https://github.com/mcjeikk/screensnap.git
   cd screensnap
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the `screensnap/` folder

5. Pin ScreenSnap to your toolbar for quick access 📌

### Chrome Web Store

> *Coming soon!*

---

## 🏗️ Architecture

```
screensnap/
├── manifest.json            # Extension manifest (MV3)
├── background/
│   └── service-worker.js    # Central message router & coordinator
├── popup/
│   ├── popup.html/js/css    # Extension popup UI
├── content/
│   ├── content-script.js    # Selection overlay & full-page capture
│   └── content-style.css    # Selection overlay styles
├── editor/
│   ├── editor.html/js/css   # Annotation editor (Canvas API)
├── recorder/
│   ├── recorder.html/js/css # Recording configuration & MediaRecorder
│   ├── preview.html/js/css  # Post-recording preview & export
│   ├── recording-controls.js/css  # Floating widget (injected into pages)
├── history/
│   ├── history.html/js/css  # Capture history browser
├── settings/
│   ├── settings.html/js/css # Extension settings
├── welcome/
│   ├── welcome.html/js/css  # Onboarding slides
├── offscreen/
│   ├── offscreen.html/js    # Clipboard proxy (MV3 requirement)
├── utils/
│   ├── constants.js         # Shared constants & enums
│   ├── logger.js            # Structured logging system
│   ├── storage.js           # chrome.storage wrapper
│   ├── helpers.js           # Shared utility functions
│   └── messages.js          # Type-safe message passing
├── assets/
│   ├── icons/               # Extension icons (16/32/48/128px)
│   ├── styles/themes.css    # Theme system (CSS custom properties)
│   └── scripts/theme-init.js # Theme pre-loader
├── docs/
│   └── BEST_PRACTICES.md    # Development guidelines
├── CHANGELOG.md             # Version history
└── README.md                # This file
```

### Key Design Decisions

- **Vanilla JS** — No frameworks, no build step, no dependencies
- **Canvas API** — All annotations rendered directly on canvas
- **MV3 Compatible** — Service worker, offscreen documents for clipboard
- **Message Router** — Centralized pub/sub pattern in service worker
- **Theme System** — CSS custom properties for consistent theming
- **Session Storage** — Recording state survives SW restart within a session

---

## 🛠️ Development

### Prerequisites

- Google Chrome 116+ (for Manifest V3 features)
- Basic understanding of Chrome Extension APIs

### Getting Started

```bash
# Clone
git clone https://github.com/mcjeikk/screensnap.git

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

ScreenSnap is designed with privacy as a core principle:

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
  <strong>ScreenSnap</strong> — Screenshot & record, beautifully.
</p>
