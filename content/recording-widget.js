/**
 * @file ScreenBolt — Recording Widget (Content Script, Shadow DOM)
 * @description Floating draggable recording controls widget injected into the
 * user's active tab during recording. Uses a closed shadow DOM to avoid
 * CSS conflicts with the host page. Communicates with the service worker
 * via chrome.runtime.sendMessage().
 * @version 0.7.0
 */

(function () {
  'use strict';

  const WIDGET_HOST_ID = '__screenBoltWidget';

  // Prevent double injection
  if (document.getElementById(WIDGET_HOST_ID)) return;

  // ── Create Shadow DOM Host ──────────────────────

  const host = document.createElement('div');
  host.id = WIDGET_HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  // ── Inject Styles into Shadow DOM ───────────────

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .widget {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 50px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      font-size: 13px;
      color: #F1F5F9;
      cursor: grab;
      user-select: none;
      transition: opacity 0.2s, box-shadow 0.2s;
    }

    .widget:active {
      cursor: grabbing;
    }

    .widget:hover {
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
    }

    .rec-dot {
      width: 10px;
      height: 10px;
      background: #EF4444;
      border-radius: 50%;
      animation: blink 1s ease-in-out infinite;
      flex-shrink: 0;
    }

    .rec-dot.paused {
      animation: none;
      opacity: 0.4;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    .timer {
      font-weight: 700;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      min-width: 48px;
    }

    .divider {
      width: 1px;
      height: 20px;
      background: rgba(255, 255, 255, 0.15);
    }

    button {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      border-radius: 20px;
      color: #F1F5F9;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      line-height: 1.4;
    }

    button:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    button:focus-visible {
      outline: 2px solid #6366F1;
      outline-offset: 2px;
    }

    .btn-stop {
      background: #EF4444;
    }

    .btn-stop:hover {
      background: #DC2626;
    }
  `;
  shadow.appendChild(style);

  // ── Build Widget DOM ────────────────────────────

  const widget = document.createElement('div');
  widget.className = 'widget';
  widget.setAttribute('role', 'toolbar');
  widget.setAttribute('aria-label', 'Recording controls');

  const recDot = document.createElement('span');
  recDot.className = 'rec-dot';
  recDot.setAttribute('aria-hidden', 'true');
  widget.appendChild(recDot);

  const timerEl = document.createElement('span');
  timerEl.className = 'timer';
  timerEl.textContent = '00:00';
  timerEl.setAttribute('aria-label', 'Recording duration');
  widget.appendChild(timerEl);

  const divider = document.createElement('span');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  widget.appendChild(divider);

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'btn-pause';
  pauseBtn.title = 'Pause';
  pauseBtn.setAttribute('aria-label', 'Pause recording');
  pauseBtn.textContent = '⏸️';
  widget.appendChild(pauseBtn);

  const muteBtn = document.createElement('button');
  muteBtn.className = 'btn-mute';
  muteBtn.title = 'Mute mic';
  muteBtn.setAttribute('aria-label', 'Mute microphone');
  muteBtn.textContent = '🎤';
  widget.appendChild(muteBtn);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn-stop';
  stopBtn.title = 'Stop recording';
  stopBtn.setAttribute('aria-label', 'Stop recording');
  stopBtn.textContent = '⏹ Stop';
  widget.appendChild(stopBtn);

  shadow.appendChild(widget);

  document.body.appendChild(host);

  // ── State ───────────────────────────────────────
  let isPaused = false;
  let isMuted = false;
  /** @type {number|null} */
  let timerInterval = null;

  // ── Timer (polls elapsed time from offscreen) ───

  /**
   * Update the timer by requesting elapsed time from the service worker.
   */
  async function updateTimer() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-recording-time' });
      if (response?.success && typeof response.elapsed === 'number') {
        const totalSec = Math.floor(response.elapsed / 1000);
        const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
        const ss = String(totalSec % 60).padStart(2, '0');
        timerEl.textContent = `${mm}:${ss}`;
      }
    } catch {
      // Extension context may be invalidated — ignore
    }
  }

  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();

  // ── Pause/Resume ────────────────────────────────

  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isPaused = !isPaused;

    if (isPaused) {
      pauseBtn.textContent = '▶️';
      pauseBtn.title = 'Resume';
      pauseBtn.setAttribute('aria-label', 'Resume recording');
      recDot.classList.add('paused');
    } else {
      pauseBtn.textContent = '⏸️';
      pauseBtn.title = 'Pause';
      pauseBtn.setAttribute('aria-label', 'Pause recording');
      recDot.classList.remove('paused');
    }

    safeSend({ action: isPaused ? 'widget-pause' : 'widget-resume' });
  });

  // ── Mute/Unmute ─────────────────────────────────

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? '🔇' : '🎤';
    muteBtn.title = isMuted ? 'Unmute mic' : 'Mute mic';
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
    safeSend({ action: 'widget-mute', muted: isMuted });
  });

  // ── Stop ────────────────────────────────────────

  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    safeSend({ action: 'widget-stop' });
    removeWidget();
  });

  // ── Dragging ────────────────────────────────────

  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  widget.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    widget.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    host.style.position = 'fixed';
    host.style.left = `${e.clientX - dragOffsetX}px`;
    host.style.top = `${e.clientY - dragOffsetY}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      widget.style.cursor = 'grab';
    }
  });

  // ── Message Listener (external removal) ─────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'remove-recording-widget') {
      removeWidget();
    }
  });

  // ── Helpers ─────────────────────────────────────

  /**
   * Safely send a message to the service worker.
   * Handles extension context invalidation gracefully.
   * @param {Object} msg - Message to send
   */
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (err.message?.includes('Extension context invalidated')) {
        console.warn('[ScreenBolt][Widget] Extension updated — removing widget');
        removeWidget();
      }
    }
  }

  // ── PiP Webcam Bubble ───────────────────────────
  // Visible on the page so tabCapture captures it automatically.
  // Permission prompt is standard browser behavior (once per site).

  let webcamStream = null;
  let webcamBubble = null;

  async function setupWebcamBubble(config) {
    if (!config?.pip) return;

    const size = { small: 120, medium: 180, large: 240 }[config.pipSize] || 180;
    const pos = config.pipPosition || 'bottom-right';
    const margin = 20;

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: size * 2 }, height: { ideal: size * 2 } },
        audio: false,
      });
    } catch (err) {
      console.warn('[ScreenBolt][Widget] Webcam not available:', err.message);
      return;
    }

    const video = document.createElement('video');
    video.srcObject = webcamStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    webcamBubble = document.createElement('div');
    webcamBubble.className = 'webcam-bubble';
    webcamBubble.appendChild(video);

    const posStyle = {
      'top-left': `top: ${margin}px; left: ${margin}px;`,
      'top-right': `top: ${margin}px; right: ${margin}px;`,
      'bottom-left': `bottom: ${margin + 60}px; left: ${margin}px;`,
      'bottom-right': `bottom: ${margin + 60}px; right: ${margin}px;`,
    }[pos] || `bottom: ${margin + 60}px; right: ${margin}px;`;

    const webcamStyle = document.createElement('style');
    webcamStyle.textContent = `
      .webcam-bubble {
        position: fixed;
        ${posStyle}
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        overflow: hidden;
        border: 3px solid rgba(255,255,255,0.8);
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        z-index: 2147483646;
        cursor: grab;
        transition: box-shadow 0.2s;
      }
      .webcam-bubble:hover {
        box-shadow: 0 6px 28px rgba(0,0,0,0.7);
      }
      .webcam-bubble video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scaleX(-1);
        pointer-events: none;
      }
    `;
    shadow.appendChild(webcamStyle);
    shadow.appendChild(webcamBubble);

    // Draggable
    let bd = false, bx = 0, by = 0;
    webcamBubble.addEventListener('mousedown', (e) => {
      bd = true;
      bx = e.clientX - webcamBubble.getBoundingClientRect().left;
      by = e.clientY - webcamBubble.getBoundingClientRect().top;
      webcamBubble.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!bd) return;
      webcamBubble.style.position = 'fixed';
      webcamBubble.style.left = `${e.clientX - bx}px`;
      webcamBubble.style.top = `${e.clientY - by}px`;
      webcamBubble.style.right = 'auto';
      webcamBubble.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (bd) { bd = false; webcamBubble.style.cursor = 'grab'; }
    });
  }

  function cleanupWebcam() {
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }
    if (webcamBubble) { webcamBubble.remove(); webcamBubble = null; }
  }

  // Listen for PiP setup from service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'setup-webcam-pip') {
      setupWebcamBubble(msg.config);
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
    cleanupWebcam();
    host.remove();
  }
})();
