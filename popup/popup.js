/**
 * @file ScreenSnap — Popup Script v0.5.0
 * @description Handles button clicks, recording indicator, last capture preview,
 * and settings integration for the extension popup.
 * @version 0.5.0
 */

(() => {
  'use strict';

  // ── Constants ───────────────────────────────────
  const TOAST_DURATION_MS = 3000;
  const LOG_PREFIX = '[ScreenSnap][Popup]';

  // ── Init ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    bindScreenshotButtons();
    bindRecordButtons();
    bindFooterButtons();
    await checkRecordingStatus();
    await showLastCapture();
  });

  // ── Button Bindings ─────────────────────────────

  /**
   * Bind screenshot capture buttons to their respective actions.
   */
  function bindScreenshotButtons() {
    document.getElementById('btn-visible').addEventListener('click', () => captureAction('capture-visible'));
    document.getElementById('btn-full').addEventListener('click', () => captureAction('capture-full-page'));
    document.getElementById('btn-selection').addEventListener('click', () => captureAction('capture-selection'));
  }

  /**
   * Bind recording buttons to open the recorder page.
   */
  function bindRecordButtons() {
    document.getElementById('btn-record-tab').addEventListener('click', () => openRecorder('tab'));
    document.getElementById('btn-record-screen').addEventListener('click', () => openRecorder('screen'));
    document.getElementById('btn-record-cam').addEventListener('click', () => openRecorder('camera'));
  }

  /**
   * Bind footer navigation buttons.
   */
  function bindFooterButtons() {
    document.getElementById('btn-history').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
      window.close();
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
      window.close();
    });
  }

  // ── Actions ─────────────────────────────────────

  /**
   * Open the recorder configuration page with a pre-selected source.
   * @param {string} source - Recording source ('tab' | 'screen' | 'camera')
   */
  function openRecorder(source) {
    const url = chrome.runtime.getURL(`recorder/recorder.html?source=${encodeURIComponent(source)}`);
    chrome.tabs.create({ url });
    window.close();
  }

  /**
   * Execute a capture action and handle the response based on settings.
   * @param {string} action - The capture action type
   */
  async function captureAction(action) {
    try {
      // Selection and full-page are handled by the content script
      if (action === 'capture-selection' || action === 'capture-full-page') {
        await chrome.runtime.sendMessage({ action });
        window.close();
        return;
      }

      const response = await chrome.runtime.sendMessage({ action });

      if (!response?.success || !response.dataUrl) {
        showError(response?.error || 'Capture failed');
        return;
      }

      const settings = await getSettings();
      const afterCapture = settings.afterCapture || 'editor';

      if (afterCapture === 'clipboard') {
        await chrome.runtime.sendMessage({ action: 'copy-to-clipboard', dataUrl: response.dataUrl });
        window.close();
      } else if (afterCapture === 'save') {
        await chrome.runtime.sendMessage({
          action: 'save-capture',
          dataUrl: response.dataUrl,
          format: settings.screenshotFormat || 'png',
        });
        window.close();
      } else {
        // Open in editor (default)
        await chrome.storage.local.set({ pendingCapture: response.dataUrl });
        await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
        window.close();
      }
    } catch (err) {
      console.error(LOG_PREFIX, 'Capture action failed:', err);
      showError(err.message);
    }
  }

  // ── Recording Status ────────────────────────────

  /**
   * Check if a recording is active and show the indicator.
   */
  async function checkRecordingStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-recording-status' });
      if (response?.isRecording) {
        document.getElementById('recording-indicator').style.display = 'flex';
      }
    } catch {
      // Service worker may not be ready — safe to ignore
    }
  }

  // ── Last Capture Preview ────────────────────────

  /**
   * Display the most recent capture in the popup for quick access.
   */
  async function showLastCapture() {
    try {
      const result = await chrome.storage.local.get('historyEntries');
      const entries = result.historyEntries || [];
      if (entries.length === 0) return;

      // Get most recent entry with a thumbnail
      const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
      const last = sorted.find(e => e.thumbnail);
      if (!last) return;

      const container = document.getElementById('last-capture');
      const thumb = document.getElementById('last-capture-thumb');
      const nameEl = document.getElementById('last-capture-name');

      thumb.src = last.thumbnail;
      thumb.alt = `Preview of ${last.name}`;
      nameEl.textContent = last.name;
      container.style.display = 'flex';

      document.getElementById('btn-open-last').addEventListener('click', () => {
        if (last.type === 'screenshot' && last.dataUrl) {
          chrome.storage.local.set({ pendingCapture: last.dataUrl }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
            window.close();
          });
        } else {
          chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
          window.close();
        }
      });
    } catch {
      // Silently ignore — non-critical feature
    }
  }

  // ── Settings ────────────────────────────────────

  /**
   * Load extension settings from chrome.storage.sync.
   * @returns {Promise<Object>} Settings object
   */
  async function getSettings() {
    try {
      const result = await chrome.storage.sync.get('settings');
      return result.settings || {};
    } catch {
      return {};
    }
  }

  // ── Error Feedback ──────────────────────────────

  /**
   * Show a temporary error toast in the popup.
   * @param {string} message - Error message to display
   */
  function showError(message) {
    // Remove existing toasts
    document.querySelectorAll('.error-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.setAttribute('role', 'alert');
    toast.textContent = `\u26A0\uFE0F ${message}`;

    document.querySelector('.container').appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION_MS);
  }
})();
