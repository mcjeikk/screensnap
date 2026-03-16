/**
 * @file ScreenSnap — Settings Page v0.5.0
 * @description Persists all user settings in chrome.storage.sync for cross-device sync.
 * Uses a field map pattern for clean, maintainable settings binding.
 * @version 0.5.0
 */

(() => {
  'use strict';

  // ── Default Settings ────────────────────────────
  /** @type {Object} Complete default settings */
  const DEFAULTS = Object.freeze({
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

  /**
   * Map of setting keys to DOM element IDs.
   * @type {Object<string, string>}
   */
  const FIELD_MAP = Object.freeze({
    screenshotFormat: 'ss-format',
    jpgQuality: 'ss-jpg-quality',
    afterCapture: 'ss-after-capture',
    saveSubfolder: 'ss-subfolder',
    recResolution: 'rec-resolution',
    recAudio: 'rec-audio',
    recPip: 'rec-pip',
    recPipPosition: 'rec-pip-position',
    recPipSize: 'rec-pip-size',
    recCountdown: 'rec-countdown',
    recFormat: 'rec-format',
    theme: 'gen-theme',
    notifications: 'gen-notifications',
    keepHistory: 'gen-keep-history',
    maxHistory: 'gen-max-history',
  });

  /** @type {number} Duration to show save confirmation (ms) */
  const SAVE_STATUS_DURATION_MS = 1500;

  const saveStatus = document.getElementById('save-status');
  let saveTimeout = null;

  // ── Init ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    const settings = await loadSettings();
    populateUI(settings);
    setupListeners(settings);
  });

  /**
   * Load settings from chrome.storage.sync, merged with defaults.
   * @returns {Promise<Object>} Merged settings
   */
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get('settings');
      return { ...DEFAULTS, ...(result.settings || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Populate all UI fields from the settings object.
   * @param {Object} settings - Settings object
   */
  function populateUI(settings) {
    for (const [key, elId] of Object.entries(FIELD_MAP)) {
      const el = document.getElementById(elId);
      if (!el) continue;
      const val = settings[key];

      if (el.type === 'range') {
        el.value = val;
        const valDisplay = document.getElementById(`${elId}-val`);
        if (valDisplay) valDisplay.textContent = `${val}%`;
      } else {
        el.value = String(val);
      }
    }

    toggleJpgQuality(settings.screenshotFormat);
  }

  /**
   * Set up change listeners on all settings fields.
   * @param {Object} settings - Mutable settings reference
   */
  function setupListeners(settings) {
    for (const [key, elId] of Object.entries(FIELD_MAP)) {
      const el = document.getElementById(elId);
      if (!el) continue;

      const event = el.type === 'range' ? 'input' : 'change';
      el.addEventListener(event, () => {
        let val = el.value;

        if (el.type === 'range') {
          val = parseInt(val, 10);
          const valDisplay = document.getElementById(`${elId}-val`);
          if (valDisplay) valDisplay.textContent = `${val}%`;
        }

        if (key === 'maxHistory') val = parseInt(val, 10);

        settings[key] = val;
        saveSettings(settings);

        // Special handlers
        if (key === 'screenshotFormat') toggleJpgQuality(val);
        if (key === 'theme') applyTheme(val);
      });
    }
  }

  /**
   * Show/hide JPG quality slider based on format selection.
   * @param {string} format - 'png' or 'jpg'
   */
  function toggleJpgQuality(format) {
    const row = document.getElementById('jpg-quality-row');
    if (row) row.style.display = format === 'jpg' ? 'flex' : 'none';
  }

  /**
   * Apply a theme to the current page.
   * @param {string} theme - 'dark' | 'light' | 'system'
   */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  /**
   * Save settings to chrome.storage.sync and show confirmation.
   * @param {Object} settings - Settings to save
   */
  async function saveSettings(settings) {
    try {
      await chrome.storage.sync.set({ settings });
      showSaveStatus();
    } catch (err) {
      console.error('[ScreenSnap][Settings] Save failed:', err);
    }
  }

  /** Show the "Settings saved" confirmation toast. */
  function showSaveStatus() {
    saveStatus.classList.add('visible');
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, SAVE_STATUS_DURATION_MS);
  }
})();
