/**
 * @file ScreenBolt — Background Service Worker v0.7.0 (MV3 ES Module)
 * @description Central coordinator for the extension. Handles capture commands,
 * keyboard shortcuts, inline recording orchestration (popup → offscreen → widget),
 * notifications, onInstalled events, and history management.
 *
 * Recording flow (v0.7.0):
 * 1. Popup sends 'start-recording' with config
 * 2. SW gets tabCapture streamId (user gesture chain from popup click)
 * 3. SW creates offscreen document and passes streamId + config
 * 4. Offscreen runs MediaRecorder, SW injects floating widget into user's tab
 * 5. Widget controls → SW → offscreen (pause/mute/stop)
 * 6. On stop: offscreen serializes to storage, SW opens preview page
 *
 * NOTE: Service workers can terminate after 30s of inactivity.
 * State is persisted via chrome.storage, not global variables.
 * @version 0.7.0
 */

// ── ES Module Imports ───────────────────────────────
import {
  MESSAGE_TYPES,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  BADGE_RECORDING_COLOR,
  EXTENSION_NAME,
} from '../utils/constants.js';

import { createLogger } from '../utils/logger.js';
import { getTimestamp, sanitizeFilename } from '../utils/helpers.js';
import { getSettings } from '../utils/storage.js';
import { ExtensionError, ErrorCodes } from '../utils/errors.js';
import { hasNotificationsSupport, hasPermission } from '../utils/feature-detection.js';
import { runMigrations } from '../utils/migration.js';

// ── Logger ──────────────────────────────────────────
const log = createLogger('SW');

// ── Init Promise ────────────────────────────────────

/** @type {Object} Cached settings */
let settingsCache = { ...DEFAULT_SETTINGS };

/**
 * Initialization promise — loads settings into cache before any handler runs.
 * @type {Promise<void>}
 */
const initPromise = chrome.storage.sync.get(STORAGE_KEYS.SETTINGS).then((result) => {
  settingsCache = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  log.debug('Settings cache initialized');
}).catch((err) => {
  log.warn('Failed to load settings cache, using defaults:', err.message);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEYS.SETTINGS]) {
    settingsCache = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.SETTINGS].newValue || {}) };
    log.debug('Settings cache updated');
  }
});

/**
 * Get cached settings.
 * @returns {Promise<Object>}
 */
async function getCachedSettings() {
  await initPromise;
  return settingsCache;
}

// ── Recording State (session storage) ───────────────

/**
 * Get recording state from session storage.
 * @returns {Promise<{isRecording: boolean, targetTabId: number|null}>}
 */
async function getRecordingState() {
  try {
    const result = await chrome.storage.session.get('recordingState');
    return result.recordingState || { isRecording: false, targetTabId: null };
  } catch {
    return { isRecording: false, targetTabId: null };
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

// ── onInstalled ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await initPromise;

  if (details.reason === 'install') {
    log.info('Extension installed — initializing');

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
    const previousVersion = details.previousVersion || '0.0.0';
    log.info(`Extension updated to v${currentVersion} from v${previousVersion}`);
    await runMigrations(previousVersion, currentVersion);
  }
});

// ── Keyboard Shortcuts ──────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  await initPromise;

  const tab = await getCurrentTab();
  if (!tab) {
    log.warn('No active tab for command:', command);
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
      log.warn('Unknown command:', command);
  }
});

// ── Message Router ──────────────────────────────────

/** @type {Map<string, Function>} */
const messageHandlers = new Map();

/**
 * Register a message handler.
 * @param {string} action - Message action type
 * @param {Function} handler - (payload, sender) => response
 */
function registerHandler(action, handler) {
  messageHandlers.set(action, handler);
}

// Screenshot handlers
registerHandler(MESSAGE_TYPES.CAPTURE_VISIBLE, () => captureVisibleArea());
registerHandler(MESSAGE_TYPES.CAPTURE_FULL_PAGE, (msg, sender) => initiateFullPageCapture(sender.tab?.id));
registerHandler(MESSAGE_TYPES.CAPTURE_SELECTION, (msg, sender) => initiateSelectionCapture(sender.tab?.id));
registerHandler(MESSAGE_TYPES.FULL_PAGE_DATA, (msg) => processCapture(msg.dataUrl, msg.filename));
registerHandler(MESSAGE_TYPES.SELECTION_DATA, (msg) => processCapture(msg.dataUrl, msg.filename));
registerHandler(MESSAGE_TYPES.SAVE_CAPTURE, (msg) => saveCapture(msg.dataUrl, msg.filename, msg.format));
registerHandler(MESSAGE_TYPES.COPY_TO_CLIPBOARD, (msg) => copyToClipboard(msg.dataUrl));

// Recording handlers (new inline flow)
registerHandler('start-recording', (msg, sender) => handleStartRecording(msg.config, sender));
registerHandler(MESSAGE_TYPES.GET_RECORDING_STATUS, async () => {
  const state = await getRecordingState();
  return { success: true, isRecording: state.isRecording };
});

// Widget control forwarding → offscreen
registerHandler(MESSAGE_TYPES.WIDGET_PAUSE, () => forwardToOffscreen('offscreen-toggle-pause'));
registerHandler(MESSAGE_TYPES.WIDGET_RESUME, () => forwardToOffscreen('offscreen-toggle-pause'));
registerHandler(MESSAGE_TYPES.WIDGET_MUTE, () => forwardToOffscreen('offscreen-toggle-mute'));
registerHandler(MESSAGE_TYPES.WIDGET_STOP, () => handleStopRecording());

// Timer request from widget
registerHandler('get-recording-time', () => forwardToOffscreen('offscreen-get-time'));

// Offscreen recording data relay (offscreen can't access chrome.storage)
registerHandler('offscreen-store-recording-meta', async (msg) => {
  await chrome.storage.local.set({
    'recording-chunks-count': msg.totalChunks,
    'recording-mime': msg.mimeType,
    'pendingRecording': {
      duration: msg.duration,
      size: msg.size,
      mimeType: msg.mimeType,
      timestamp: Date.now(),
    },
  });
  return { success: true };
});

registerHandler('offscreen-store-recording-chunk', async (msg) => {
  await chrome.storage.local.set({ [`recording-chunk-${msg.index}`]: msg.data });
  return { success: true };
});

// Offscreen recording complete
registerHandler('offscreen-recording-complete', (msg) => onRecordingComplete(msg.duration, msg.size));

// History
registerHandler(MESSAGE_TYPES.ADD_HISTORY_ENTRY, (msg) => addHistoryEntry(msg.entry));

// Recording state notifications (badge updates)
registerHandler(MESSAGE_TYPES.RECORDING_PAUSED, () => onRecordingPaused());
registerHandler(MESSAGE_TYPES.RECORDING_RESUMED, () => onRecordingResumed());

// Misc
registerHandler(MESSAGE_TYPES.NOTIFICATION_CLICK, () => ({ success: true }));

// Main message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') {
    sendResponse({ success: false, error: 'Invalid message format' });
    return false;
  }

  const handler = messageHandlers.get(message.action);
  if (!handler) {
    // Don't warn for offscreen-internal messages that pass through
    if (!message.action.startsWith('offscreen-')) {
      log.warn('No handler for action:', message.action);
    }
    sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    return false;
  }

  // CRITICAL: For start-recording, call tabCapture IMMEDIATELY in the user gesture
  // chain — before initPromise.then() which breaks the gesture chain.
  if (message.action === 'start-recording' && message.config?.source === 'tab') {
    const [activeTab] = []; // placeholder
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const targetTabId = tabs[0]?.id;
      if (!targetTabId) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      // Call getMediaStreamId SYNCHRONOUSLY in the user gesture callback chain
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Failed to get stream ID' });
          return;
        }
        // Now continue async with the streamId already obtained
        const configWithStream = { ...message.config, streamId, targetTabId };
        initPromise.then(() => continueStartRecording(configWithStream))
          .then((result) => sendResponse(result))
          .catch((err) => {
            log.error('Start recording failed:', err.message);
            sendResponse({ success: false, error: err.message });
          });
      });
    });
    return true; // Keep channel open
  }

  initPromise.then(() => handler(message, sender))
    .then((result) => sendResponse(result))
    .catch((err) => {
      const errorMsg = err instanceof ExtensionError
        ? `[${err.code}] ${err.message}`
        : err.message;
      log.error(`Handler "${message.action}" threw:`, errorMsg);
      sendResponse({ success: false, error: err.message });
    });

  return true;
});

// ── Content Script Injection ────────────────────────

/**
 * Dynamically inject the content script and CSS into a tab.
 * @param {number} tabId - Target tab ID
 * @returns {Promise<boolean>}
 */
async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    if (isRestrictedUrl(url)) {
      log.warn('Cannot inject into restricted URL:', url);
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
    log.warn('Content script injection failed:', err.message);
    return false;
  }
}

/**
 * Check if a URL is restricted (cannot inject scripts).
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isRestrictedUrl(url) {
  return !url ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://');
}

// ── Screenshot Functions ────────────────────────────

/**
 * Capture the visible area of the active tab.
 * @returns {Promise<{success: boolean, dataUrl?: string}>}
 */
async function captureVisibleArea() {
  try {
    const settings = await getCachedSettings();
    const format = settings.screenshotFormat || 'png';
    const quality = format === 'jpg' ? (settings.jpgQuality || 92) : 92;

    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: format === 'jpg' ? 'jpeg' : 'png',
      quality,
    });

    return { success: true, dataUrl };
  } catch (err) {
    log.error('Capture visible failed:', err.message);
    throw new ExtensionError(err.message, ErrorCodes.CAPTURE_FAILED);
  }
}

/**
 * Initiate full-page capture.
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
 * Initiate selection capture.
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
 * Process a captured screenshot based on user settings.
 * @param {string} dataUrl - Screenshot data URL
 * @param {string} [filename] - Optional filename
 * @returns {Promise<{success: boolean}>}
 */
async function processCapture(dataUrl, filename) {
  const settings = await getCachedSettings();
  const afterCapture = settings.afterCapture || 'editor';

  if (afterCapture === 'clipboard') {
    await copyToClipboard(dataUrl);
    await showNotification('Screenshot copied!', 'Copied to clipboard');
  } else if (afterCapture === 'save') {
    await saveCapture(dataUrl, filename);
    await showNotification('Screenshot saved!', filename || 'Saved to Downloads');
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_CAPTURE]: dataUrl });
    await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  }

  return { success: true };
}

/**
 * Save a screenshot to Downloads.
 * @param {string} dataUrl - Image data URL
 * @param {string} [filename] - Optional filename
 * @param {string} [format] - Format override
 * @returns {Promise<{success: boolean, downloadId?: number}>}
 */
async function saveCapture(dataUrl, filename, format) {
  const settings = await getCachedSettings();
  const ext = format || settings.screenshotFormat || 'png';
  let name = filename || `${EXTENSION_NAME}_${getTimestamp()}.${ext}`;
  name = sanitizeFilename(name);

  const subfolder = sanitizeFilename(settings.saveSubfolder);
  if (subfolder) name = `${subfolder}/${name}`;

  try {
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename: name, saveAs: false });
    await showNotification('Screenshot saved!', name);
    return { success: true, downloadId };
  } catch (err) {
    log.error('Save failed:', err.message);
    throw new ExtensionError(err.message, ErrorCodes.CAPTURE_FAILED);
  }
}

/**
 * Copy image to clipboard via offscreen document.
 * @param {string} dataUrl - Image data URL
 * @returns {Promise<{success: boolean}>}
 */
async function copyToClipboard(dataUrl) {
  try {
    await ensureRecorderOffscreen();
    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.OFFSCREEN_COPY_CLIPBOARD,
      dataUrl,
    });
    // Don't close offscreen — it may be in use for recording
    return { success: true };
  } catch (err) {
    log.error('Clipboard copy failed:', err.message);
    throw new ExtensionError(err.message, ErrorCodes.OFFSCREEN_FAILED);
  }
}

// ── Recording Orchestration (New Inline Flow) ───────

/**
 * Handle the 'start-recording' message from the popup.
 * Orchestrates: tabCapture → offscreen document → widget injection.
 *
 * CRITICAL: This handler runs in the user gesture chain from the popup click,
 * which is required for chrome.tabCapture.getMediaStreamId().
 *
 * @param {Object} config - Recording configuration from popup
 * @param {chrome.runtime.MessageSender} sender - Message sender
 * @returns {Promise<{success: boolean, error?: string}>}
 */
/**
 * Continue start recording after streamId is obtained (for tab capture)
 * or handle screen/camera sources.
 * @param {Object} config - Config with streamId and targetTabId already set (for tab)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function continueStartRecording(config) {
  const currentState = await getRecordingState();
  if (currentState.isRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  const targetTabId = config.targetTabId;

  try {
    // Create/ensure offscreen document
    await ensureRecorderOffscreen();

    // Send config + streamId to offscreen to start recording
    const offscreenResponse = await chrome.runtime.sendMessage({
      action: 'offscreen-start-recording',
      config,
    });

    if (!offscreenResponse?.success) {
      throw new Error(offscreenResponse?.error || 'Offscreen failed to start recording');
    }

    // Update recording state
    await setRecordingState({ isRecording: true, targetTabId });
    await chrome.action.setBadgeText({ text: 'REC' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
    await startKeepalive();

    // Inject floating widget into the user's tab
    if (targetTabId) {
      await injectRecordingWidget(targetTabId);
    }

    log.info(`Recording started: source=${config.source}, tab=${targetTabId}`);
    return { success: true };

  } catch (err) {
    log.error('Start recording failed:', err.message);
    await setRecordingState({ isRecording: false, targetTabId: null });
    await chrome.action.setBadgeText({ text: '' });
    return { success: false, error: err.message };
  }
}

async function handleStartRecording(config, sender) {
  // For screen and camera sources (tab is handled in the message listener directly)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTabId = activeTab?.id;

  let streamId = null;
  if (config.source === 'screen') {
    streamId = await getDesktopCaptureStreamId(activeTab);
  }

  return continueStartRecording({ ...config, streamId, targetTabId });
}

/**
 * Get a tab capture stream ID for the given tab.
 * Must be called in user gesture chain (popup click → message → this).
 * @param {number} targetTabId - Tab to capture
 * @returns {Promise<string>} Stream ID
 */
function getTabCaptureStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!streamId) {
        reject(new Error('Failed to get tab capture stream ID'));
      } else {
        resolve(streamId);
      }
    });
  });
}

/**
 * Show the desktop capture picker and return the stream ID.
 * @param {chrome.tabs.Tab} tab - Active tab for the picker
 * @returns {Promise<string>} Stream ID
 */
function getDesktopCaptureStreamId(tab) {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab'],
      tab,
      (streamId) => {
        if (!streamId) {
          reject(new Error('User cancelled desktop capture picker'));
        } else {
          resolve(streamId);
        }
      }
    );
  });
}

/**
 * Stop the current recording.
 * @returns {Promise<{success: boolean}>}
 */
async function handleStopRecording() {
  const state = await getRecordingState();
  if (!state.isRecording) {
    return { success: false, error: 'No recording in progress' };
  }

  // Tell offscreen to stop
  try {
    await chrome.runtime.sendMessage({ action: 'offscreen-stop-recording' });
  } catch (err) {
    log.warn('Failed to send stop to offscreen:', err.message);
  }

  // Remove widget from user's tab
  if (state.targetTabId) {
    try {
      await chrome.tabs.sendMessage(state.targetTabId, {
        action: MESSAGE_TYPES.REMOVE_RECORDING_WIDGET,
      });
    } catch {
      // Tab may have been closed
    }
  }

  return { success: true };
}

/**
 * Handle recording completion — offscreen has serialized data to storage.
 * Opens the preview page.
 * @param {number} duration - Recording duration in ms
 * @param {number} size - Recording size in bytes
 * @returns {Promise<{success: boolean}>}
 */
async function onRecordingComplete(duration, size) {
  log.info(`Recording complete: ${(size / 1024 / 1024).toFixed(1)} MB, ${Math.round(duration / 1000)}s`);

  const state = await getRecordingState();

  // Remove widget from user's tab
  if (state.targetTabId) {
    try {
      await chrome.tabs.sendMessage(state.targetTabId, {
        action: MESSAGE_TYPES.REMOVE_RECORDING_WIDGET,
      });
    } catch {
      // Tab may have been closed
    }
  }

  // Clear recording state
  await setRecordingState({ isRecording: false, targetTabId: null });
  await chrome.action.setBadgeText({ text: '' });
  await stopKeepalive();

  // Close offscreen document (recording data is now in storage)
  await closeOffscreenDocument();

  // Open preview page
  await chrome.tabs.create({ url: chrome.runtime.getURL('recorder/preview.html') });

  await showNotification('Recording saved!', 'Your recording is ready');
  return { success: true };
}

/**
 * Forward a control message to the offscreen document.
 * @param {string} action - Offscreen action to forward
 * @returns {Promise<Object>}
 */
async function forwardToOffscreen(action) {
  try {
    const response = await chrome.runtime.sendMessage({ action });
    return response || { success: true };
  } catch (err) {
    log.warn('Forward to offscreen failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Inject the recording widget (shadow DOM) into a tab.
 * @param {number} tabId - Target tab ID
 * @returns {Promise<void>}
 */
async function injectRecordingWidget(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url || '')) {
      log.warn('Cannot inject widget into restricted URL');
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/recording-widget.js'],
    });
    log.debug('Recording widget injected into tab', tabId);
  } catch (err) {
    log.warn('Widget injection failed:', err.message);
  }
}

/** @returns {Promise<{success: boolean}>} */
async function onRecordingPaused() {
  await chrome.action.setBadgeText({ text: '⏸' });
  // Forward to offscreen
  await forwardToOffscreen('offscreen-toggle-pause');
  return { success: true };
}

/** @returns {Promise<{success: boolean}>} */
async function onRecordingResumed() {
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
  await forwardToOffscreen('offscreen-toggle-pause');
  return { success: true };
}

// ── Offscreen Document Management ───────────────────

/**
 * Ensure the recorder offscreen document exists.
 * This document handles both clipboard ops and recording.
 * @returns {Promise<void>}
 */
async function ensureRecorderOffscreen() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen/recorder-offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'CLIPBOARD'],
      justification: 'Recording screen/tab media via MediaRecorder and clipboard operations',
    });
    log.debug('Recorder offscreen document created');
  } catch (err) {
    log.error('Failed to create offscreen document:', err.message);
    throw new ExtensionError(err.message, ErrorCodes.OFFSCREEN_FAILED);
  }
}

/**
 * Close the offscreen document if it exists.
 * @returns {Promise<void>}
 */
async function closeOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
      log.debug('Offscreen document closed');
    }
  } catch (err) {
    log.debug('Offscreen close skipped:', err.message);
  }
}

// ── Notifications ───────────────────────────────────

/**
 * Show a chrome notification if enabled and permitted.
 * @param {string} title - Notification title
 * @param {string} [message=''] - Notification body
 * @returns {Promise<void>}
 */
async function showNotification(title, message) {
  try {
    const settings = await getCachedSettings();
    if (settings.notifications === 'off') return;

    if (!hasNotificationsSupport()) return;
    const granted = await hasPermission('notifications');
    if (!granted) return;

    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
      title: `${EXTENSION_NAME} — ${title}`,
      message: message || '',
      silent: false,
    });
  } catch (err) {
    log.warn('Notification failed:', err.message);
  }
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
    chrome.notifications.clear(notificationId);
  });
}

// ── History ─────────────────────────────────────────

/**
 * Add a new entry to capture history.
 * @param {Object} entry - History entry
 * @returns {Promise<{success: boolean}>}
 */
async function addHistoryEntry(entry) {
  try {
    const settings = await getCachedSettings();
    if (settings.keepHistory === 'off') return { success: true };

    const maxHistory = settings.maxHistory || 100;
    const result = await chrome.storage.local.get(STORAGE_KEYS.HISTORY_ENTRIES);
    const entries = result[STORAGE_KEYS.HISTORY_ENTRIES] || [];

    entries.unshift(entry);
    while (entries.length > maxHistory) entries.pop();

    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY_ENTRIES]: entries });
    return { success: true };
  } catch (err) {
    log.error('Failed to add history entry:', err.message);
    throw new ExtensionError(err.message, ErrorCodes.STORAGE_FULL);
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
    log.warn(`Failed to send to tab ${tabId}:`, err.message);
    return null;
  }
}

// ── Tab Removal Cleanup ─────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const state = await getRecordingState();
    if (state.isRecording && state.targetTabId === tabId) {
      log.warn('Target tab closed during recording — stopping');
      await handleStopRecording();
    }
  } catch (err) {
    log.warn('Tab removal cleanup error:', err.message);
  }
});

// ── Service Worker Lifecycle ────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  log.info('Service worker startup — recovering state');
  const state = await getRecordingState();
  if (state.isRecording) {
    log.warn('Found stale recording state on startup — cleaning up');
    await setRecordingState({ isRecording: false, targetTabId: null });
    await chrome.action.setBadgeText({ text: '' });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  log.info('Service worker suspending');
});

// ── Keepalive ───────────────────────────────────────

const KEEPALIVE_ALARM_NAME = 'screenbolt-keepalive';

/**
 * Start keepalive alarm during recording.
 */
async function startKeepalive() {
  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
  log.debug('Keepalive alarm started');
}

/**
 * Stop keepalive alarm.
 */
async function stopKeepalive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  log.debug('Keepalive alarm stopped');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    const state = await getRecordingState();
    if (!state.isRecording) {
      await stopKeepalive();
    }
  }
});

log.info(`Service worker initialized (v${chrome.runtime.getManifest().version})`);
