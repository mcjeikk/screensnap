/**
 * ScreenSnap — Recording Controls (Content Script)
 * Injects a floating widget into the page showing timer, pause, stop, mute controls.
 * Communicates with the background service worker.
 */

(function () {
  // Prevent double injection
  if (document.getElementById('screensnap-recording-widget')) return;

  // Inject CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('recorder/recording-controls.css');
  document.head.appendChild(link);

  // Create widget
  const widget = document.createElement('div');
  widget.id = 'screensnap-recording-widget';
  widget.innerHTML = `
    <span class="ssw-rec-dot"></span>
    <span class="ssw-timer">00:00</span>
    <span class="ssw-divider"></span>
    <button class="ssw-pause" title="Pause">⏸️</button>
    <button class="ssw-mute" title="Mute mic">🎤</button>
    <button class="ssw-stop" title="Stop recording">⏹ Stop</button>
  `;
  document.body.appendChild(widget);

  // State
  let isPaused = false;
  let isMuted = false;
  let startTime = Date.now();
  let timerInterval = null;

  // Timer
  const timerEl = widget.querySelector('.ssw-timer');
  const recDot = widget.querySelector('.ssw-rec-dot');

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
  }

  timerInterval = setInterval(updateTimer, 1000);

  // Pause/Resume
  widget.querySelector('.ssw-pause').addEventListener('click', (e) => {
    e.stopPropagation();
    isPaused = !isPaused;
    const btn = widget.querySelector('.ssw-pause');

    if (isPaused) {
      btn.textContent = '▶️';
      btn.title = 'Resume';
      recDot.classList.add('paused');
      clearInterval(timerInterval);
      chrome.runtime.sendMessage({ action: 'widget-pause' });
    } else {
      btn.textContent = '⏸️';
      btn.title = 'Pause';
      recDot.classList.remove('paused');
      timerInterval = setInterval(updateTimer, 1000);
      chrome.runtime.sendMessage({ action: 'widget-resume' });
    }
  });

  // Mute/Unmute
  widget.querySelector('.ssw-mute').addEventListener('click', (e) => {
    e.stopPropagation();
    isMuted = !isMuted;
    const btn = widget.querySelector('.ssw-mute');
    btn.textContent = isMuted ? '🔇' : '🎤';
    btn.title = isMuted ? 'Unmute mic' : 'Mute mic';
    chrome.runtime.sendMessage({ action: 'widget-mute', muted: isMuted });
  });

  // Stop
  widget.querySelector('.ssw-stop').addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'widget-stop' });
    removeWidget();
  });

  // Dragging
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
    widget.style.left = (e.clientX - dragOffsetX) + 'px';
    widget.style.top = (e.clientY - dragOffsetY) + 'px';
    widget.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    widget.style.cursor = 'grab';
  });

  // Listen for removal command
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'remove-recording-widget') {
      removeWidget();
    }
  });

  function removeWidget() {
    clearInterval(timerInterval);
    widget.remove();
    link.remove();
  }
})();
