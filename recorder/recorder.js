/**
 * ScreenSnap — Recorder Script
 * Handles recording configuration, stream setup, MediaRecorder, and PiP compositing.
 * Runs inside recorder.html as the recording hub (MV3 compatible).
 */

// ── State ───────────────────────────────────────────
let currentSource = 'tab';
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let timerInterval = null;
let isPaused = false;
let isMicMuted = false;

// Streams
let mainStream = null;      // Screen/tab/camera stream
let micStream = null;        // Microphone audio stream
let webcamStream = null;     // Webcam for PiP
let combinedStream = null;   // Final stream fed to MediaRecorder
let pipAnimFrame = null;     // Canvas animation frame for PiP

// Audio
let audioContext = null;
let micAnalyser = null;
let micGainNode = null;
let meterAnimFrame = null;

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSourceFromURL();
  bindSourceButtons();
  bindToggles();
  bindRecordingControls();
  document.getElementById('btn-start').addEventListener('click', startRecordingFlow);
});

/** Read ?source= param and pre-select */
function initSourceFromURL() {
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  if (source && ['tab', 'screen', 'camera'].includes(source)) {
    selectSource(source);
  }
}

/** Bind source button clicks */
function bindSourceButtons() {
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => selectSource(btn.dataset.source));
  });
}

/** Select a recording source and update UI */
function selectSource(source) {
  currentSource = source;
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === source);
  });

  // Show/hide PiP section (not for camera-only)
  const pipSection = document.getElementById('pip-section');
  pipSection.style.display = source === 'camera' ? 'none' : 'block';

  // Show/hide system audio row (not for camera-only)
  const sysAudioRow = document.getElementById('system-audio-row');
  sysAudioRow.style.display = source === 'camera' ? 'none' : 'flex';

  // Show camera preview for camera source
  updateCameraPreview();
}

/** Bind toggle checkboxes */
function bindToggles() {
  // PiP toggle
  document.getElementById('opt-pip').addEventListener('change', (e) => {
    document.getElementById('pip-options').style.display = e.target.checked ? 'block' : 'none';
  });

  // Mic toggle — show audio meter when enabled
  document.getElementById('opt-mic').addEventListener('change', (e) => {
    if (e.target.checked) {
      startMicPreview();
    } else {
      stopMicPreview();
    }
  });

  // Start mic preview if mic is checked by default
  if (document.getElementById('opt-mic').checked) {
    startMicPreview();
  }
}

/** Bind recording control buttons */
function bindRecordingControls() {
  document.getElementById('btn-pause').addEventListener('click', togglePause);
  document.getElementById('btn-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-stop').addEventListener('click', stopRecording);
}

// ── Camera Preview ──────────────────────────────────
async function updateCameraPreview() {
  const container = document.getElementById('camera-preview-container');
  const video = document.getElementById('camera-preview');

  if (currentSource === 'camera') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = stream;
      container.style.display = 'block';
    } catch (err) {
      container.style.display = 'none';
      showError('Camera access denied: ' + err.message);
    }
  } else {
    // Stop any existing preview
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    container.style.display = 'none';
  }
}

// ── Mic Preview / Audio Meter ───────────────────────
async function startMicPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    source.connect(micAnalyser);

    document.getElementById('audio-meter-container').style.display = 'block';
    animateMeter();

    // Keep ref to stop later
    micStream = stream;
  } catch (err) {
    console.warn('[ScreenSnap] Mic preview failed:', err);
  }
}

function stopMicPreview() {
  if (meterAnimFrame) cancelAnimationFrame(meterAnimFrame);
  document.getElementById('audio-meter-container').style.display = 'none';
  if (micStream && !mediaRecorder) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioContext && !mediaRecorder) {
    audioContext.close();
    audioContext = null;
  }
}

function animateMeter() {
  if (!micAnalyser) return;
  const data = new Uint8Array(micAnalyser.frequencyBinCount);
  micAnalyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const pct = Math.min(100, (avg / 128) * 100);
  document.getElementById('audio-meter-bar').style.width = pct + '%';
  meterAnimFrame = requestAnimationFrame(animateMeter);
}

// ── Recording Flow ──────────────────────────────────
async function startRecordingFlow() {
  hideError();

  try {
    // Stop camera preview if running
    const previewVideo = document.getElementById('camera-preview');
    if (previewVideo.srcObject) {
      previewVideo.srcObject.getTracks().forEach(t => t.stop());
      previewVideo.srcObject = null;
    }

    // Get the main stream based on source
    mainStream = await getMainStream();
    if (!mainStream) return;

    // Get mic stream if requested
    const useMic = document.getElementById('opt-mic').checked;
    if (useMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('[ScreenSnap] Mic denied:', err);
      }
    }

    // Get webcam stream for PiP if requested
    const usePiP = document.getElementById('opt-pip').checked && currentSource !== 'camera';
    if (usePiP) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 320 },
          audio: false
        });
      } catch (err) {
        console.warn('[ScreenSnap] Webcam for PiP denied:', err);
      }
    }

    // Build the final combined stream
    combinedStream = buildCombinedStream(mainStream, micStream, webcamStream, usePiP);

    // Countdown
    const useCountdown = document.getElementById('opt-countdown').checked;
    if (useCountdown) {
      await runCountdown();
    }

    // Start recording
    startMediaRecorder(combinedStream);

    // Update UI
    showRecordingPanel();

    // Notify service worker — set badge
    chrome.runtime.sendMessage({ action: 'recording-started' });

  } catch (err) {
    showError('Recording failed: ' + err.message);
    cleanupStreams();
  }
}

/** Get the main capture stream based on selected source */
async function getMainStream() {
  const resolution = parseInt(document.getElementById('opt-resolution').value);
  const constraints = getResolutionConstraints(resolution);
  const includeSystemAudio = document.getElementById('opt-system-audio')?.checked;

  switch (currentSource) {
    case 'tab':
      return await getTabStream(constraints, includeSystemAudio);
    case 'screen':
      return await getScreenStream(constraints, includeSystemAudio);
    case 'camera':
      return await getCameraStream(constraints);
    default:
      throw new Error('Unknown source: ' + currentSource);
  }
}

/** Get resolution constraints */
function getResolutionConstraints(resolution) {
  switch (resolution) {
    case 720: return { width: { ideal: 1280 }, height: { ideal: 720 } };
    case 2160: return { width: { ideal: 3840 }, height: { ideal: 2160 } };
    default: return { width: { ideal: 1920 }, height: { ideal: 1080 } };
  }
}

/** Capture current tab via tabCapture */
async function getTabStream(constraints, includeAudio) {
  // tabCapture.getMediaStreamId works from extension pages after user gesture
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: undefined }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        ...constraints
      }
    },
    audio: includeAudio ? {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } : false
  });

  return stream;
}

/** Capture screen/window via desktopCapture (through service worker) */
async function getScreenStream(constraints, includeAudio) {
  // Ask service worker to show desktop capture picker
  const response = await chrome.runtime.sendMessage({ action: 'request-desktop-capture' });

  if (!response?.success || !response.streamId) {
    throw new Error(response?.error || 'Desktop capture was cancelled');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: response.streamId,
        ...constraints
      }
    },
    audio: includeAudio ? {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: response.streamId
      }
    } : false
  });

  return stream;
}

/** Capture camera only */
async function getCameraStream(constraints) {
  return await navigator.mediaDevices.getUserMedia({
    video: constraints,
    audio: false // Audio handled separately via mic toggle
  });
}

// ── Stream Combining ────────────────────────────────

/**
 * Build the final combined stream with all audio tracks and optional PiP.
 */
function buildCombinedStream(main, mic, webcam, usePiP) {
  let videoStream = main;

  // If PiP enabled, composite webcam onto main video via canvas
  if (usePiP && webcam) {
    videoStream = createPiPStream(main, webcam);
  }

  // Combine all audio tracks
  const audioTracks = [];

  // Main stream audio (tab/system audio)
  main.getAudioTracks().forEach(t => audioTracks.push(t));

  // Mic audio
  if (mic) {
    // Create gain node for mute control
    if (!audioContext) audioContext = new AudioContext();
    const micSource = audioContext.createMediaStreamSource(mic);
    micGainNode = audioContext.createGain();
    micGainNode.gain.value = 1.0;

    // Also set up analyser for meter during recording
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    micSource.connect(micGainNode);
    micGainNode.connect(micAnalyser);

    const dest = audioContext.createMediaStreamDestination();
    micGainNode.connect(dest);
    dest.stream.getAudioTracks().forEach(t => audioTracks.push(t));
  }

  // Build final stream
  const finalTracks = [...videoStream.getVideoTracks(), ...audioTracks];
  return new MediaStream(finalTracks);
}

/**
 * Create a PiP composited stream using Canvas.
 * Draws main video with webcam bubble overlay.
 */
function createPiPStream(mainVideoStream, webcamVideoStream) {
  const canvas = document.getElementById('pip-canvas');
  const screenVideo = document.getElementById('pip-screen');
  const camVideo = document.getElementById('pip-webcam');

  // Set canvas size from main stream
  const mainTrack = mainVideoStream.getVideoTracks()[0];
  const settings = mainTrack.getSettings();
  canvas.width = settings.width || 1920;
  canvas.height = settings.height || 1080;

  // Feed videos
  screenVideo.srcObject = new MediaStream([mainTrack]);
  camVideo.srcObject = webcamVideoStream;

  const ctx = canvas.getContext('2d');

  // PiP config
  const position = document.getElementById('pip-position').value;
  const sizeStr = document.getElementById('pip-size').value;
  const bubbleSize = sizeStr === 'small' ? 120 : sizeStr === 'large' ? 240 : 180;
  const margin = 20;

  function getBubblePos() {
    const w = canvas.width;
    const h = canvas.height;
    switch (position) {
      case 'top-left': return { x: margin, y: margin };
      case 'top-right': return { x: w - bubbleSize - margin, y: margin };
      case 'bottom-left': return { x: margin, y: h - bubbleSize - margin };
      default: return { x: w - bubbleSize - margin, y: h - bubbleSize - margin };
    }
  }

  function drawFrame() {
    // Draw main screen
    ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

    // Draw webcam bubble (circular)
    const pos = getBubblePos();
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x + bubbleSize / 2, pos.y + bubbleSize / 2, bubbleSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(camVideo, pos.x, pos.y, bubbleSize, bubbleSize);
    ctx.restore();

    // Draw border around bubble
    ctx.beginPath();
    ctx.arc(pos.x + bubbleSize / 2, pos.y + bubbleSize / 2, bubbleSize / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();

    pipAnimFrame = requestAnimationFrame(drawFrame);
  }

  drawFrame();

  // Capture canvas as video stream
  const fps = 30;
  return canvas.captureStream(fps);
}

// ── Countdown ───────────────────────────────────────
function runCountdown() {
  return new Promise(resolve => {
    const overlay = document.getElementById('countdown-overlay');
    const number = document.getElementById('countdown-number');
    overlay.style.display = 'flex';

    let count = 3;
    number.textContent = count;

    const interval = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(interval);
        overlay.style.display = 'none';
        resolve();
      } else {
        number.textContent = count;
        // Re-trigger animation
        number.style.animation = 'none';
        number.offsetHeight; // force reflow
        number.style.animation = '';
      }
    }, 1000);
  });
}

// ── MediaRecorder ───────────────────────────────────

function startMediaRecorder(stream) {
  recordedChunks = [];

  // Prefer VP9 + Opus for best quality, fallback to VP8
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000, // 5 Mbps
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = () => {
    onRecordingStopped();
  };

  // Handle stream end (user stops sharing)
  stream.getVideoTracks().forEach(track => {
    track.onended = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        stopRecording();
      }
    };
  });

  mediaRecorder.start(1000); // Collect data every second
  recordingStartTime = Date.now();
  startTimer();
}

// ── Recording Controls ──────────────────────────────

function togglePause() {
  if (!mediaRecorder) return;
  const btn = document.getElementById('btn-pause');

  if (isPaused) {
    mediaRecorder.resume();
    isPaused = false;
    btn.textContent = '⏸️ Pause';
    startTimer();
    chrome.runtime.sendMessage({ action: 'recording-resumed' });
  } else {
    mediaRecorder.pause();
    isPaused = true;
    btn.textContent = '▶️ Resume';
    clearInterval(timerInterval);
    chrome.runtime.sendMessage({ action: 'recording-paused' });
  }
}

function toggleMute() {
  if (!micGainNode) return;
  const btn = document.getElementById('btn-mute');

  isMicMuted = !isMicMuted;
  micGainNode.gain.value = isMicMuted ? 0 : 1;
  btn.textContent = isMicMuted ? '🔇 Unmute' : '🎤 Mute';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  clearInterval(timerInterval);
  chrome.runtime.sendMessage({ action: 'recording-stopped' });
}

function onRecordingStopped() {
  const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
  const duration = Date.now() - recordingStartTime;

  // Clean up all streams
  cleanupStreams();

  // Store blob and open preview
  openPreview(blob, duration);
}

// ── Timer ───────────────────────────────────────────
function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  document.getElementById('rec-timer').textContent = `${mm}:${ss}`;
}

// ── UI State ────────────────────────────────────────
function showRecordingPanel() {
  document.getElementById('config-panel').style.display = 'none';
  document.getElementById('recording-panel').style.display = 'block';

  const labels = { tab: 'Tab Recording', screen: 'Screen Recording', camera: 'Camera Recording' };
  document.getElementById('rec-source-label').textContent = labels[currentSource] || '';
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = '⚠️ ' + msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('error-msg').style.display = 'none';
}

// ── Preview ─────────────────────────────────────────
async function openPreview(blob, duration) {
  // Store blob as base64 in storage (for small files) or use blob URL approach
  // Since blob URLs don't work across tabs in MV3, we use chrome.storage.session
  // or objectURL in the same origin (extension pages share origin)
  const blobUrl = URL.createObjectURL(blob);

  // Store metadata
  await chrome.storage.local.set({
    pendingRecording: {
      blobUrl,  // Won't work cross-tab, but preview.html will re-fetch from stored chunks
      duration,
      size: blob.size,
      mimeType: blob.type,
      timestamp: Date.now()
    }
  });

  // Store actual blob data as array buffer in session storage (up to ~500MB)
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // Split into chunks for chrome.storage.local (max 10MB per item in some browsers)
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(uint8.length / CHUNK_SIZE);

  const storageOps = { 'recording-chunks-count': totalChunks, 'recording-mime': blob.type };
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, uint8.length);
    const chunk = uint8.slice(start, end);
    // Convert to regular array for JSON serialization
    storageOps[`recording-chunk-${i}`] = Array.from(chunk);
  }

  await chrome.storage.local.set(storageOps);

  // Open preview tab
  chrome.tabs.create({
    url: chrome.runtime.getURL('recorder/preview.html')
  });
}

// ── Cleanup ─────────────────────────────────────────
function cleanupStreams() {
  if (pipAnimFrame) cancelAnimationFrame(pipAnimFrame);
  if (meterAnimFrame) cancelAnimationFrame(meterAnimFrame);
  if (timerInterval) clearInterval(timerInterval);

  [mainStream, micStream, webcamStream, combinedStream].forEach(stream => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
  });

  mainStream = null;
  micStream = null;
  webcamStream = null;
  combinedStream = null;

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

// ── Listen for external stop command ────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'stop-recording') {
    stopRecording();
    sendResponse({ success: true });
  }
  return true;
});
