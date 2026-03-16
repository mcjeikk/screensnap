/**
 * ScreenSnap — Popup Script
 * Handles button clicks and communicates with the background service worker.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Screenshot buttons
  document.getElementById('btn-visible').addEventListener('click', () => {
    captureAction('capture-visible');
  });

  document.getElementById('btn-full').addEventListener('click', () => {
    captureAction('capture-full-page');
  });

  document.getElementById('btn-selection').addEventListener('click', () => {
    captureAction('capture-selection');
  });

  // Record buttons — open recorder page with source pre-selected
  document.getElementById('btn-record-tab').addEventListener('click', () => {
    openRecorder('tab');
  });

  document.getElementById('btn-record-screen').addEventListener('click', () => {
    openRecorder('screen');
  });

  document.getElementById('btn-record-cam').addEventListener('click', () => {
    openRecorder('camera');
  });

  // Footer buttons
  document.getElementById('btn-history').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/history.html') });
    window.close();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/settings.html') });
    window.close();
  });
});

/**
 * Open the recorder configuration page with the given source.
 */
function openRecorder(source) {
  const url = chrome.runtime.getURL(`recorder/recorder.html?source=${source}`);
  chrome.tabs.create({ url });
  window.close();
}

/**
 * Send capture action to background and handle response.
 */
async function captureAction(action) {
  try {
    if (action === 'capture-selection' || action === 'capture-full-page') {
      await chrome.runtime.sendMessage({ action });
      window.close();
      return;
    }

    const response = await chrome.runtime.sendMessage({ action });

    if (response?.success && response.dataUrl) {
      await chrome.storage.local.set({ pendingCapture: response.dataUrl });
      await chrome.tabs.create({
        url: chrome.runtime.getURL('editor/editor.html'),
      });
      window.close();
    } else {
      showError(response?.error || 'Capture failed');
    }
  } catch (error) {
    showError(error.message);
  }
}

/**
 * Show error feedback in the popup.
 */
function showError(message) {
  const container = document.querySelector('.container');
  const errorEl = document.createElement('div');
  errorEl.className = 'error-toast';
  errorEl.textContent = `⚠️ ${message}`;
  errorEl.style.cssText = `
    position: fixed;
    bottom: 8px;
    left: 8px;
    right: 8px;
    padding: 8px 12px;
    background: #FEE2E2;
    color: #DC2626;
    border-radius: 6px;
    font-size: 12px;
    text-align: center;
  `;
  container.appendChild(errorEl);
  setTimeout(() => errorEl.remove(), 3000);
}
