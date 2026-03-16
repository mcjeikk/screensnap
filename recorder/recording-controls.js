/**
 * @file ScreenSnap — Recording Controls Widget (Content Script)
 * @description Floating draggable widget injected into the active tab during recording.
 * Shows timer, pause/resume, mute, and stop controls. Communicates with the
 * background service worker via chrome.runtime.sendMessage.
 * @version 0.4.1
 */

(function () {
  'use strict';

  // Prevent double injection
  if (document.getElementById('screensnap-recording-widget')) return;

  // ── Constants ───────────────────────────────────
  const WIDGET_ID = 'screensnap-recording-widget';
  const CSS_URL = chrome.runtime.getURL('recorder/recording-controls.css');

  // ── Inject CSS ──────────────────────────────────
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);

  // ── Build Widget DOM (no innerHTML — safe DOM construction) ──
  const widget = document.createElement('div');
  widget.id = WIDGET_ID;
  widget.setAttribute('role', 'toolbar');
  widget.setAttribute('aria-label', 'Recording controls');

  const recDot = document.createElement('span');
  recDot.className = 'ssw-rec-dot';
  recDot.setAttribute('aria-hidden', 'true');
  widget.appendChild(recDot);

  const timerEl = document.createElement('span');
  timerEl.className = 'ssw-timer';
  timerEl.textContent = '00:00';
  timerEl.setAttribute('aria-live', 'off');
  timerEl.setAttribute('aria-label', 'Recording duration');
  widget.appendChild(timerEl);

  const divider = document.createElement('span');
  divider.className = 'ssw-divider';
  divider.setAttribute('aria-hidden', 'true');
  widget.appendChild(divider);

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'ssw-pause';
  pauseBtn.title = 'Pause';
  pauseBtn.setAttribute('aria-label', 'Pause recording');
  pauseBtn.textContent = '\u23F8\uFE0F';
  widget.appendChild(pauseBtn);

  const muteBtn = document.createElement('button');
  muteBtn.className = 'ssw-mute';
  muteBtn.title = 'Mute mic';
  muteBtn.setAttribute('aria-label', 'Mute microphone');
  muteBtn.textContent = '\uD83C\uDFA4';
  widget.appendChild(muteBtn);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'ssw-stop';
  stopBtn.title = 'Stop recording';
  stopBtn.setAttribute('aria-label', 'Stop recording');
  stopBtn.textContent = '\u23F9 Stop';
  widget.appendChild(stopBtn);

  document.body.appendChild(widget);

  // ── State ───────────────────────────────────────
  let isPaused = false;
  let isMuted = false;
  let startTime = Date.now();

  /** @type {number} Total milliseconds spent in paused state */
  let pausedDuration = 0;

  /** @type {number} Timestamp when current pause started */
  let pauseStartTime = 0;

  /** @type {number|null} */
  let timerInterval = null;

  // ── Timer ───────────────────────────────────────

  /**
   * Update the timer display with elapsed time, accounting for paused duration.
   */
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime - pausedDuration) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
  }

  timerInterval = setInterval(updateTimer, 1000);

  // ── Pause/Resume ────────────────────────────────

  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isPaused = !isPaused;

    if (isPaused) {
      pauseBtn.textContent = '\u25B6\uFE0F';
      pauseBtn.title = 'Resume';
      pauseBtn.setAttribute('aria-label', 'Resume recording');
      recDot.classList.add('paused');
      pauseStartTime = Date.now();
      clearInterval(timerInterval);
      chrome.runtime.sendMessage({ action: 'widget-pause' });
    } else {
      pausedDuration += Date.now() - pauseStartTime;
      pauseBtn.textContent = '\u23F8\uFE0F';
      pauseBtn.title = 'Pause';
      pauseBtn.setAttribute('aria-label', 'Pause recording');
      recDot.classList.remove('paused');
      timerInterval = setInterval(updateTimer, 1000);
      chrome.runtime.sendMessage({ action: 'widget-resume' });
    }
  });

  // ── Mute/Unmute ─────────────────────────────────

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? '\uD83D\uDD07' : '\uD83C\uDFA4';
    muteBtn.title = isMuted ? 'Unmute mic' : 'Mute mic';
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
    chrome.runtime.sendMessage({ action: 'widget-mute', muted: isMuted });
  });

  // ── Stop ────────────────────────────────────────

  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'widget-stop' });
    removeWidget();
  });

  // ── Dragging ────────────────────────────────────

  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  widget.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    const rect = widget.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    widget.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    widget.style.left = `${e.clientX - dragOffsetX}px`;
    widget.style.top = `${e.clientY - dragOffsetY}px`;
    widget.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      widget.style.cursor = 'grab';
    }
  });

  // ── External Removal Command ────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'remove-recording-widget') {
      removeWidget();
    }
  });

  /**
   * Remove the widget from the DOM and clean up resources.
   */
  function removeWidget() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    widget.remove();
    link.remove();
  }
})();
