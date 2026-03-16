/**
 * ScreenSnap — Background Service Worker (MV3)
 * Handles capture commands, keyboard shortcuts, recording coordination, and message routing.
 */

// ── Recording State ─────────────────────────────────
let isRecording = false;
let recorderTabId = null; // Tab ID of recorder.html
let recordingTargetTabId = null; // Tab being recorded (for widget injection)

// ── Keyboard Shortcuts ──────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getCurrentTab();
  if (!tab) return;

  switch (command) {
    case 'capture-visible':
      await captureVisibleArea(tab);
      break;
    case 'capture-full':
      await sendToContent(tab.id, { action: 'capture-full-page' });
      break;
    case 'capture-selection':
      await sendToContent(tab.id, { action: 'start-selection' });
      break;
  }
});

// ── Message Router ──────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

async function handleMessage(message, sender) {
  switch (message.action) {
    // ── Screenshot Actions ──────────────────────────
    case 'capture-visible':
      return await captureVisibleArea();

    case 'capture-full-page':
      return await initiateFullPageCapture(sender.tab?.id);

    case 'capture-selection':
      return await initiateSelectionCapture(sender.tab?.id);

    case 'full-page-data':
      return await processCapture(message.dataUrl, message.filename);

    case 'selection-data':
      return await processCapture(message.dataUrl, message.filename);

    case 'save-capture':
      return await saveCapture(message.dataUrl, message.filename, message.format);

    case 'copy-to-clipboard':
      return await copyToClipboard(message.dataUrl);

    // ── Recording Actions ───────────────────────────
    case 'request-desktop-capture':
      return await requestDesktopCapture(sender);

    case 'recording-started':
      return await onRecordingStarted(sender);

    case 'recording-paused':
      return await onRecordingPaused();

    case 'recording-resumed':
      return await onRecordingResumed();

    case 'recording-stopped':
      return await onRecordingStopped();

    // Widget commands (from content script widget → service worker → recorder tab)
    case 'widget-pause':
    case 'widget-resume':
      return await forwardToRecorder(message.action === 'widget-pause' ? 'toggle-pause' : 'toggle-pause');

    case 'widget-mute':
      return await forwardToRecorder('toggle-mute');

    case 'widget-stop':
      return await forwardToRecorder('stop-recording');

    default:
      console.warn('[ScreenSnap] Unknown action:', message.action);
      return { success: false, error: 'Unknown action' };
  }
}

// ── Screenshot Functions ────────────────────────────

async function captureVisibleArea(tab) {
  try {
    const settings = await getSettings();
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: settings.format || 'png',
      quality: settings.quality || 92,
    });
    return { success: true, dataUrl };
  } catch (error) {
    console.error('[ScreenSnap] Capture visible failed:', error);
    return { success: false, error: error.message };
  }
}

async function initiateFullPageCapture(tabId) {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };
  await sendToContent(tab.id, { action: 'capture-full-page' });
  return { success: true };
}

async function initiateSelectionCapture(tabId) {
  const tab = tabId ? { id: tabId } : await getCurrentTab();
  if (!tab?.id) return { success: false, error: 'No active tab' };
  await sendToContent(tab.id, { action: 'start-selection' });
  return { success: true };
}

async function processCapture(dataUrl, filename) {
  const settings = await getSettings();
  if (settings.openEditor !== false) {
    const editorUrl = chrome.runtime.getURL('editor/editor.html');
    await chrome.storage.local.set({ pendingCapture: dataUrl });
    await chrome.tabs.create({ url: editorUrl });
  } else {
    await saveCapture(dataUrl, filename);
  }
  return { success: true };
}

async function saveCapture(dataUrl, filename, format) {
  const settings = await getSettings();
  const ext = format || settings.format || 'png';
  const name = filename || `ScreenSnap_${getTimestamp()}.${ext}`;
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: name,
      saveAs: settings.askSaveLocation || false,
    });
    return { success: true, downloadId };
  } catch (error) {
    console.error('[ScreenSnap] Save failed:', error);
    return { success: false, error: error.message };
  }
}

async function copyToClipboard(dataUrl) {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      action: 'offscreen-copy-clipboard',
      dataUrl,
    });
    return { success: true };
  } catch (error) {
    console.error('[ScreenSnap] Clipboard copy failed:', error);
    return { success: false, error: error.message };
  }
}

// ── Recording Functions ─────────────────────────────

/**
 * Handle desktopCapture request from recorder.html.
 * Must be called from the service worker since desktopCapture API is only available here.
 */
async function requestDesktopCapture(sender) {
  return new Promise((resolve) => {
    // Get the tab that opened recorder.html (sender tab)
    const senderTab = sender.tab;

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

/** Called when recording starts — set badge and inject widget */
async function onRecordingStarted(sender) {
  isRecording = true;
  recorderTabId = sender.tab?.id;

  // Set red badge
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });

  // Find the tab that was active before recorder opened and inject widget
  // (for tab/screen recording, inject into the previously active tab)
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const tab of tabs) {
      if (tab.id !== recorderTabId && tab.url && !tab.url.startsWith('chrome://')) {
        recordingTargetTabId = tab.id;
        await injectRecordingWidget(tab.id);
        break;
      }
    }
  } catch (err) {
    console.warn('[ScreenSnap] Could not inject recording widget:', err);
  }

  return { success: true };
}

/** Inject the floating recording controls widget into a tab */
async function injectRecordingWidget(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recorder/recording-controls.js']
    });
  } catch (err) {
    console.warn('[ScreenSnap] Widget injection failed:', err);
  }
}

async function onRecordingPaused() {
  await chrome.action.setBadgeText({ text: '⏸' });
  return { success: true };
}

async function onRecordingResumed() {
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  return { success: true };
}

async function onRecordingStopped() {
  isRecording = false;
  await chrome.action.setBadgeText({ text: '' });

  // Remove widget from target tab
  if (recordingTargetTabId) {
    try {
      await chrome.tabs.sendMessage(recordingTargetTabId, { action: 'remove-recording-widget' });
    } catch (err) {
      // Tab may have been closed
    }
    recordingTargetTabId = null;
  }

  recorderTabId = null;
  return { success: true };
}

/** Forward a command from the widget to the recorder tab */
async function forwardToRecorder(action) {
  if (!recorderTabId) return { success: false, error: 'No recorder tab' };
  try {
    const response = await chrome.tabs.sendMessage(recorderTabId, { action });
    return response || { success: true };
  } catch (err) {
    console.warn('[ScreenSnap] Forward to recorder failed:', err);
    return { success: false, error: err.message };
  }
}

// ── Helpers ─────────────────────────────────────────

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return result.settings || {};
}

function getTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copy screenshot to clipboard',
  });
}
