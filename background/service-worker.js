/**
 * @file ScreenSnap — Background Service Worker v0.4.2 (MV3)
 * @description Central coordinator for the extension. Handles capture commands,
 * keyboard shortcuts, recording state, notifications, onInstalled events,
 * and history management. Uses a message router pattern for clean dispatch.
 *
 * NOTE: Service workers can terminate after 30s of inactivity.
 * State is persisted via chrome.storage, not global variables.
 * @version 0.4.2
 */

// ── Imports (not available without "type": "module" — using inline for MV3 compat) ──
// Constants inlined since service worker doesn't use ES modules in this manifest config.
// When "type": "module" is added to manifest, switch to imports.

const MESSAGE_TYPES = Object.freeze({
  CAPTURE_VISIBLE: 'capture-visible',
  CAPTURE_FULL_PAGE: 'capture-full-page',
  CAPTURE_SELECTION: 'capture-selection',
  START_SELECTION: 'start-selection',
  FULL_PAGE_DATA: 'full-page-data',
  SELECTION_DATA: 'selection-data',
  SAVE_CAPTURE: 'save-capture',
  COPY_TO_CLIPBOARD: 'copy-to-clipboard',
  REQUEST_DESKTOP_CAPTURE: 'request-desktop-capture',
  RECORDING_STARTED: 'recording-started',
  RECORDING_PAUSED: 'recording-paused',
  RECORDING_RESUMED: 'recording-resumed',
  RECORDING_STOPPED: 'recording-stopped',
  GET_RECORDING_STATUS: 'get-recording-status',
  STOP_RECORDING: 'stop-recording',
  TOGGLE_PAUSE: 'toggle-pause',
  WIDGET_PAUSE: 'widget-pause',
  WIDGET_RESUME: 'widget-resume',
  WIDGET_MUTE: 'widget-mute',
  WIDGET_STOP: 'widget-stop',
  ADD_HISTORY_ENTRY: 'add-history-entry',
  OFFSCREEN_COPY_CLIPBOARD: 'offscreen-copy-clipboard',
  REMOVE_RECORDING_WIDGET: 'remove-recording-widget',
  NOTIFICATION_CLICK: 'notification-click',
});

const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  HISTORY_ENTRIES: 'historyEntries',
  ONBOARDING_COMPLETE: 'onboardingComplete',
  PENDING_CAPTURE: 'pendingCapture',
});

const DEFAULT_SETTINGS = Object.freeze({
  screenshotFormat: 'png',
  jpgQuality: 92,
  afterCapture: 'editor',
  saveSubfolder: '',
  recResolution: '1080',
  recAudio: 'both',
  recPip: 'off',
  recPipPosition: 'bottom-right',
  recPipSize: 'medium',
  recCountdown: 'on',
  recFormat: 'webm',
  theme: 'dark',
  notifications: 'on',
  keepHistory: 'on',
  maxHistory: 100,
});

const BADGE_RECORDING_COLOR = '#EF4444';
const EXTENSION_NAME = 'ScreenSnap';

// ── Logger ──────────────────────────────────────────

/**
 * Structured logger for the service worker.
 * @param {string} level - Log level name
 * @param {...*} args - Values to log
 */
function log(level, ...args) {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = `[${timestamp}][${EXTENSION_NAME}][SW][${level}]`;
  switch (level) {
    case 'ERROR': console.error(prefix, ...args); break;
    case 'WARN': console.warn(prefix, ...args); break;
    case 'INFO': console.info(prefix, ...args); break;
    default: console.debug(prefix, ...args);
  }
}

// ── Recording State (session storage for SW restart resilience) ──

/**
 * Get recording state from session storage (survives SW restart within session).
 * @returns {Promise<{isRecording: boolean, recorderTabId: number|null, recordingTargetTabId: number|null}>}
 */
async function getRecordingState() {
  try {
    const result = await chrome.storage.session.get('recordingState');
    return result.recordingState || { isRecording: false, recorderTabId: null, recordingTargetTabId: null };
  } catch {
    return { isRecording: false, recorderTabId: null, recordingTargetTabId: null };
  }
}

/**
 * Update recording state in session storage.
 * @param {Object} updates - Partial state updates
 * @returns {Promise<void>}
 */
async function setRecordingState(updates) {
  const current = await getRecordingState();
  await chrome.storage.session.set({ recordingState: { ...current, ...updates } });
}

// ── onInstalled — Welcome page & default settings ───

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    log('INFO', 'Extension installed — initializing');

    const result = await chrome.storage.local.get(STORAGE_KEYS.ONBOARDING_COMPLETE);
    if (!result[STORAGE_KEYS.ONBOARDING_COMPLETE]) {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
    }

    const existing = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
    if (!existing[STORAGE_KEYS.SETTINGS]) {
      await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS } });
    }
  } else if (details.reason === 'update') {
    const currentVersion = chrome.runtime.getManifest().version;
    log('INFO', `Extension updated to v${currentVersion} from v${details.previousVersion}`);
  }
});

// ── Keyboard Shortcuts ──────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getCurrentTab();
  if (!tab) {
    log('WARN', 'No active tab for command:', command);
    return;
  }

  switch (command) {
    case 'capture-visible':
      await captureVisibleArea(tab);
      break;
    case 'capture-full':
      await ensureContentScript(tab.id);
      await sendToContent(tab.id, { action: MESSAGE_TYPES.CAPTURE_FULL_PAGE });
      break;
    case 'capture-selection':
      await ensureContentScript(tab.id);
      await sendToContent(tab.id, { action: MESSAGE_TYPES.START_SELECTION });
      break;
    default:
      log('WARN', 'Unknown command:', command);
  }
});

// ── Message Router (Pub/Sub Pattern) ────────────────

/** @type {Map<string, Function>} Handler registry */
const messageHandlers = new Map();

/**
 * Register a message handler for a specific action type.
 * @param {string} action - Message action type
 * @param {Function} handler - Async handler function (payload, sender) => response
 */
function registerHandler(action, handler) {
  if (messageHandlers.has(action)) {
    log('WARN', `Handler already registered for: ${action}`);
  }
  messageHandlers.set(action, handler);
}

// Register all handlers
registerHandler(MESSAGE_TYPES.CAPTURE_VISIBLE, () => captureVisibleArea());
registerHandler(MESSAGE_TYPES.CAPTURE_FULL_PAGE, (msg, sender) => initiateFullPageCapture(sender.tab?.id));
registerHandler(MESSAGE_TYPES.CAPTURE_SELECTION, (msg, sender) => initiateSelectionCapture(sender.tab?.id));
registerHandler(MESSAGE_TYPES.FULL_PAGE_DATA, (msg) => processCapture(msg.dataUrl, msg.filename));
registerHandler(MESSAGE_TYPES.SELECTION_DATA, (msg) => processCapture(msg.dataUrl, msg.filename));
registerHandler(MESSAGE_TYPES.SAVE_CAPTURE, (msg) => saveCapture(msg.dataUrl, msg.filename, msg.format));
registerHandler(MESSAGE_TYPES.COPY_TO_CLIPBOARD, (msg) => copyToClipboard(msg.dataUrl));
registerHandler(MESSAGE_TYPES.REQUEST_DESKTOP_CAPTURE, (_msg, sender) => requestDesktopCapture(sender));
registerHandler(MESSAGE_TYPES.RECORDING_STARTED, (_msg, sender) => onRecordingStarted(sender));
registerHandler(MESSAGE_TYPES.RECORDING_PAUSED, () => onRecordingPaused());
registerHandler(MESSAGE_TYPES.RECORDING_RESUMED, () => onRecordingResumed());
registerHandler(MESSAGE_TYPES.RECORDING_STOPPED, () => onRecordingStopped());
registerHandler(MESSAGE_TYPES.GET_RECORDING_STATUS, async () => {
  const state = await getRecordingState();
  return { success: true, isRecording: state.isRecording };
});
registerHandler(MESSAGE_TYPES.WIDGET_PAUSE, () => forwardToRecorder(MESSAGE_TYPES.TOGGLE_PAUSE));
registerHandler(MESSAGE_TYPES.WIDGET_RESUME, () => forwardToRecorder(MESSAGE_TYPES.TOGGLE_PAUSE));
registerHandler(MESSAGE_TYPES.WIDGET_MUTE, () => forwardToRecorder('toggle-mute'));
registerHandler(MESSAGE_TYPES.WIDGET_STOP, () => forwardToRecorder(MESSAGE_TYPES.STOP_RECORDING));
registerHandler(MESSAGE_TYPES.ADD_HISTORY_ENTRY, (msg) => addHistoryEntry(msg.entry));
registerHandler(MESSAGE_TYPES.NOTIFICATION_CLICK, () => ({ success: true }));

// Main message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') {
    log('WARN', 'Received invalid message:', message);
    sendResponse({ success: false, error: 'Invalid message format' });
    return false;
  }

  const handler = messageHandlers.get(message.action);
  if (!handler) {
    log('WARN', 'No handler for action:', message.action);
    sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    return false;
  }

  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      log('ERROR', `Handler "${message.action}" threw:`, err.message);
      sendResponse({ success: false, error: err.message });
    });

  return true; // Keep channel open for async response
});

// ── Content Script Injection (dynamic — no manifest content_scripts) ────

/**
 * Dynamically inject the content script and CSS into a tab.
 * Uses a guard in the content script to prevent double-initialization.
 * @param {number} tabId - Target tab ID
 * @returns {Promise<boolean>} True if injection succeeded
 */
async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    if (
      !url ||
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('about:') ||
      url.startsWith('edge://') ||
      url.startsWith('devtools://')
    ) {
      log('WARN', 'Cannot inject content script into restricted URL:', url);
      return false;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js'],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content-style.css'],
    });
    return true;
  } catch (err) {
    log('WARN', 'Content script injection failed:', err.message);
    return false;
  }
}

// ── Screenshot Functions ────────────────────────────

/**
 * Capture the visible area of the active tab.
 * @param {chrome.tabs.Tab} [tab] - Optional tab reference (for keyboard shortcut context)
 * @returns {Promise<{success: boolean, dataUrl?: string, error?: string}>}
 */
async function captureVisibleArea(tab) {
  try {
    const settings = await getSettings();
    const format = settings.screenshotFormat || 'png';
    const quality = format === 'jpg' ? (settings.jpgQuality || 92) : 92;

    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: format === 'jpg' ? 'jpeg' : 'png',
      quality,
    });

    return { success: true, dataUrl };
  } catch (err) {
    log('ERROR', 'Capture visible failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Initiate a full-page capture by injecting and messaging the content script.
 * @param {number} [tabId] - Target tab ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function initiateFullPageCapture(tabId) {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };

  const injected = await ensureContentScript(tab.id);
  if (!injected) return { success: false, error: 'Cannot capture this page (restricted URL)' };

  await sendToContent(tab.id, { action: MESSAGE_TYPES.CAPTURE_FULL_PAGE });
  return { success: true };
}

/**
 * Initiate selection capture by injecting and messaging the content script.
 * @param {number} [tabId] - Target tab ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function initiateSelectionCapture(tabId) {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };

  const injected = await ensureContentScript(tab.id);
  if (!injected) return { success: false, error: 'Cannot capture this page (restricted URL)' };

  await sendToContent(tab.id, { action: MESSAGE_TYPES.START_SELECTION });
  return { success: true };
}

/**
 * Process a captured screenshot based on user's after-capture preference.
 * @param {string} dataUrl - The screenshot data URL
 * @param {string} [filename] - Optional filename
 * @returns {Promise<{success: boolean}>}
 */
async function processCapture(dataUrl, filename) {
  const settings = await getSettings();
  const afterCapture = settings.afterCapture || 'editor';

  if (afterCapture === 'clipboard') {
    await copyToClipboard(dataUrl);
    await showNotification('Screenshot copied!', 'Copied to clipboard');
  } else if (afterCapture === 'save') {
    await saveCapture(dataUrl, filename);
    await showNotification('Screenshot saved!', filename || 'Saved to Downloads');
  } else {
    // Open editor (default)
    await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_CAPTURE]: dataUrl });
    await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  }

  return { success: true };
}

/**
 * Save a screenshot to the Downloads folder.
 * @param {string} dataUrl - Image data URL
 * @param {string} [filename] - Optional filename
 * @param {string} [format] - Image format override
 * @returns {Promise<{success: boolean, downloadId?: number, error?: string}>}
 */
async function saveCapture(dataUrl, filename, format) {
  const settings = await getSettings();
  const ext = format || settings.screenshotFormat || 'png';
  let name = filename || `${EXTENSION_NAME}_${getTimestamp()}.${ext}`;

  // Sanitize the filename
  name = sanitizeFilename(name);

  // Apply subfolder if set
  const subfolder = sanitizeFilename(settings.saveSubfolder);
  if (subfolder) {
    name = `${subfolder}/${name}`;
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: name,
      saveAs: false,
    });
    await showNotification('Screenshot saved!', name);
    return { success: true, downloadId };
  } catch (err) {
    log('ERROR', 'Save failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Copy an image to clipboard via the offscreen document.
 * @param {string} dataUrl - Image data URL to copy
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function copyToClipboard(dataUrl) {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.OFFSCREEN_COPY_CLIPBOARD,
      dataUrl,
    });
    return { success: true };
  } catch (err) {
    log('ERROR', 'Clipboard copy failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Recording Functions ─────────────────────────────

/**
 * Show the desktop capture picker and return the stream ID.
 * @param {chrome.runtime.MessageSender} sender - The message sender
 * @returns {Promise<{success: boolean, streamId?: string, error?: string}>}
 */
async function requestDesktopCapture(sender) {
  return new Promise((resolve) => {
    const senderTab = sender.tab;
    if (!senderTab) {
      resolve({ success: false, error: 'No sender tab for desktop capture' });
      return;
    }

    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab'],
      senderTab,
      (streamId) => {
        if (!streamId) {
          resolve({ success: false, error: 'User cancelled desktop capture picker' });
        } else {
          resolve({ success: true, streamId });
        }
      }
    );
  });
}

/**
 * Handle recording-started notification from the recorder tab.
 * Sets badge, injects recording widget into the target tab.
 * Guards against simultaneous recordings.
 * @param {chrome.runtime.MessageSender} sender - Message sender (recorder tab)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function onRecordingStarted(sender) {
  const currentState = await getRecordingState();
  if (currentState.isRecording) {
    log('WARN', 'Ignoring recording-started — another recording is already active');
    return { success: false, error: 'A recording is already in progress' };
  }

  const recorderTabId = sender.tab?.id || null;
  await setRecordingState({ isRecording: true, recorderTabId });

  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const tab of tabs) {
      if (tab.id !== recorderTabId && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        await setRecordingState({ recordingTargetTabId: tab.id });
        await injectRecordingWidget(tab.id);
        break;
      }
    }
  } catch (err) {
    log('WARN', 'Could not inject recording widget:', err.message);
  }

  return { success: true };
}

/**
 * Inject the recording controls widget into a tab.
 * @param {number} tabId - Target tab ID
 * @returns {Promise<void>}
 */
async function injectRecordingWidget(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recorder/recording-controls.js'],
    });
  } catch (err) {
    log('WARN', 'Widget injection failed:', err.message);
  }
}

/**
 * Handle recording-paused event.
 * @returns {Promise<{success: boolean}>}
 */
async function onRecordingPaused() {
  await chrome.action.setBadgeText({ text: '⏸' });
  return { success: true };
}

/**
 * Handle recording-resumed event.
 * @returns {Promise<{success: boolean}>}
 */
async function onRecordingResumed() {
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
  return { success: true };
}

/**
 * Handle recording-stopped event. Cleans up badge and widget.
 * @returns {Promise<{success: boolean}>}
 */
async function onRecordingStopped() {
  const state = await getRecordingState();

  await chrome.action.setBadgeText({ text: '' });
  await showNotification('Recording saved!', 'Your recording is ready');

  if (state.recordingTargetTabId) {
    try {
      await chrome.tabs.sendMessage(state.recordingTargetTabId, {
        action: MESSAGE_TYPES.REMOVE_RECORDING_WIDGET,
      });
    } catch {
      // Tab may have been closed — safe to ignore
    }
  }

  await setRecordingState({ isRecording: false, recorderTabId: null, recordingTargetTabId: null });
  return { success: true };
}

/**
 * Forward a command to the recorder tab.
 * @param {string} action - The action to forward
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function forwardToRecorder(action) {
  const state = await getRecordingState();
  if (!state.recorderTabId) {
    return { success: false, error: 'No recorder tab' };
  }

  try {
    const response = await chrome.tabs.sendMessage(state.recorderTabId, { action });
    return response || { success: true };
  } catch (err) {
    log('WARN', 'Forward to recorder failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Notifications ───────────────────────────────────

/**
 * Show a chrome notification if notifications are enabled in settings.
 * @param {string} title - Notification title
 * @param {string} [message=''] - Notification body
 * @returns {Promise<void>}
 */
async function showNotification(title, message) {
  try {
    const settings = await getSettings();
    if (settings.notifications === 'off') return;

    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
      title: `${EXTENSION_NAME} — ${title}`,
      message: message || '',
      silent: false,
    });
  } catch (err) {
    log('WARN', 'Notification failed:', err.message);
  }
}

// Graceful degradation: notifications API may not be available in all contexts
if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
    chrome.notifications.clear(notificationId);
  });
}

// ── History Management ──────────────────────────────

/**
 * Add a new entry to the capture history.
 * @param {Object} entry - History entry object
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function addHistoryEntry(entry) {
  try {
    const settings = await getSettings();
    if (settings.keepHistory === 'off') return { success: true };

    const maxHistory = settings.maxHistory || 100;
    const result = await chrome.storage.local.get(STORAGE_KEYS.HISTORY_ENTRIES);
    const entries = result[STORAGE_KEYS.HISTORY_ENTRIES] || [];

    entries.unshift(entry);

    while (entries.length > maxHistory) {
      entries.pop();
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY_ENTRIES]: entries });
    return { success: true };
  } catch (err) {
    log('ERROR', 'Failed to add history entry:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Helpers ─────────────────────────────────────────

/**
 * Get the active tab in the current window.
 * @returns {Promise<chrome.tabs.Tab|undefined>}
 */
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Send a message to a content script in a specific tab.
 * @param {number} tabId - Target tab ID
 * @param {Object} message - Message to send
 * @returns {Promise<*>}
 */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    log('WARN', `Failed to send to tab ${tabId}:`, err.message);
    return null;
  }
}

/**
 * Load settings from chrome.storage.sync with defaults.
 * @returns {Promise<Object>} Merged settings
 */
async function getSettings() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Generate a formatted timestamp for filenames.
 * @returns {string} Timestamp in YYYY-MM-DD_HH-MM-SS format
 */
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Sanitize a filename by removing unsafe characters.
 * @param {string} name - Raw filename
 * @returns {string} Cleaned filename
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').trim().slice(0, 200);
}

/**
 * Ensure the offscreen document exists for clipboard operations.
 * Checks for existing documents before creating to avoid duplicates.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy screenshot to clipboard',
    });
  } catch (err) {
    log('ERROR', 'Failed to create offscreen document:', err.message);
    throw err;
  }
}

// ── Tab Removal Cleanup ─────────────────────────────

/**
 * Detect when the recorder tab is closed during an active recording.
 * Cleans up recording state and badge if the recorder tab goes away.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const state = await getRecordingState();
    if (state.isRecording && state.recorderTabId === tabId) {
      log('WARN', 'Recorder tab closed during recording — cleaning up');
      await onRecordingStopped();
    }
  } catch (err) {
    log('WARN', 'Tab removal cleanup error:', err.message);
  }
});

log('INFO', `Service worker initialized (v${chrome.runtime.getManifest().version})`);
