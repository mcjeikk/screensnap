# Changelog

All notable changes to ScreenSnap will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [0.3.0] - 2026-03-16

### Added
- **Video Recording (Sprint 3)** — full screen recording toolkit:
  - **Tab Recording** — capture current tab video + audio via `chrome.tabCapture`
  - **Screen/Window Recording** — capture full screen or window via `chrome.desktopCapture` picker
  - **Camera Recording** — webcam-only recording with live preview
  - **Picture-in-Picture (PiP)** — webcam bubble overlay on screen/tab recordings
    - Configurable position (4 corners) and size (small/medium/large)
    - Circular webcam bubble composited via Canvas
  - **Audio controls** — microphone + system/tab audio, independently toggleable
    - Live audio level meter during setup
    - Mute/unmute mic during recording
  - **Recording controls** — floating draggable widget injected into the page
    - Timer (MM:SS), pause/resume, stop, mute toggle
    - Extension badge turns red "REC" during recording
  - **Countdown timer** — visual 3-2-1 countdown before recording starts (toggleable)
  - **Resolution options** — 720p, 1080p, 4K
  - **No time limit** — record as long as needed
  - **Preview page** — post-recording preview with metadata (duration, size, format)
  - **Export formats:**
    - WebM (native, instant download)
    - MP4 via ffmpeg.wasm (lazy-loaded from CDN only when needed)
- Recorder configuration page (`recorder/recorder.html`) with dark theme UI
- Recording preview page (`recorder/preview.html`) with video player and download options

### Changed
- Popup record buttons (Tab, Screen, Camera) now active — removed "Soon" badges
- Record buttons now open the recorder configuration page with source pre-selected
- Added `scripting` permission for recording widget injection
- Manifest version bumped to 0.3.0

## [0.2.0] - 2026-03-16

### Added
- **Annotation Editor (Sprint 2)** — full annotation toolkit:
  - Arrow tool — drag to draw arrows with triangular heads
  - Rectangle tool — rounded-corner outline rectangles
  - Ellipse/Circle tool — outline ellipses
  - Line tool — straight lines
  - Freehand/Pen tool — free drawing
  - Text tool — click to place text, inline input overlay, multi-line support
  - Blur/Pixelate tool — drag to select area, applies pixelation
  - Highlight tool — semi-transparent yellow marker rectangles
  - Crop tool — drag to select area, confirm button to apply
- Color picker (default red) for all annotation tools
- Stroke width selector (Thin 2px / Medium 4px / Thick 6px)
- Undo/Redo with full history stack (Ctrl+Z / Ctrl+Shift+Z)
- Keyboard shortcuts for all tools (A, R, E, L, P, T, B, H, C)
- ESC to cancel current operation
- Cursor changes per tool (crosshair, text, crop)
- SVG icons for all toolbar buttons
- Status bar shows active tool
- Layer/history stack architecture: each annotation is an object, full re-render on change
- requestAnimationFrame-based rendering for performance

### Changed
- Toolbar redesigned with tool groups, separators, and compact layout
- Editor CSS updated for new controls and dark theme consistency

## [0.1.0] - 2026-03-16

### Added
- Initial project scaffolding
- Manifest V3 configuration
- Project structure (popup, background, content, editor, assets)
- README with feature roadmap
