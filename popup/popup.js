/**
 * @file ScreenBolt — Popup Script v0.7.0
 * @description Handles screenshot buttons, inline recording configuration,
 * recording indicator, last capture preview, and settings integration.
 * Recording now starts directly from the popup — no separate recorder page.
 * @version 0.7.0
 */

(() => {
  'use strict';

  // ── Constants ───────────────────────────────────
  const TOAST_DURATION_MS = 3000;
  const LOG_PREFIX = '[ScreenBolt][Popup]';

  /** @type {string} Currently selected recording source */
  let selectedSource = 'tab';

  // ── Init ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    bindScreenshotButtons();
    bindSourceSelector();
    bindRecordingToggles();
    bindStartRecording();
    bindFooterButtons();
    await loadSavedRecordingConfig();
    await checkRecordingStatus();
    await showLastCapture();
  });

  // ── Screenshot Buttons ──────────────────────────

  /**
   * Bind screenshot capture buttons to their respective actions.
   */
  function bindScreenshotButtons() {
    document.getElementById('btn-visible').addEventListener('click', () => captureAction('capture-visible'));
    document.getElementById('btn-full').addEventListener('click', () => captureAction('capture-full-page'));
    document.getElementById('btn-selection').addEventListener('click', () => captureAction('capture-selection'));
  }

  // ── Source Selector ─────────────────────────────

  /**
   * Bind click handlers to recording source buttons (Tab / Screen / Camera).
   */
  function bindSourceSelector() {
    document.querySelectorAll('.source-btn').forEach(btn => {
      btn.addEventListener('click', () => selectSource(btn.dataset.source));
    });
  }

  /**
   * Select a recording source and update UI state.
   * @param {string} source - 'tab' | 'screen' | 'camera'
   */
  function selectSource(source) {
    selectedSource = source;

    document.querySelectorAll('.source-btn').forEach(btn => {
      const isActive = btn.dataset.source === source;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    // Hide PiP and system audio for camera-only
    const pipRow = document.getElementById('pip-row');
    const sysAudioRow = document.getElementById('system-audio-row');
    const pipOptions = document.getElementById('pip-options');

    if (source === 'camera') {
      pipRow.style.display = 'none';
      sysAudioRow.style.display = 'none';
      pipOptions.style.display = 'none';
    } else {
      pipRow.style.display = 'flex';
      sysAudioRow.style.display = 'flex';
    }
  }

  // ── Recording Toggles ──────────────────────────

  /**
   * Bind toggle interactions for PiP sub-options visibility.
   */
  function bindRecordingToggles() {
    // Pre-request mic permission when toggle is turned ON (needs visible UI for prompt)
    const micToggle = document.getElementById('opt-mic');
    if (micToggle) {
      micToggle.addEventListener('change', async (e) => {
        if (e.target.checked) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
          } catch {
            e.target.checked = false;
            showRecError('Microphone permission denied');
          }
        }
      });
    }

    document.getElementById('opt-pip').addEventListener('change', async (e) => {
      document.getElementById('pip-options').style.display = e.target.checked ? 'block' : 'none';
      // Pre-request camera permission when PiP is turned ON
      if (e.target.checked) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          stream.getTracks().forEach(t => t.stop());
        } catch {
          e.target.checked = false;
          document.getElementById('pip-options').style.display = 'none';
          showRecError('Camera permission denied');
        }
      }
    });
  }

  // ── Start Recording ─────────────────────────────

  /**
   * Bind the Start Recording button.
   */
  function bindStartRecording() {
    document.getElementById('btn-start-recording').addEventListener('click', handleStartRecording);
  }

  /**
   * Gather recording config, save it, send to service worker, and close popup.
   * The user gesture chain from the click is preserved for tabCapture.
   */
  async function handleStartRecording() {
    const btn = document.getElementById('btn-start-recording');
    btn.disabled = true;
    hideRecError();

    try {
      const config = {
        source: selectedSource,
        microphone: document.getElementById('opt-mic').checked,
        systemAudio: document.getElementById('opt-system-audio')?.checked ?? false,
        pip: document.getElementById('opt-pip')?.checked ?? false,
        pipPosition: document.getElementById('pip-position')?.value ?? 'bottom-right',
        pipSize: document.getElementById('pip-size')?.value ?? 'medium',
        resolution: document.getElementById('opt-resolution').value,
        countdown: document.getElementById('opt-countdown').checked,
      };

      // Save config for next time
      await chrome.storage.session.set({ lastRecordingConfig: config });

      // Send to service worker — the SW will handle stream acquisition and offscreen
      const response = await chrome.runtime.sendMessage({
        action: 'start-recording',
        config,
      });

      if (!response?.success) {
        showRecError(response?.error || 'Failed to start recording');
        btn.disabled = false;
        return;
      }

      // Close popup — recording is now managed by SW + offscreen + widget
      window.close();

    } catch (err) {
      console.error(LOG_PREFIX, 'Start recording failed:', err);
      showRecError(err.message);
      btn.disabled = false;
    }
  }

  // ── Load Saved Config ───────────────────────────

  /**
   * Load previously saved recording config and apply to UI.
   */
  async function loadSavedRecordingConfig() {
    try {
      const result = await chrome.storage.session.get('lastRecordingConfig');
      const config = result.lastRecordingConfig;
      if (!config) return;

      selectSource(config.source || 'tab');

      if (typeof config.microphone === 'boolean') {
        document.getElementById('opt-mic').checked = config.microphone;
      }
      if (typeof config.systemAudio === 'boolean') {
        const el = document.getElementById('opt-system-audio');
        if (el) el.checked = config.systemAudio;
      }
      if (typeof config.pip === 'boolean') {
        const el = document.getElementById('opt-pip');
        if (el) {
          el.checked = config.pip;
          document.getElementById('pip-options').style.display = config.pip ? 'block' : 'none';
        }
      }
      if (config.pipPosition) {
        const el = document.getElementById('pip-position');
        if (el) el.value = config.pipPosition;
      }
      if (config.pipSize) {
        const el = document.getElementById('pip-size');
        if (el) el.value = config.pipSize;
      }
      if (config.resolution) {
        document.getElementById('opt-resolution').value = config.resolution;
      }
      if (typeof config.countdown === 'boolean') {
        document.getElementById('opt-countdown').checked = config.countdown;
      }
    } catch {
      // Non-critical — use defaults
    }
  }

  // ── Footer ──────────────────────────────────────

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

  // ── Capture Actions ─────────────────────────────

  /**
   * Execute a screenshot capture action and handle the response.
   * @param {string} action - The capture action type
   */
  async function captureAction(action) {
    try {
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
   * Check if a recording is active and show/hide UI accordingly.
   */
  async function checkRecordingStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-recording-status' });
      if (response?.isRecording) {
        document.getElementById('recording-indicator').style.display = 'flex';
        document.getElementById('record-section').style.display = 'none';

        // Bind stop button in indicator
        const stopBtn = document.getElementById('btn-stop-recording');
        if (stopBtn) {
          stopBtn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ action: 'widget-stop' });
            window.close();
          });
        }
      }
    } catch {
      // Service worker may not be ready
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
      // Non-critical
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
   * @param {string} message - Error message
   */
  function showError(message) {
    document.querySelectorAll('.error-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.setAttribute('role', 'alert');
    toast.textContent = `⚠️ ${message}`;

    document.querySelector('.container').appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION_MS);
  }

  /**
   * Show an error in the recording section.
   * @param {string} message - Error message
   */
  function showRecError(message) {
    const el = document.getElementById('rec-error');
    el.textContent = `⚠️ ${message}`;
    el.style.display = 'block';
  }

  /**
   * Hide the recording error.
   */
  function hideRecError() {
    document.getElementById('rec-error').style.display = 'none';
  }
})();
