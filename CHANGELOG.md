# Changelog

All notable changes to ScreenSnap will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

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
