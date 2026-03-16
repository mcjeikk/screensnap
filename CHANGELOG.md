# Changelog

All notable changes to ScreenSnap will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [0.5.0] - 2026-03-16

### Added
- **Service Worker Lifecycle**: `chrome.runtime.onStartup` handler recovers stale recording state after browser restart
- **Service Worker Lifecycle**: `chrome.runtime.onSuspend` handler logs suspension events for debugging
- **Keepalive**: `chrome.alarms`-based keepalive during active recording to prevent service worker termination
- **Offscreen Cleanup**: Offscreen document is now closed after clipboard copy to free resources
- **Error Recovery**: Content script detects "Extension context invalidated" and shows refresh banner
- **Error Recovery**: Content script retries failed `sendMessage` calls once (handles SW restart)
- **Error Recovery**: Recording controls widget safely handles context invalidation
- **Manifest**: Added `minimum_chrome_version: "116"` for API compatibility
- **Manifest**: Added `alarms` permission for recording keepalive
- **Testing Guide**: `tests/README.md` with manual testing checklist, Puppeteer/Playwright setup, and CI config
- **CWS Publishing**: `store/description.txt` — full Chrome Web Store description
- **CWS Publishing**: `store/short-description.txt` — 132-char summary
- **CWS Publishing**: `store/privacy-policy.md` — complete privacy policy
- **CWS Publishing**: `store/PUBLISHING.md` — step-by-step CWS publishing guide
- **Documentation**: `docs/CROSS_BROWSER.md` — Firefox/Edge porting analysis and effort estimates
- **Documentation**: `docs/AUDIT_RESULTS.md` — 83-item audit checklist results (84% passing)

### Changed
- **Preview**: Replaced `beforeunload` with `pagehide` for better bfcache compatibility
- **Content Script**: All outgoing `chrome.runtime.sendMessage` calls now use `safeSendMessage` with retry logic
- **Recording Widget**: Message sends wrapped in `safeSend` with context invalidation handling
- **Version**: Bumped all file headers and UI references to v0.5.0

### Fixed
- Service worker could be terminated during active recording (now kept alive via alarms)
- Offscreen document leaked after clipboard copy (now properly closed)
- Content script crashed silently after extension update (now shows refresh banner)
- Stale recording badge/state persisted after browser restart (now cleaned up on startup)

## [0.4.2] - 2026-03-16

### Changed
- **Manifest**: Removed static `content_scripts` declaration — content script and CSS are now injected dynamically via `chrome.scripting.executeScript()` only when capture is initiated, eliminating injection overhead on every page load
- **Service Worker**: Added `ensureContentScript(tabId)` helper with URL validation (skips chrome://, about:, edge:// pages) before injection
- **Service Worker**: Added `chrome.tabs.onRemoved` listener to clean up recording state (badge, widget) if recorder tab is closed during active recording
- **Service Worker**: Added simultaneous recording guard in `onRecordingStarted` — rejects if another recording is already active
- **Service Worker**: Graceful degradation for `chrome.notifications.onClicked` (checks API availability)
- **Recorder**: Added existing recording check on page load — disables start button with error message if a recording is already in progress
- **Recorder**: Timer now correctly tracks paused duration (`pausedDuration` accumulator) instead of showing total elapsed time including pauses
- **Recording Widget**: Timer now correctly tracks paused duration, matching the fix applied to the recorder page
- **Error Boundaries**: All extension pages now have global `window.error` and `unhandledrejection` handlers (via theme-init.js) that log errors and show a user-friendly toast

### Fixed
- **Race condition**: Recorder.js `onMessage` listener no longer responds to unknown message types — previously, when the service worker sent clipboard messages to the offscreen document, the recorder page's synchronous error response could override the offscreen document's async success response, causing clipboard copy to fail when recorder tab was open
- **Timer inaccuracy**: Both recorder page timer and floating recording widget timer now subtract paused duration from elapsed time, showing actual recording time instead of wall-clock time
- **Restricted URL crash**: Keyboard shortcuts and capture buttons now gracefully fail with an error message when used on chrome://, about://, or extension pages instead of throwing

## [0.4.1] - 2026-03-16

### Changed
- **Architecture**: Implemented centralized Message Router pattern (pub/sub) in service worker
- **Architecture**: Created shared utility modules in `utils/`:
  - `constants.js` — Single source of truth for all message types, storage keys, and config values
  - `logger.js` — Structured logging system with levels and module prefixes
  - `storage.js` — chrome.storage wrapper with error handling and quota management
  - `helpers.js` — Shared utilities: timestamps, file sizes, sanitization, debounce, throttle
  - `messages.js` — Type-safe message passing with validation
- **Security**: Replaced all `innerHTML` with safe DOM construction in history, recording controls
- **Security**: Added input sanitization for filenames and user text
- **Security**: Added message validation (type checking) in service worker and all listeners
- **Performance**: Service worker now uses `chrome.storage.session` for recording state (survives SW restart)
- **Performance**: Canvas cleanup (width/height = 0) after crop and thumbnail generation
- **Performance**: Object URL revocation in preview page (beforeunload cleanup)
- **Performance**: Added debounce to history search input
- **Performance**: Proper AbortController usage for selection overlay event cleanup
- **Accessibility**: ARIA labels on all buttons, inputs, and interactive elements across all pages
- **Accessibility**: `role` attributes on toolbars, groups, dialogs, and status regions
- **Accessibility**: `aria-pressed` state on all editor tool toggle buttons
- **Accessibility**: `aria-live` regions for status messages and recording indicators
- **Accessibility**: Focus-visible styles for keyboard navigation on all interactive elements
- **Accessibility**: Screen reader-only status message region in popup
- **Accessibility**: Keyboard activation (Enter/Space) for history item cards
- **Code Quality**: JSDoc comments on ALL functions across the entire codebase
- **Code Quality**: File header comments describing purpose and version on every file
- **Code Quality**: Magic numbers extracted to named constants
- **Code Quality**: Consistent error handling with try/catch and descriptive messages
- **Code Quality**: `'use strict'` in all IIFE-wrapped modules
- **Documentation**: Professional README with architecture overview, installation guide, and privacy note
- **Documentation**: Contributing guidelines and commit conventions

### Fixed
- Recording blob URL not revoked after storing to chrome.storage (memory leak)
- Camera preview stream not stopped when switching away from camera source
- Potential double-injection of content script (guard already existed, now more robust)
- Missing error handler on image.onerror in editor loadImage
- History confirm dialog now properly traps focus on cancel button

## [0.4.0] - 2026-03-16

### Added
- **History Page** (`history/`) — full capture history with grid view:
  - Displays all screenshots and recordings with thumbnails
  - Filter by type: All / Screenshots / Recordings
  - Search by name, sort by date/size/name
  - Delete individual items or "Clear All"
  - Pagination with "Load more" button
  - Click to re-open in editor (screenshots) or find in Downloads (recordings)
  - Max 100 entries by default (configurable), auto-prunes oldest
- **Settings Page** (`settings/`) — complete configuration:
  - Screenshot settings: format (PNG/JPG), JPG quality slider, after-capture action, save subfolder
  - Recording settings: resolution, audio, PiP, countdown, format defaults
  - General: theme, notifications, history on/off, max history items
  - Keyboard shortcuts reference (read-only)
  - All settings persist via `chrome.storage.sync` (cross-device sync)
- **Theme System** — Light / Dark / System auto-detect:
  - CSS custom properties in `assets/styles/themes.css`
  - Applied to ALL pages: popup, editor, recorder, preview, history, settings, welcome
  - System mode uses `prefers-color-scheme` media query
  - Theme preference saved in settings
- **PDF Export** — in the editor toolbar:
  - Generates valid PDF with embedded JPEG image, no external libraries
  - Manual PDF binary construction (header, catalog, pages, image XObject, xref, trailer)
  - Downloads via `chrome.downloads`
- **Professional Icon** — new SVG-based icon:
  - Camera/viewfinder design with lightning bolt (snap) motif
  - Indigo gradient (#4F46E5 → #6366F1)
  - Generated crisp PNGs at 16, 32, 48, 128px via Sharp
- **Chrome Notifications** — after each capture/recording:
  - Uses `chrome.notifications.create()` with extension icon
  - Click notification → opens History page
  - Respects notifications on/off setting
  - Added `notifications` permission to manifest
- **Welcome / Onboarding Page** (`welcome/`):
  - Shown once on first install via `chrome.runtime.onInstalled`
  - 4 slides: Welcome, Screenshots, Annotations, Recording
  - SVG illustrations for each feature
  - Keyboard navigation (arrows) and dot indicators
  - Marks completion in storage (won't repeat)
- **Popup Polish**:
  - Recording indicator when a recording is active
  - Last capture quick access with thumbnail
  - Version number (v0.4.0) in footer
  - Smooth hover transitions with shadow effects
  - Correct links to History and Settings pages

### Changed
- Popup links now point to `history/history.html` and `settings/settings.html` (previously pointed to non-existent `editor/` paths)
- Settings are now read from `chrome.storage.sync` across all modules (editor, recorder, background)
- Service worker reads settings for screenshot format, quality, and after-capture behavior
- Editor saves captures to history automatically on load
- All page CSS refactored to use theme CSS custom properties (`--ss-*`)
- Manifest version bumped to 0.4.0

### Fixed
- Popup History/Settings links were pointing to wrong paths (`editor/history.html` → `history/history.html`)

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
