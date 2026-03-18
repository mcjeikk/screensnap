/**
 * ScreenBolt -- Background Service Worker v0.7.0 (MV3 ES Module)
 *
 * Central coordinator for the extension. Handles capture commands,
 * keyboard shortcuts, inline recording orchestration (popup -> offscreen -> widget),
 * notifications, onInstalled events, and history management.
 *
 * Recording flow (v0.7.0):
 * 1. Popup sends 'start-recording' with config
 * 2. SW gets tabCapture streamId (user gesture chain from popup click)
 * 3. SW creates offscreen document and passes streamId + config
 * 4. Offscreen runs MediaRecorder, SW injects floating widget into user's tab
 * 5. Widget controls -> SW -> offscreen (pause/mute/stop)
 * 6. On stop: offscreen serializes to storage, SW opens preview page
 *
 * NOTE: Service workers can terminate after 30s of inactivity.
 * State is persisted via chrome.storage, not global variables.
 */

// -- ES Module Imports -------------------------------------------
import {
  MESSAGE_TYPES,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  BADGE_RECORDING_COLOR,
  EXTENSION_NAME,
} from '../utils/constants.js';

import type { Settings, RecordingConfig, HistoryEntry } from '../utils/types.js';

import { createLogger } from '../utils/logger.js';
import { getTimestamp, sanitizeFilename } from '../utils/helpers.js';
import { getSettings } from '../utils/storage.js';
import { ExtensionError, ErrorCodes } from '../utils/errors.js';
import { hasNotificationsSupport, hasPermission } from '../utils/feature-detection.js';
import { runMigrations } from '../utils/migration.js';

// -- Logger ------------------------------------------------------
const log = createLogger('SW');

// -- Types -------------------------------------------------------

/** Recording state persisted in session storage. */
interface RecordingState {
  isRecording: boolean;
  targetTabId: number | null;
}

/** Standard response shape returned by most handlers. */
interface HandlerResponse {
  success: boolean;
  error?: string;
  dataUrl?: string;
  downloadId?: number;
  isRecording?: boolean;
}

/** Internal recording config with stream/tab info attached by the SW. */
interface InternalRecordingConfig extends RecordingConfig {
  streamId?: string;
  targetTabId?: number;
}

/** Shape of messages flowing through the runtime message system. */
interface ExtensionMessage {
  action: string;
  config?: InternalRecordingConfig;
  dataUrl?: string;
  filename?: string;
  format?: string;
  entry?: HistoryEntry;
  duration?: number;
  size?: number;
  pip?: boolean;
  pipPosition?: string;
  pipSize?: string;
  [key: string]: unknown;
}

/** Handler function signature for the message router. */
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
) => HandlerResponse | Promise<HandlerResponse>;

// -- Init Promise ------------------------------------------------

let settingsCache: Settings = { ...DEFAULT_SETTINGS };

/** Initialization promise -- loads settings into cache before any handler runs. */
const initPromise: Promise<void> = chrome.storage.sync
  .get(STORAGE_KEYS.SETTINGS)
  .then((result) => {
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...((result[STORAGE_KEYS.SETTINGS] as Partial<Settings>) || {}),
    };
    log.debug('Settings cache initialized');
  })
  .catch((err: Error) => {
    log.warn('Failed to load settings cache, using defaults:', err.message);
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEYS.SETTINGS]) {
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...((changes[STORAGE_KEYS.SETTINGS].newValue as Partial<Settings>) || {}),
    };
    log.debug('Settings cache updated');
  }
});

/** Get cached settings. */
async function getCachedSettings(): Promise<Settings> {
  await initPromise;
  return settingsCache;
}

// -- Recording State (session storage) ---------------------------

/** Get recording state from session storage. */
async function getRecordingState(): Promise<RecordingState> {
  try {
    const result = await chrome.storage.session.get('recordingState');
    return (result.recordingState as RecordingState) || { isRecording: false, targetTabId: null };
  } catch {
    return { isRecording: false, targetTabId: null };
  }
}

/** Update recording state in session storage. */
async function setRecordingState(updates: Partial<RecordingState>): Promise<void> {
  const current = await getRecordingState();
  await chrome.storage.session.set({ recordingState: { ...current, ...updates } });
}

// -- onInstalled -------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details: chrome.runtime.InstalledDetails) => {
  await initPromise;

  if (details.reason === 'install') {
    log.info('Extension installed -- initializing');

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

// -- Keyboard Shortcuts ------------------------------------------

chrome.commands.onCommand.addListener(async (command: string) => {
  await initPromise;

  const tab = await getCurrentTab();
  if (!tab) {
    log.warn('No active tab for command:', command);
    return;
  }

  switch (command) {
    case 'capture-visible':
      await captureVisibleArea();
      break;
    case 'capture-full':
      await ensureContentScript(tab.id!);
      await sendToContent(tab.id!, { action: MESSAGE_TYPES.CAPTURE_FULL_PAGE });
      break;
    case 'capture-selection':
      await ensureContentScript(tab.id!);
      await sendToContent(tab.id!, { action: MESSAGE_TYPES.START_SELECTION });
      break;
    default:
      log.warn('Unknown command:', command);
  }
});

// -- Message Router ----------------------------------------------

const messageHandlers = new Map<string, MessageHandler>();

/** Register a message handler. */
function registerHandler(action: string, handler: MessageHandler): void {
  messageHandlers.set(action, handler);
}

// Screenshot handlers
registerHandler(MESSAGE_TYPES.CAPTURE_VISIBLE, () => captureVisibleArea());
registerHandler(MESSAGE_TYPES.CAPTURE_FULL_PAGE, (_msg, sender) =>
  initiateFullPageCapture(sender.tab?.id),
);
registerHandler(MESSAGE_TYPES.CAPTURE_SELECTION, (_msg, sender) =>
  initiateSelectionCapture(sender.tab?.id),
);
registerHandler(MESSAGE_TYPES.FULL_PAGE_DATA, (msg) =>
  processCapture(msg.dataUrl!, msg.filename),
);
registerHandler(MESSAGE_TYPES.SELECTION_DATA, (msg) =>
  processCapture(msg.dataUrl!, msg.filename),
);
registerHandler(MESSAGE_TYPES.SAVE_CAPTURE, (msg) =>
  saveCapture(msg.dataUrl!, msg.filename, msg.format),
);
registerHandler(MESSAGE_TYPES.COPY_TO_CLIPBOARD, (msg) => copyToClipboard(msg.dataUrl!));

// Recording handlers (new inline flow)
registerHandler('start-recording', (msg, sender) =>
  handleStartRecording(msg.config as InternalRecordingConfig, sender),
);
registerHandler(MESSAGE_TYPES.GET_RECORDING_STATUS, async () => {
  const state = await getRecordingState();
  return { success: true, isRecording: state.isRecording };
});

// Widget control forwarding -> offscreen
registerHandler(MESSAGE_TYPES.WIDGET_PAUSE, () => forwardToOffscreen('offscreen-toggle-pause'));
registerHandler(MESSAGE_TYPES.WIDGET_RESUME, () => forwardToOffscreen('offscreen-toggle-pause'));
registerHandler(MESSAGE_TYPES.WIDGET_MUTE, () => forwardToOffscreen('offscreen-toggle-mute'));
registerHandler(MESSAGE_TYPES.WIDGET_STOP, () => handleStopRecording());

// Timer request from widget
registerHandler('get-recording-time', () => forwardToOffscreen('offscreen-get-time'));

// Recording data is now stored directly in IndexedDB by the offscreen document.
// No chunk relay needed -- offscreen and preview share the same IDB origin.

// Offscreen recording complete
registerHandler('offscreen-recording-complete', (msg) =>
  onRecordingComplete(msg.duration!, msg.size!),
);

// History
registerHandler(MESSAGE_TYPES.ADD_HISTORY_ENTRY, (msg) => addHistoryEntry(msg.entry!));

// Recording state notifications (badge updates)
registerHandler(MESSAGE_TYPES.RECORDING_PAUSED, () => onRecordingPaused());
registerHandler(MESSAGE_TYPES.RECORDING_RESUMED, () => onRecordingResumed());

// Misc
registerHandler(MESSAGE_TYPES.NOTIFICATION_CLICK, () => ({ success: true }));

// Main message listener
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: HandlerResponse) => void,
  ): boolean => {
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
    // chain -- before initPromise.then() which breaks the gesture chain.
    if (message.action === 'start-recording' && message.config?.source === 'tab') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const targetTabId = tabs[0]?.id;
        if (!targetTabId) {
          sendResponse({ success: false, error: 'No active tab found' });
          return;
        }
        // Call getMediaStreamId SYNCHRONOUSLY in the user gesture callback chain
        chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
          if (chrome.runtime.lastError || !streamId) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError?.message || 'Failed to get stream ID',
            });
            return;
          }
          // Now continue async with the streamId already obtained
          const configWithStream: InternalRecordingConfig = {
            ...(message.config as RecordingConfig),
            streamId,
            targetTabId,
          };
          initPromise
            .then(() => continueStartRecording(configWithStream))
            .then((result) => sendResponse(result))
            .catch((err: Error) => {
              log.error('Start recording failed:', err.message);
              sendResponse({ success: false, error: err.message });
            });
        });
      });
      return true; // Keep channel open
    }

    initPromise
      .then(() => handler(message, sender))
      .then((result) => sendResponse(result))
      .catch((err: unknown) => {
        const errorMsg =
          err instanceof ExtensionError
            ? `[${err.code}] ${err.message}`
            : (err as Error).message;
        log.error(`Handler "${message.action}" threw:`, errorMsg);
        sendResponse({ success: false, error: (err as Error).message });
      });

    return true;
  },
);

// -- Content Script Injection ------------------------------------

/** Dynamically inject the content script and CSS into a tab. */
async function ensureContentScript(tabId: number): Promise<boolean> {
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
    log.warn('Content script injection failed:', (err as Error).message);
    return false;
  }
}

/** Check if a URL is restricted (cannot inject scripts). */
function isRestrictedUrl(url: string): boolean {
  return (
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://')
  );
}

// -- Screenshot Functions ----------------------------------------

/** Capture the visible area of the active tab. */
async function captureVisibleArea(): Promise<HandlerResponse> {
  try {
    const settings = await getCachedSettings();
    const format = settings.screenshotFormat || 'png';
    const quality = format === 'jpg' ? settings.jpgQuality || 92 : 92;

    // captureVisibleTab accepts null for "current window" but Chrome types
    // expect a number; cast to satisfy the type checker at the call site.
    const dataUrl = await chrome.tabs.captureVisibleTab(null as unknown as number, {
      format: format === 'jpg' ? 'jpeg' : 'png',
      quality,
    });

    return { success: true, dataUrl };
  } catch (err) {
    log.error('Capture visible failed:', (err as Error).message);
    throw new ExtensionError((err as Error).message, ErrorCodes.CAPTURE_FAILED);
  }
}

/** Initiate full-page capture. */
async function initiateFullPageCapture(tabId?: number): Promise<HandlerResponse> {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };

  const injected = await ensureContentScript(tab.id);
  if (!injected) return { success: false, error: 'Cannot capture this page (restricted URL)' };

  await sendToContent(tab.id, { action: MESSAGE_TYPES.CAPTURE_FULL_PAGE });
  return { success: true };
}

/** Initiate selection capture. */
async function initiateSelectionCapture(tabId?: number): Promise<HandlerResponse> {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };

  const injected = await ensureContentScript(tab.id);
  if (!injected) return { success: false, error: 'Cannot capture this page (restricted URL)' };

  await sendToContent(tab.id, { action: MESSAGE_TYPES.START_SELECTION });
  return { success: true };
}

/** Process a captured screenshot based on user settings. */
async function processCapture(
  dataUrl: string,
  filename?: string,
): Promise<HandlerResponse> {
  const settings = await getCachedSettings();
  const afterCapture: string = settings.afterCapture || 'editor';

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

/** Save a screenshot to Downloads. */
async function saveCapture(
  dataUrl: string,
  filename?: string,
  format?: string,
): Promise<HandlerResponse> {
  const settings = await getCachedSettings();
  const ext = format || settings.screenshotFormat || 'png';
  let name = filename || `${EXTENSION_NAME}_${getTimestamp()}.${ext}`;
  name = sanitizeFilename(name);

  const subfolder = sanitizeFilename(settings.saveSubfolder);
  if (subfolder) name = `${subfolder}/${name}`;

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: name,
      saveAs: false,
    });
    await showNotification('Screenshot saved!', name);
    return { success: true, downloadId };
  } catch (err) {
    log.error('Save failed:', (err as Error).message);
    throw new ExtensionError((err as Error).message, ErrorCodes.CAPTURE_FAILED);
  }
}

/** Copy image to clipboard via offscreen document. */
async function copyToClipboard(dataUrl: string): Promise<HandlerResponse> {
  try {
    await ensureRecorderOffscreen();
    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.OFFSCREEN_COPY_CLIPBOARD,
      dataUrl,
    });
    // Don't close offscreen -- it may be in use for recording
    return { success: true };
  } catch (err) {
    log.error('Clipboard copy failed:', (err as Error).message);
    throw new ExtensionError((err as Error).message, ErrorCodes.OFFSCREEN_FAILED);
  }
}

// -- Recording Orchestration (New Inline Flow) -------------------

/**
 * Continue start recording after streamId is obtained (for tab capture)
 * or handle screen/camera sources.
 */
async function continueStartRecording(
  config: InternalRecordingConfig,
): Promise<HandlerResponse> {
  const currentState = await getRecordingState();
  if (currentState.isRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  const targetTabId = config.targetTabId;

  try {
    // Create/ensure offscreen document
    await ensureRecorderOffscreen();

    // Send config + streamId to offscreen to start recording
    const offscreenResponse = (await chrome.runtime.sendMessage({
      action: 'offscreen-start-recording',
      config,
    })) as HandlerResponse | undefined;

    if (!offscreenResponse?.success) {
      throw new Error(offscreenResponse?.error || 'Offscreen failed to start recording');
    }

    // Update recording state
    await setRecordingState({ isRecording: true, targetTabId: targetTabId ?? null });
    await chrome.action.setBadgeText({ text: 'REC' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
    await startKeepalive();

    // Inject floating widget into the user's tab
    if (targetTabId) {
      await injectRecordingWidget(targetTabId);

      // If PiP webcam is enabled, tell the content script to show the bubble
      if (config.pip) {
        try {
          await chrome.tabs.sendMessage(targetTabId, {
            action: 'setup-webcam-pip',
            config: {
              pip: true,
              pipPosition: config.pipPosition,
              pipSize: config.pipSize,
            },
          });
        } catch (err) {
          log.warn('Failed to setup webcam PiP on page:', (err as Error).message);
        }
      }
    }

    log.info(`Recording started: source=${config.source}, tab=${targetTabId}`);
    return { success: true };
  } catch (err) {
    log.error('Start recording failed:', (err as Error).message);
    await setRecordingState({ isRecording: false, targetTabId: null });
    await chrome.action.setBadgeText({ text: '' });
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Handle the 'start-recording' message from the popup.
 * For screen and camera sources (tab is handled in the message listener directly).
 */
async function handleStartRecording(
  config: InternalRecordingConfig,
  _sender: chrome.runtime.MessageSender,
): Promise<HandlerResponse> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTabId = activeTab?.id;

  let streamId: string | undefined;
  if (config.source === 'screen') {
    streamId = await getDesktopCaptureStreamId(activeTab!);
  }

  return continueStartRecording({ ...config, streamId, targetTabId });
}

/**
 * Get a tab capture stream ID for the given tab.
 * Must be called in user gesture chain (popup click -> message -> this).
 */
function getTabCaptureStreamId(targetTabId: number): Promise<string> {
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

/** Show the desktop capture picker and return the stream ID. */
function getDesktopCaptureStreamId(tab: chrome.tabs.Tab): Promise<string> {
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
      },
    );
  });
}

/** Stop the current recording. */
async function handleStopRecording(): Promise<HandlerResponse> {
  const state = await getRecordingState();
  if (!state.isRecording) {
    return { success: false, error: 'No recording in progress' };
  }

  // Tell offscreen to stop
  try {
    await chrome.runtime.sendMessage({ action: 'offscreen-stop-recording' });
  } catch (err) {
    log.warn('Failed to send stop to offscreen:', (err as Error).message);
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
 * Handle recording completion -- offscreen has serialized data to storage.
 * Opens the preview page.
 */
async function onRecordingComplete(
  duration: number,
  size: number,
): Promise<HandlerResponse> {
  log.info(
    `Recording complete: ${(size / 1024 / 1024).toFixed(1)} MB, ${Math.round(duration / 1000)}s`,
  );

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

/** Forward a control message to the offscreen document. */
async function forwardToOffscreen(action: string): Promise<HandlerResponse> {
  try {
    const response = (await chrome.runtime.sendMessage({ action })) as
      | HandlerResponse
      | undefined;
    return response || { success: true };
  } catch (err) {
    log.warn('Forward to offscreen failed:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** Inject the recording widget (shadow DOM) into a tab. */
async function injectRecordingWidget(tabId: number): Promise<void> {
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
    log.warn('Widget injection failed:', (err as Error).message);
  }
}

async function onRecordingPaused(): Promise<HandlerResponse> {
  await chrome.action.setBadgeText({ text: '\u23F8' });
  // Forward to offscreen
  await forwardToOffscreen('offscreen-toggle-pause');
  return { success: true };
}

async function onRecordingResumed(): Promise<HandlerResponse> {
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
  await forwardToOffscreen('offscreen-toggle-pause');
  return { success: true };
}

// -- Offscreen Document Management -------------------------------

/**
 * Ensure the recorder offscreen document exists.
 * This document handles both clipboard ops and recording.
 */
async function ensureRecorderOffscreen(): Promise<void> {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existingContexts.length > 0) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen/recorder-offscreen.html',
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.AUDIO_PLAYBACK,
        chrome.offscreen.Reason.CLIPBOARD,
      ],
      justification: 'Recording screen/tab media via MediaRecorder and clipboard operations',
    });
    log.debug('Recorder offscreen document created');
  } catch (err) {
    log.error('Failed to create offscreen document:', (err as Error).message);
    throw new ExtensionError((err as Error).message, ErrorCodes.OFFSCREEN_FAILED);
  }
}

/** Close the offscreen document if it exists. */
async function closeOffscreenDocument(): Promise<void> {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
      log.debug('Offscreen document closed');
    }
  } catch (err) {
    log.debug('Offscreen close skipped:', (err as Error).message);
  }
}

// -- Notifications -----------------------------------------------

/** Show a chrome notification if enabled and permitted. */
async function showNotification(title: string, message: string = ''): Promise<void> {
  try {
    const settings = await getCachedSettings();
    if (settings.notifications === 'off') return;

    if (!hasNotificationsSupport()) return;
    const granted = await hasPermission('notifications');
    if (!granted) return;

    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
      title: `${EXTENSION_NAME} -- ${title}`,
      message: message || '',
      silent: false,
    });
  } catch (err) {
    log.warn('Notification failed:', (err as Error).message);
  }
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId: string) => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
    chrome.notifications.clear(notificationId);
  });
}

// -- History -----------------------------------------------------

/** Add a new entry to capture history. */
async function addHistoryEntry(entry: HistoryEntry): Promise<HandlerResponse> {
  try {
    const settings = await getCachedSettings();
    if (settings.keepHistory === 'off') return { success: true };

    const maxHistory = settings.maxHistory || 100;
    const result = await chrome.storage.local.get(STORAGE_KEYS.HISTORY_ENTRIES);
    const entries: HistoryEntry[] =
      (result[STORAGE_KEYS.HISTORY_ENTRIES] as HistoryEntry[] | undefined) || [];

    entries.unshift(entry);
    while (entries.length > maxHistory) entries.pop();

    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY_ENTRIES]: entries });
    return { success: true };
  } catch (err) {
    log.error('Failed to add history entry:', (err as Error).message);
    throw new ExtensionError((err as Error).message, ErrorCodes.STORAGE_FULL);
  }
}

// -- Helpers -----------------------------------------------------

/** Get the active tab in the current window. */
async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Send a message to a content script in a specific tab. */
async function sendToContent(
  tabId: number,
  message: { action: string; [key: string]: unknown },
): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    log.warn(`Failed to send to tab ${tabId}:`, (err as Error).message);
    return null;
  }
}

// -- Tab Removal Cleanup -----------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId: number) => {
  try {
    const state = await getRecordingState();
    if (state.isRecording && state.targetTabId === tabId) {
      log.warn('Target tab closed during recording -- stopping');
      await handleStopRecording();
    }
  } catch (err) {
    log.warn('Tab removal cleanup error:', (err as Error).message);
  }
});

// -- Service Worker Lifecycle ------------------------------------

chrome.runtime.onStartup.addListener(async () => {
  log.info('Service worker startup -- recovering state');
  const state = await getRecordingState();
  if (state.isRecording) {
    log.warn('Found stale recording state on startup -- cleaning up');
    await setRecordingState({ isRecording: false, targetTabId: null });
    await chrome.action.setBadgeText({ text: '' });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  log.info('Service worker suspending');
});

// -- Keepalive ---------------------------------------------------

const KEEPALIVE_ALARM_NAME = 'screenbolt-keepalive';

/** Start keepalive alarm during recording. */
async function startKeepalive(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
  log.debug('Keepalive alarm started');
}

/** Stop keepalive alarm. */
async function stopKeepalive(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  log.debug('Keepalive alarm stopped');
}

chrome.alarms.onAlarm.addListener(async (alarm: chrome.alarms.Alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    const state = await getRecordingState();
    if (!state.isRecording) {
      await stopKeepalive();
    }
  }
});

log.info(`Service worker initialized (v${chrome.runtime.getManifest().version})`);
