/**
 * @file ScreenBolt — Shared Constants
 * @description Single source of truth for all constants used across the extension.
 * Import this module wherever you need message types, storage keys, or configuration values.
 * @version 0.5.0
 */

// ── Message Types ───────────────────────────────────
/** @enum {string} All message action types used in runtime.sendMessage */
export const MESSAGE_TYPES = Object.freeze({
  // Screenshot actions
  CAPTURE_VISIBLE: 'capture-visible',
  CAPTURE_FULL_PAGE: 'capture-full-page',
  CAPTURE_SELECTION: 'capture-selection',
  START_SELECTION: 'start-selection',
  FULL_PAGE_DATA: 'full-page-data',
  SELECTION_DATA: 'selection-data',
  SAVE_CAPTURE: 'save-capture',
  COPY_TO_CLIPBOARD: 'copy-to-clipboard',
  CAPTURE_VISIBLE_FOR_STITCH: 'capture-visible-for-stitch',

  // Recording actions
  REQUEST_DESKTOP_CAPTURE: 'request-desktop-capture',
  RECORDING_STARTED: 'recording-started',
  RECORDING_PAUSED: 'recording-paused',
  RECORDING_RESUMED: 'recording-resumed',
  RECORDING_STOPPED: 'recording-stopped',
  GET_RECORDING_STATUS: 'get-recording-status',
  STOP_RECORDING: 'stop-recording',
  TOGGLE_PAUSE: 'toggle-pause',
  TOGGLE_MUTE: 'toggle-mute',

  // Inline recording actions (popup → SW → offscreen)
  START_RECORDING: 'start-recording',
  GET_RECORDING_TIME: 'get-recording-time',
  OFFSCREEN_START_RECORDING: 'offscreen-start-recording',
  OFFSCREEN_STOP_RECORDING: 'offscreen-stop-recording',
  OFFSCREEN_TOGGLE_PAUSE: 'offscreen-toggle-pause',
  OFFSCREEN_TOGGLE_MUTE: 'offscreen-toggle-mute',
  OFFSCREEN_GET_TIME: 'offscreen-get-time',
  OFFSCREEN_RECORDING_COMPLETE: 'offscreen-recording-complete',

  // Widget actions (from content script recording widget)
  WIDGET_PAUSE: 'widget-pause',
  WIDGET_RESUME: 'widget-resume',
  WIDGET_MUTE: 'widget-mute',
  WIDGET_STOP: 'widget-stop',

  // History actions
  ADD_HISTORY_ENTRY: 'add-history-entry',

  // Offscreen actions
  OFFSCREEN_COPY_CLIPBOARD: 'offscreen-copy-clipboard',

  // Widget removal
  REMOVE_RECORDING_WIDGET: 'remove-recording-widget',

  // Notifications
  NOTIFICATION_CLICK: 'notification-click',
});

// ── Storage Keys ────────────────────────────────────
/** @enum {string} Keys used in chrome.storage */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  HISTORY_ENTRIES: 'historyEntries',
  ONBOARDING_COMPLETE: 'onboardingComplete',
  PENDING_CAPTURE: 'pendingCapture',
  PENDING_RECORDING: 'pendingRecording',
  RECORDING_CHUNKS_COUNT: 'recording-chunks-count',
  RECORDING_MIME: 'recording-mime',
  RECORDING_CHUNK_PREFIX: 'recording-chunk-',
});

// ── Default Settings ────────────────────────────────
/** @type {Object} Default settings applied on first install */
export const DEFAULT_SETTINGS = Object.freeze({
  // Screenshot
  screenshotFormat: 'png',
  jpgQuality: 92,
  afterCapture: 'editor',
  saveSubfolder: '',

  // Recording
  recResolution: '1080',
  recAudio: 'both',
  recPip: 'off',
  recPipPosition: 'bottom-right',
  recPipSize: 'medium',
  recCountdown: 'on',
  recFormat: 'webm',

  // General
  theme: 'dark',
  notifications: 'on',
  keepHistory: 'on',
  maxHistory: 100,
});

// ── Capture Formats ─────────────────────────────────
/** @enum {string} Supported screenshot formats */
export const CAPTURE_FORMATS = Object.freeze({
  PNG: 'png',
  JPG: 'jpg',
});

// ── Recording Sources ───────────────────────────────
/** @enum {string} Recording source types */
export const RECORDING_SOURCES = Object.freeze({
  TAB: 'tab',
  SCREEN: 'screen',
  CAMERA: 'camera',
});

// ── Resolution Presets ──────────────────────────────
/** @type {Object<string, {width: number, height: number}>} */
export const RESOLUTION_PRESETS = Object.freeze({
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  '2160': { width: 3840, height: 2160 },
});

// ── PiP Configuration ───────────────────────────────
/** @type {Object<string, number>} Bubble diameter in pixels */
export const PIP_SIZES = Object.freeze({
  small: 120,
  medium: 180,
  large: 240,
});

/** @type {number} Margin from screen edge in pixels */
export const PIP_MARGIN = 20;

// ── Editor Constants ────────────────────────────────
/** @type {Object} Editor tool names */
export const EDITOR_TOOLS = Object.freeze({
  ARROW: 'arrow',
  RECT: 'rect',
  CIRCLE: 'circle',
  LINE: 'line',
  FREEHAND: 'freehand',
  TEXT: 'text',
  BLUR: 'blur',
  HIGHLIGHT: 'highlight',
  CROP: 'crop',
});

/** @type {Object<string, string>} Keyboard shortcut → tool mapping */
export const EDITOR_SHORTCUTS = Object.freeze({
  a: EDITOR_TOOLS.ARROW,
  r: EDITOR_TOOLS.RECT,
  e: EDITOR_TOOLS.CIRCLE,
  l: EDITOR_TOOLS.LINE,
  p: EDITOR_TOOLS.FREEHAND,
  t: EDITOR_TOOLS.TEXT,
  b: EDITOR_TOOLS.BLUR,
  h: EDITOR_TOOLS.HIGHLIGHT,
  c: EDITOR_TOOLS.CROP,
});

/** @type {Object} Text font sizes mapped from stroke width */
export const TEXT_FONT_SIZES = Object.freeze({
  THIN: 16,
  MEDIUM: 24,
  THICK: 36,
});

/** @type {number} Minimum drag distance (px) to register as a shape, not a click */
export const MIN_DRAG_DISTANCE = 3;

/** @type {number} Minimum selection area to be valid (px) */
export const MIN_SELECTION_SIZE = 5;

/** @type {number} Minimum blur area dimension (px) */
export const MIN_BLUR_SIZE = 2;

/** @type {number} Corner radius for rectangle annotations (px) */
export const RECT_CORNER_RADIUS = 8;

/** @type {string} Highlight overlay color */
export const HIGHLIGHT_COLOR = 'rgba(255, 214, 0, 0.35)';

// ── Timing Constants ────────────────────────────────
/** @type {number} Delay between scroll captures for full-page mode (ms) */
export const SCROLL_CAPTURE_DELAY_MS = 150;

/** @type {number} Countdown seconds before recording starts */
export const RECORDING_COUNTDOWN_SECONDS = 3;

/** @type {number} MediaRecorder data collection interval (ms) */
export const MEDIA_RECORDER_TIMESLICE_MS = 1000;

/** @type {number} Toast notification display duration (ms) */
export const TOAST_DURATION_MS = 2500;

/** @type {number} Settings save status display duration (ms) */
export const SAVE_STATUS_DURATION_MS = 1500;

// ── Recording Quality ───────────────────────────────
/** @type {number} Video bitrate for recordings (bps) */
export const VIDEO_BITRATE = 5_000_000;

/** @type {number} Canvas capture FPS for PiP compositing */
export const PIP_CANVAS_FPS = 30;

/** @type {number} JPEG quality for editor export (0-1) */
export const JPEG_EXPORT_QUALITY = 0.92;

/** @type {number} JPEG quality for thumbnails (0-1) */
export const THUMBNAIL_QUALITY = 0.6;

// ── Storage Limits ──────────────────────────────────
/** @type {number} Max dataUrl size to store in history (bytes) */
export const MAX_HISTORY_DATAURL_SIZE = 500_000;

/** @type {number} Thumbnail max dimensions (px) */
export const THUMBNAIL_MAX_WIDTH = 320;
export const THUMBNAIL_MAX_HEIGHT = 200;

/** @type {number} Recording chunk size for storage serialization (bytes) */
export const RECORDING_CHUNK_SIZE = 5 * 1024 * 1024;

// ── History Pagination ──────────────────────────────
/** @type {number} Items per page in history grid */
export const HISTORY_PAGE_SIZE = 24;

// ── Badge Colors ────────────────────────────────────
/** @type {string} Badge background during recording */
export const BADGE_RECORDING_COLOR = '#EF4444';

// ── Extension Info ──────────────────────────────────
/** @type {string} Extension name prefix for logs and notifications */
export const EXTENSION_NAME = 'ScreenBolt';

/** @type {string} Current version */
export const VERSION = '0.7.7';
