/**
 * ScreenBolt — Popup Script
 * Handles screenshot buttons, inline recording configuration,
 * recording indicator, last capture preview, and settings integration.
 * Recording starts directly from the popup — no separate recorder page.
 */

import type { Settings, HistoryEntry, RecordingConfig } from '../utils/types.js';

// ── Constants ───────────────────────────────────
const TOAST_DURATION_MS = 3000;
const LOG_PREFIX = '[ScreenBolt][Popup]';

type RecordingSource = RecordingConfig['source'];

/** Currently selected recording source */
let selectedSource: RecordingSource = 'tab';

/** Saved toggle state persisted across popup opens */
interface RecordingToggleConfig {
  microphone: boolean;
  pip: boolean;
}

/** Full recording config assembled from the popup UI and saved per session */
interface PopupRecordingConfig {
  source: RecordingSource;
  microphone: boolean;
  systemAudio: boolean;
  pip: boolean;
  pipPosition: string;
  pipSize: string;
  resolution: string;
  format: 'mp4' | 'webm';
  countdown: boolean;
}

// ── Helpers: typed DOM access ───────────────────

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

function queryEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── Init ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  bindScreenshotButtons();
  bindSourceSelector();
  bindRecordingToggles();
  bindStartRecording();
  bindFooterButtons();
  await loadRecordingConfig();
  await loadSavedRecordingConfig();
  await checkRecordingStatus();
  await showLastCapture();
});

// ── Screenshot Buttons ──────────────────────────

/** Bind screenshot capture buttons to their respective actions. */
function bindScreenshotButtons(): void {
  getEl('btn-visible').addEventListener('click', () => captureAction('capture-visible'));
  getEl('btn-full').addEventListener('click', () => captureAction('capture-full-page'));
  getEl('btn-selection').addEventListener('click', () => captureAction('capture-selection'));
}

// ── Source Selector ─────────────────────────────

/** Bind click handlers to recording source buttons (Tab / Screen / Camera). */
function bindSourceSelector(): void {
  document.querySelectorAll<HTMLButtonElement>('.source-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectSource(btn.dataset.source as RecordingSource));
  });
}

/** Select a recording source and update UI state. */
function selectSource(source: RecordingSource): void {
  selectedSource = source;

  document.querySelectorAll<HTMLButtonElement>('.source-btn').forEach((btn) => {
    const isActive = btn.dataset.source === source;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // Hide PiP and system audio for camera-only
  const pipRow = getEl<HTMLElement>('pip-row');
  const sysAudioRow = getEl<HTMLElement>('system-audio-row');
  const pipOptions = getEl<HTMLElement>('pip-options');

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

/** Check if a media permission is granted. */
async function isPermissionGranted(name: 'microphone' | 'camera'): Promise<boolean> {
  try {
    const result = await navigator.permissions.query({ name: name as PermissionName });
    return result.state === 'granted';
  } catch {
    return false;
  }
}

/** Open the permissions page if needed, with a message about what to grant. */
function openPermissionsPage(type: 'microphone' | 'camera'): void {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`permissions/permissions.html?request=${type}`),
  });
}

/** Bind toggle interactions for PiP sub-options visibility and mic permission check. */
function bindRecordingToggles(): void {
  // Mic toggle — check permission when enabled, save state
  const micToggle = queryEl<HTMLInputElement>('opt-mic');
  if (micToggle) {
    micToggle.addEventListener('change', async (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        const granted = await isPermissionGranted('microphone');
        if (!granted) {
          target.checked = false;
          openPermissionsPage('microphone');
          return;
        }
      }
      saveRecordingConfig();
    });
  }

  // PiP toggle — no permission check needed here.
  // Camera permission is requested by the content script on the page when recording starts.
  getEl<HTMLInputElement>('opt-pip').addEventListener('change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    getEl<HTMLElement>('pip-options').style.display = target.checked ? 'block' : 'none';
    saveRecordingConfig();
  });
}

/** Save current toggle states to chrome.storage.local recordingConfig. */
function saveRecordingConfig(): void {
  const config: RecordingToggleConfig = {
    microphone: queryEl<HTMLInputElement>('opt-mic')?.checked ?? false,
    pip: queryEl<HTMLInputElement>('opt-pip')?.checked ?? false,
  };
  chrome.storage.local.set({ recordingConfig: config });
}

/**
 * Load saved toggle states from chrome.storage.local and apply them,
 * respecting current permission state.
 */
async function loadRecordingConfig(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('recordingConfig');
    const config = result.recordingConfig as RecordingToggleConfig | undefined;
    if (!config) return;

    // Restore mic toggle if saved ON and permission is granted
    if (config.microphone) {
      const micGranted = await isPermissionGranted('microphone');
      const micToggle = queryEl<HTMLInputElement>('opt-mic');
      if (micToggle && micGranted) {
        micToggle.checked = true;
      }
    }

    // Restore pip toggle if saved ON and camera permission is granted
    if (config.pip) {
      const camGranted = await isPermissionGranted('camera');
      const pipToggle = queryEl<HTMLInputElement>('opt-pip');
      if (pipToggle && camGranted) {
        pipToggle.checked = true;
        getEl<HTMLElement>('pip-options').style.display = 'block';
      }
    }
  } catch {
    // Non-critical
  }
}

// ── Start Recording ─────────────────────────────

/** Bind the Start Recording button. */
function bindStartRecording(): void {
  getEl('btn-start-recording').addEventListener('click', handleStartRecording);
}

/**
 * Gather recording config, save it, send to service worker, and close popup.
 * The user gesture chain from the click is preserved for tabCapture.
 */
async function handleStartRecording(): Promise<void> {
  const btn = getEl<HTMLButtonElement>('btn-start-recording');
  btn.disabled = true;
  hideRecError();

  try {
    const wantsMic = getEl<HTMLInputElement>('opt-mic').checked;

    // If mic is requested, test actual getUserMedia access.
    // This is the only reliable way to check — permissions.query is unreliable in extension popups.
    // The popup is a real extension page, so getUserMedia works here and the grant
    // carries over to the offscreen document (same origin).
    if (wantsMic) {
      try {
        const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Permission granted — release the test stream immediately
        testStream.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission denied or not yet granted — open permissions page
        await chrome.tabs.create({
          url: chrome.runtime.getURL('permissions/permissions.html?request=microphone'),
        });
        showRecError('Microphone permission required. Grant access on the permissions page, then try again.');
        btn.disabled = false;
        return;
      }
    }

    const wantsPip = queryEl<HTMLInputElement>('opt-pip')?.checked ?? false;

    // If PiP webcam is requested for screen recording, pre-grant camera permission.
    // The offscreen document can't show permission prompts, so we test it here.
    if (wantsPip && selectedSource === 'screen') {
      try {
        const testCam = await navigator.mediaDevices.getUserMedia({ video: true });
        testCam.getTracks().forEach((t) => t.stop());
      } catch {
        await chrome.tabs.create({
          url: chrome.runtime.getURL('permissions/permissions.html?request=camera'),
        });
        showRecError('Camera permission required for PiP. Grant access, then try again.');
        btn.disabled = false;
        return;
      }
    }

    const config: PopupRecordingConfig = {
      source: selectedSource,
      microphone: wantsMic,
      systemAudio: queryEl<HTMLInputElement>('opt-system-audio')?.checked ?? false,
      pip: wantsPip,
      pipPosition: queryEl<HTMLSelectElement>('pip-position')?.value ?? 'bottom-right',
      pipSize: queryEl<HTMLSelectElement>('pip-size')?.value ?? 'medium',
      resolution: getEl<HTMLSelectElement>('opt-resolution').value,
      format: getEl<HTMLSelectElement>('opt-format').value as 'mp4' | 'webm',
      countdown: getEl<HTMLInputElement>('opt-countdown').checked,
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
    showRecError((err as Error).message);
    btn.disabled = false;
  }
}

// ── Load Saved Config ───────────────────────────

/** Load previously saved recording config and apply to UI. */
async function loadSavedRecordingConfig(): Promise<void> {
  try {
    const result = await chrome.storage.session.get('lastRecordingConfig');
    const config = result.lastRecordingConfig as PopupRecordingConfig | undefined;
    if (!config) return;

    selectSource(config.source || 'tab');

    if (typeof config.microphone === 'boolean') {
      getEl<HTMLInputElement>('opt-mic').checked = config.microphone;
    }
    if (typeof config.systemAudio === 'boolean') {
      const el = queryEl<HTMLInputElement>('opt-system-audio');
      if (el) el.checked = config.systemAudio;
    }
    if (typeof config.pip === 'boolean') {
      const el = queryEl<HTMLInputElement>('opt-pip');
      if (el) {
        el.checked = config.pip;
        getEl<HTMLElement>('pip-options').style.display = config.pip ? 'block' : 'none';
      }
    }
    if (config.pipPosition) {
      const el = queryEl<HTMLSelectElement>('pip-position');
      if (el) el.value = config.pipPosition;
    }
    if (config.pipSize) {
      const el = queryEl<HTMLSelectElement>('pip-size');
      if (el) el.value = config.pipSize;
    }
    if (config.resolution) {
      getEl<HTMLSelectElement>('opt-resolution').value = config.resolution;
    }
    if (typeof config.countdown === 'boolean') {
      getEl<HTMLInputElement>('opt-countdown').checked = config.countdown;
    }
  } catch {
    // Non-critical — use defaults
  }
}

// ── Footer ──────────────────────────────────────

/** Bind footer navigation buttons. */
function bindFooterButtons(): void {
  getEl('btn-history').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
    window.close();
  });

  getEl('btn-settings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    window.close();
  });
}

// ── Capture Actions ─────────────────────────────

type CaptureAction = 'capture-visible' | 'capture-full-page' | 'capture-selection';

/** Execute a screenshot capture action and handle the response. */
async function captureAction(action: CaptureAction): Promise<void> {
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
    showError((err as Error).message);
  }
}

// ── Recording Status ────────────────────────────

/** Check if a recording is active and show/hide UI accordingly. */
async function checkRecordingStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'get-recording-status' });
    if (response?.isRecording) {
      getEl<HTMLElement>('recording-indicator').style.display = 'flex';
      getEl<HTMLElement>('record-section').style.display = 'none';

      // Bind stop button in indicator
      const stopBtn = queryEl<HTMLButtonElement>('btn-stop-recording');
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

/** Display the most recent capture in the popup for quick access. */
async function showLastCapture(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('historyEntries');
    const entries = (result.historyEntries || []) as HistoryEntry[];
    if (entries.length === 0) return;

    const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
    const last = sorted.find((e) => e.thumbnail);
    if (!last) return;

    const container = getEl<HTMLElement>('last-capture');
    const thumb = getEl<HTMLImageElement>('last-capture-thumb');
    const nameEl = getEl<HTMLElement>('last-capture-name');

    thumb.src = last.thumbnail!;
    thumb.alt = `Preview of ${last.name}`;
    nameEl.textContent = last.name;
    container.style.display = 'flex';

    getEl('btn-open-last').addEventListener('click', () => {
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

/** Load extension settings from chrome.storage.sync. */
async function getSettings(): Promise<Partial<Settings>> {
  try {
    const result = await chrome.storage.sync.get('settings');
    return (result.settings || {}) as Partial<Settings>;
  } catch {
    return {};
  }
}

// ── Error Feedback ──────────────────────────────

/** Show a temporary error toast in the popup. */
function showError(message: string): void {
  document.querySelectorAll('.error-toast').forEach((el) => el.remove());

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = `\u26A0\uFE0F ${message}`;

  document.querySelector('.container')!.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION_MS);
}

/** Show an error in the recording section. */
function showRecError(message: string): void {
  const el = getEl<HTMLElement>('rec-error');
  el.textContent = `\u26A0\uFE0F ${message}`;
  el.style.display = 'block';
}

/** Hide the recording error. */
function hideRecError(): void {
  getEl<HTMLElement>('rec-error').style.display = 'none';
}
