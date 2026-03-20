/**
 * ScreenBolt — Recording Widget (Content Script, Shadow DOM)
 *
 * Floating draggable recording controls widget injected into the user's active
 * tab during recording. Uses a closed shadow DOM to avoid CSS conflicts with the
 * host page. Communicates with the service worker via chrome.runtime.sendMessage().
 *
 * Standalone content script — no imports from utils/.
 */

// ── Types ──────────────────────────────────────────────

type PipPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type PipSize = 'small' | 'medium' | 'large';

interface WebcamPipConfig {
  pip: boolean;
  pipPosition?: PipPosition;
  pipSize?: PipSize;
}

interface TimerResponse {
  success?: boolean;
  elapsed?: number;
}

interface WidgetMessage {
  action: string;
  muted?: boolean;
  config?: WebcamPipConfig;
}

// ── Constants ──────────────────────────────────────────

const WIDGET_HOST_ID = '__screenBoltWidget';

const PIP_SIZE_MAP: Record<PipSize, number> = {
  small: 120,
  medium: 180,
  large: 240,
};

// Remove any stale widget from previous injection (e.g. after recording stopped)
const existingHost = document.getElementById(WIDGET_HOST_ID);
if (existingHost) {
  existingHost.remove();
}

// Always initialize fresh on each injection
initWidget();

function initWidget(): void {
  // ── Create Shadow DOM Host ──────────────────────

  const host: HTMLDivElement = document.createElement('div');
  host.id = WIDGET_HOST_ID;
  const shadow: ShadowRoot = host.attachShadow({ mode: 'closed' });

  // ── Inject Styles into Shadow DOM ───────────────

  const style: HTMLStyleElement = document.createElement('style');
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

  const widget: HTMLDivElement = document.createElement('div');
  widget.className = 'widget';
  widget.setAttribute('role', 'toolbar');
  widget.setAttribute('aria-label', 'Recording controls');

  const recDot: HTMLSpanElement = document.createElement('span');
  recDot.className = 'rec-dot';
  recDot.setAttribute('aria-hidden', 'true');
  widget.appendChild(recDot);

  const timerEl: HTMLSpanElement = document.createElement('span');
  timerEl.className = 'timer';
  timerEl.textContent = '00:00';
  timerEl.setAttribute('aria-label', 'Recording duration');
  widget.appendChild(timerEl);

  const divider: HTMLSpanElement = document.createElement('span');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  widget.appendChild(divider);

  const pauseBtn: HTMLButtonElement = document.createElement('button');
  pauseBtn.className = 'btn-pause';
  pauseBtn.title = 'Pause';
  pauseBtn.setAttribute('aria-label', 'Pause recording');
  pauseBtn.textContent = '\u23F8\uFE0F';
  widget.appendChild(pauseBtn);

  const muteBtn: HTMLButtonElement = document.createElement('button');
  muteBtn.className = 'btn-mute';
  muteBtn.title = 'Mute mic';
  muteBtn.setAttribute('aria-label', 'Mute microphone');
  muteBtn.textContent = '\uD83C\uDFA4';
  widget.appendChild(muteBtn);

  const stopBtn: HTMLButtonElement = document.createElement('button');
  stopBtn.className = 'btn-stop';
  stopBtn.title = 'Stop recording';
  stopBtn.setAttribute('aria-label', 'Stop recording');
  stopBtn.textContent = '\u23F9 Stop';
  widget.appendChild(stopBtn);

  shadow.appendChild(widget);

  document.body.appendChild(host);

  // ── State ───────────────────────────────────────

  let isPaused = false;
  let isMuted = false;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // ── Timer (polls elapsed time from offscreen) ───

  // Update the timer by requesting elapsed time from the service worker.
  async function updateTimer(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'get-recording-time',
      }) as TimerResponse;
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

  pauseBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    isPaused = !isPaused;

    if (isPaused) {
      pauseBtn.textContent = '\u25B6\uFE0F';
      pauseBtn.title = 'Resume';
      pauseBtn.setAttribute('aria-label', 'Resume recording');
      recDot.classList.add('paused');
    } else {
      pauseBtn.textContent = '\u23F8\uFE0F';
      pauseBtn.title = 'Pause';
      pauseBtn.setAttribute('aria-label', 'Pause recording');
      recDot.classList.remove('paused');
    }

    safeSend({ action: isPaused ? 'widget-pause' : 'widget-resume' });
  });

  // ── Mute/Unmute ─────────────────────────────────

  muteBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? '\uD83D\uDD07' : '\uD83C\uDFA4';
    muteBtn.title = isMuted ? 'Unmute mic' : 'Mute mic';
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
    safeSend({ action: 'widget-mute', muted: isMuted });
  });

  // ── Stop ────────────────────────────────────────

  stopBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    safeSend({ action: 'widget-stop' });
    removeWidget();
  });

  // ── Dragging ────────────────────────────────────

  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  widget.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    isDragging = true;
    const rect: DOMRect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    widget.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
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

  chrome.runtime.onMessage.addListener((msg: WidgetMessage) => {
    if (msg?.action === 'remove-recording-widget') {
      removeWidget();
    }
  });

  // ── Helpers ─────────────────────────────────────

  // Safely send a message to the service worker.
  // Handles extension context invalidation gracefully.
  function safeSend(msg: WidgetMessage): void {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (err: unknown) {
      if (err instanceof Error && err.message?.includes('Extension context invalidated')) {
        console.warn('[ScreenBolt][Widget] Extension updated — removing widget');
        removeWidget();
      }
    }
  }

  // ── PiP Webcam Bubble ───────────────────────────
  // Visible on the page so tabCapture captures it automatically.
  // Permission prompt is standard browser behavior (once per site).

  let webcamStream: MediaStream | null = null;
  let webcamBubble: HTMLDivElement | null = null;

  async function setupWebcamBubble(config: WebcamPipConfig | undefined): Promise<void> {
    if (!config?.pip) return;

    const size: number = PIP_SIZE_MAP[config.pipSize ?? 'medium'];
    const pos: PipPosition = config.pipPosition ?? 'bottom-right';
    const margin = 20;

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: size * 2 }, height: { ideal: size * 2 } },
        audio: false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[ScreenBolt][Widget] Webcam not available:', message);
      return;
    }

    const video: HTMLVideoElement = document.createElement('video');
    video.srcObject = webcamStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    webcamBubble = document.createElement('div');
    webcamBubble.className = 'webcam-bubble';
    webcamBubble.appendChild(video);

    const posStyleMap: Record<PipPosition, string> = {
      'top-left': `top: ${margin}px; left: ${margin}px;`,
      'top-right': `top: ${margin}px; right: ${margin}px;`,
      'bottom-left': `bottom: ${margin + 60}px; left: ${margin}px;`,
      'bottom-right': `bottom: ${margin + 60}px; right: ${margin}px;`,
    };
    const posStyle: string = posStyleMap[pos];

    const webcamStyle: HTMLStyleElement = document.createElement('style');
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

    // Draggable bubble
    let bubbleDragging = false;
    let bubbleOffsetX = 0;
    let bubbleOffsetY = 0;

    webcamBubble.addEventListener('mousedown', (e: MouseEvent) => {
      bubbleDragging = true;
      bubbleOffsetX = e.clientX - webcamBubble!.getBoundingClientRect().left;
      bubbleOffsetY = e.clientY - webcamBubble!.getBoundingClientRect().top;
      webcamBubble!.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!bubbleDragging || !webcamBubble) return;
      webcamBubble.style.position = 'fixed';
      webcamBubble.style.left = `${e.clientX - bubbleOffsetX}px`;
      webcamBubble.style.top = `${e.clientY - bubbleOffsetY}px`;
      webcamBubble.style.right = 'auto';
      webcamBubble.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (bubbleDragging) {
        bubbleDragging = false;
        if (webcamBubble) webcamBubble.style.cursor = 'grab';
      }
    });
  }

  function cleanupWebcam(): void {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      webcamStream = null;
    }
    if (webcamBubble) {
      webcamBubble.remove();
      webcamBubble = null;
    }
  }

  // Listen for PiP setup from service worker.
  // Must return true for sendResponse to work asynchronously.
  chrome.runtime.onMessage.addListener(
    (msg: WidgetMessage, _sender: chrome.runtime.MessageSender, sendResponse: (resp: unknown) => void) => {
      if (msg?.action === 'setup-webcam-pip') {
        setupWebcamBubble(msg.config);
        sendResponse({ success: true });
      }
      return false;
    },
  );

  // Remove the widget from the DOM and clean up resources.
  function removeWidget(): void {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    cleanupWebcam();
    host.remove();
  }
}
