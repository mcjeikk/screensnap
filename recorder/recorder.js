/**
 * @file ScreenSnap — Recorder Script v0.5.0
 * @description Handles recording configuration, stream setup, MediaRecorder management,
 * PiP canvas compositing, and audio controls. Runs inside recorder.html as the
 * recording hub (MV3 compatible). Ensures all MediaStreams and resources are
 * properly cleaned up on stop/error.
 * @version 0.5.0
 */

(() => {
  'use strict';

  // ── Constants ───────────────────────────────────
  const LOG_PREFIX = '[ScreenSnap][Recorder]';
  const VIDEO_BITRATE = 5_000_000;
  const PIP_CANVAS_FPS = 30;
  const PIP_MARGIN = 20;
  const MEDIA_RECORDER_TIMESLICE_MS = 1000;
  const COUNTDOWN_SECONDS = 3;
  const RECORDING_CHUNK_SIZE = 5 * 1024 * 1024;

  const PIP_SIZES = Object.freeze({ small: 120, medium: 180, large: 240 });

  const RESOLUTION_PRESETS = Object.freeze({
    720: { width: 1280, height: 720 },
    1080: { width: 1920, height: 1080 },
    2160: { width: 3840, height: 2160 },
  });

  // ── State ───────────────────────────────────────
  /** @type {string} Current recording source */
  let currentSource = 'tab';

  /** @type {MediaRecorder|null} */
  let mediaRecorder = null;

  /** @type {Blob[]} */
  let recordedChunks = [];

  /** @type {number} */
  let recordingStartTime = 0;

  /** @type {number|null} */
  let timerInterval = null;

  /** @type {boolean} */
  let isPaused = false;

  /** @type {boolean} */
  let isMicMuted = false;

  /** @type {number} Total milliseconds spent in paused state */
  let pausedDuration = 0;

  /** @type {number} Timestamp when current pause started */
  let pauseStartTime = 0;

  // Streams
  /** @type {MediaStream|null} */
  let mainStream = null;
  /** @type {MediaStream|null} */
  let micStream = null;
  /** @type {MediaStream|null} */
  let webcamStream = null;
  /** @type {MediaStream|null} */
  let combinedStream = null;
  /** @type {number|null} */
  let pipAnimFrame = null;

  // Audio
  /** @type {AudioContext|null} */
  let audioContext = null;
  /** @type {AnalyserNode|null} */
  let micAnalyser = null;
  /** @type {GainNode|null} */
  let micGainNode = null;
  /** @type {number|null} */
  let meterAnimFrame = null;

  // ── Init ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    await checkExistingRecording();
    initSourceFromURL();
    bindSourceButtons();
    bindToggles();
    bindRecordingControls();
    document.getElementById('btn-start').addEventListener('click', startRecordingFlow);
  });

  /**
   * Check if a recording is already in progress and disable start button if so.
   */
  async function checkExistingRecording() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-recording-status' });
      if (response?.isRecording) {
        showError('A recording is already in progress. Stop it before starting a new one.');
        document.getElementById('btn-start').disabled = true;
      }
    } catch {
      // Service worker may not be ready — proceed normally
    }
  }

  /**
   * Read ?source= URL param and pre-select the recording source.
   */
  function initSourceFromURL() {
    const params = new URLSearchParams(window.location.search);
    const source = params.get('source');
    if (source && ['tab', 'screen', 'camera'].includes(source)) {
      selectSource(source);
    }
  }

  /**
   * Bind click handlers to source selection buttons.
   */
  function bindSourceButtons() {
    document.querySelectorAll('.source-btn').forEach(btn => {
      btn.addEventListener('click', () => selectSource(btn.dataset.source));
    });
  }

  /**
   * Select a recording source and update UI state.
   * @param {string} source - 'tab' | 'screen' | 'camera'
   */
  function selectSource(source) {
    currentSource = source;
    document.querySelectorAll('.source-btn').forEach(btn => {
      const isActive = btn.dataset.source === source;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    // Show/hide PiP section (not for camera-only)
    document.getElementById('pip-section').style.display = source === 'camera' ? 'none' : 'block';

    // Show/hide system audio row (not for camera-only)
    document.getElementById('system-audio-row').style.display = source === 'camera' ? 'none' : 'flex';

    updateCameraPreview();
  }

  /**
   * Bind toggle checkboxes for PiP and microphone.
   */
  function bindToggles() {
    document.getElementById('opt-pip').addEventListener('change', (e) => {
      document.getElementById('pip-options').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('opt-mic').addEventListener('change', (e) => {
      if (e.target.checked) {
        startMicPreview();
      } else {
        stopMicPreview();
      }
    });

    if (document.getElementById('opt-mic').checked) {
      startMicPreview();
    }
  }

  /**
   * Bind recording control buttons (pause, mute, stop).
   */
  function bindRecordingControls() {
    document.getElementById('btn-pause').addEventListener('click', togglePause);
    document.getElementById('btn-mute').addEventListener('click', toggleMute);
    document.getElementById('btn-stop').addEventListener('click', stopRecording);
  }

  // ── Camera Preview ──────────────────────────────

  /**
   * Show or hide the camera preview based on selected source.
   */
  async function updateCameraPreview() {
    const container = document.getElementById('camera-preview-container');
    const video = document.getElementById('camera-preview');

    // Stop any existing preview stream
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }

    if (currentSource === 'camera') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = stream;
        container.style.display = 'block';
      } catch (err) {
        container.style.display = 'none';
        showError(`Camera access denied: ${err.message}`);
      }
    } else {
      container.style.display = 'none';
    }
  }

  // ── Mic Preview / Audio Meter ───────────────────

  /**
   * Start microphone preview with audio level meter.
   */
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

      micStream = stream;
    } catch (err) {
      console.warn(LOG_PREFIX, 'Mic preview failed:', err);
    }
  }

  /**
   * Stop microphone preview and clean up resources.
   */
  function stopMicPreview() {
    if (meterAnimFrame) {
      cancelAnimationFrame(meterAnimFrame);
      meterAnimFrame = null;
    }

    document.getElementById('audio-meter-container').style.display = 'none';

    if (micStream && !mediaRecorder) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    if (audioContext && !mediaRecorder) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  /**
   * Animate the audio level meter using requestAnimationFrame.
   */
  function animateMeter() {
    if (!micAnalyser) return;
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    micAnalyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const pct = Math.min(100, (avg / 128) * 100);
    document.getElementById('audio-meter-bar').style.width = `${pct}%`;
    meterAnimFrame = requestAnimationFrame(animateMeter);
  }

  // ── Recording Flow ────────────────────────────────

  /**
   * Main recording flow: acquire streams, countdown, start MediaRecorder.
   */
  async function startRecordingFlow() {
    hideError();

    try {
      // Stop camera preview stream
      const previewVideo = document.getElementById('camera-preview');
      if (previewVideo.srcObject) {
        previewVideo.srcObject.getTracks().forEach(t => t.stop());
        previewVideo.srcObject = null;
      }

      mainStream = await getMainStream();
      if (!mainStream) return;

      // Get mic stream if requested
      if (document.getElementById('opt-mic').checked) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          console.warn(LOG_PREFIX, 'Mic denied:', err);
        }
      }

      // Get webcam for PiP if requested
      const usePiP = document.getElementById('opt-pip').checked && currentSource !== 'camera';
      if (usePiP) {
        try {
          webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 320 },
            audio: false,
          });
        } catch (err) {
          console.warn(LOG_PREFIX, 'Webcam for PiP denied:', err);
        }
      }

      combinedStream = buildCombinedStream(mainStream, micStream, webcamStream, usePiP);

      if (document.getElementById('opt-countdown').checked) {
        await runCountdown();
      }

      startMediaRecorder(combinedStream);
      showRecordingPanel();
      chrome.runtime.sendMessage({ action: 'recording-started' });

    } catch (err) {
      showError(`Recording failed: ${err.message}`);
      cleanupStreams();
    }
  }

  /**
   * Get the main capture stream based on the selected source.
   * @returns {Promise<MediaStream|null>}
   */
  async function getMainStream() {
    const resolution = parseInt(document.getElementById('opt-resolution').value, 10);
    const constraints = getResolutionConstraints(resolution);
    const includeSystemAudio = document.getElementById('opt-system-audio')?.checked ?? false;

    switch (currentSource) {
      case 'tab': return getTabStream(constraints, includeSystemAudio);
      case 'screen': return getScreenStream(constraints, includeSystemAudio);
      case 'camera': return getCameraStream(constraints);
      default: throw new Error(`Unknown source: ${currentSource}`);
    }
  }

  /**
   * Get video constraints for the given resolution preset.
   * @param {number} resolution - Resolution value (720, 1080, 2160)
   * @returns {Object} Media constraints
   */
  function getResolutionConstraints(resolution) {
    const preset = RESOLUTION_PRESETS[resolution] || RESOLUTION_PRESETS[1080];
    return { width: { ideal: preset.width }, height: { ideal: preset.height } };
  }

  /**
   * Capture the current tab via chrome.tabCapture API.
   * @param {Object} constraints - Video resolution constraints
   * @param {boolean} includeAudio - Whether to capture tab audio
   * @returns {Promise<MediaStream>}
   */
  async function getTabStream(constraints, includeAudio) {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: undefined }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    return navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          ...constraints,
        },
      },
      audio: includeAudio ? {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } : false,
    });
  }

  /**
   * Capture screen/window via desktopCapture API.
   * @param {Object} constraints - Video resolution constraints
   * @param {boolean} includeAudio - Whether to capture system audio
   * @returns {Promise<MediaStream>}
   */
  async function getScreenStream(constraints, includeAudio) {
    const response = await chrome.runtime.sendMessage({ action: 'request-desktop-capture' });
    if (!response?.success || !response.streamId) {
      throw new Error(response?.error || 'Desktop capture was cancelled');
    }

    return navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: response.streamId,
          ...constraints,
        },
      },
      audio: includeAudio ? {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: response.streamId,
        },
      } : false,
    });
  }

  /**
   * Capture camera-only stream.
   * @param {Object} constraints - Video resolution constraints
   * @returns {Promise<MediaStream>}
   */
  async function getCameraStream(constraints) {
    return navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  }

  // ── Stream Combining ──────────────────────────────

  /**
   * Build the final combined stream with video, PiP overlay, and all audio tracks.
   * @param {MediaStream} main - Main video/audio stream
   * @param {MediaStream|null} mic - Microphone audio stream
   * @param {MediaStream|null} webcam - Webcam video for PiP
   * @param {boolean} usePiP - Whether PiP compositing is enabled
   * @returns {MediaStream} Combined stream for MediaRecorder
   */
  function buildCombinedStream(main, mic, webcam, usePiP) {
    let videoStream = main;

    if (usePiP && webcam) {
      videoStream = createPiPStream(main, webcam);
    }

    const audioTracks = [];

    // Main stream audio (tab/system audio)
    main.getAudioTracks().forEach(t => audioTracks.push(t));

    // Mic audio with gain control for mute
    if (mic) {
      if (!audioContext) audioContext = new AudioContext();
      const micSource = audioContext.createMediaStreamSource(mic);
      micGainNode = audioContext.createGain();
      micGainNode.gain.value = 1.0;

      micAnalyser = audioContext.createAnalyser();
      micAnalyser.fftSize = 256;
      micSource.connect(micGainNode);
      micGainNode.connect(micAnalyser);

      const dest = audioContext.createMediaStreamDestination();
      micGainNode.connect(dest);
      dest.stream.getAudioTracks().forEach(t => audioTracks.push(t));
    }

    return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
  }

  /**
   * Create a PiP composited stream using Canvas.
   * Draws main video with a circular webcam bubble overlay.
   * @param {MediaStream} mainVideoStream - Screen/tab video stream
   * @param {MediaStream} webcamVideoStream - Webcam video stream
   * @returns {MediaStream} Canvas-captured stream with composited video
   */
  function createPiPStream(mainVideoStream, webcamVideoStream) {
    const canvas = document.getElementById('pip-canvas');
    const screenVideo = document.getElementById('pip-screen');
    const camVideo = document.getElementById('pip-webcam');

    const mainTrack = mainVideoStream.getVideoTracks()[0];
    const settings = mainTrack.getSettings();
    canvas.width = settings.width || 1920;
    canvas.height = settings.height || 1080;

    screenVideo.srcObject = new MediaStream([mainTrack]);
    camVideo.srcObject = webcamVideoStream;

    const ctx = canvas.getContext('2d');

    const position = document.getElementById('pip-position').value;
    const sizeStr = document.getElementById('pip-size').value;
    const bubbleSize = PIP_SIZES[sizeStr] || PIP_SIZES.medium;

    /**
     * Calculate bubble position based on user preference.
     * @returns {{x: number, y: number}}
     */
    function getBubblePos() {
      const w = canvas.width;
      const h = canvas.height;
      switch (position) {
        case 'top-left': return { x: PIP_MARGIN, y: PIP_MARGIN };
        case 'top-right': return { x: w - bubbleSize - PIP_MARGIN, y: PIP_MARGIN };
        case 'bottom-left': return { x: PIP_MARGIN, y: h - bubbleSize - PIP_MARGIN };
        default: return { x: w - bubbleSize - PIP_MARGIN, y: h - bubbleSize - PIP_MARGIN };
      }
    }

    /** Draw a single composited frame. */
    function drawFrame() {
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      const pos = getBubblePos();
      ctx.save();
      ctx.beginPath();
      ctx.arc(pos.x + bubbleSize / 2, pos.y + bubbleSize / 2, bubbleSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(camVideo, pos.x, pos.y, bubbleSize, bubbleSize);
      ctx.restore();

      // Border ring
      ctx.beginPath();
      ctx.arc(pos.x + bubbleSize / 2, pos.y + bubbleSize / 2, bubbleSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 3;
      ctx.stroke();

      pipAnimFrame = requestAnimationFrame(drawFrame);
    }

    drawFrame();
    return canvas.captureStream(PIP_CANVAS_FPS);
  }

  // ── Countdown ───────────────────────────────────

  /**
   * Show a 3-2-1 countdown overlay before recording starts.
   * @returns {Promise<void>}
   */
  function runCountdown() {
    return new Promise(resolve => {
      const overlay = document.getElementById('countdown-overlay');
      const number = document.getElementById('countdown-number');
      overlay.style.display = 'flex';

      let count = COUNTDOWN_SECONDS;
      number.textContent = count;

      const interval = setInterval(() => {
        count--;
        if (count <= 0) {
          clearInterval(interval);
          overlay.style.display = 'none';
          resolve();
        } else {
          number.textContent = count;
          // Re-trigger CSS animation
          number.style.animation = 'none';
          void number.offsetHeight; // force reflow
          number.style.animation = '';
        }
      }, 1000);
    });
  }

  // ── MediaRecorder ─────────────────────────────────

  /**
   * Configure and start the MediaRecorder.
   * @param {MediaStream} stream - The combined media stream to record
   */
  function startMediaRecorder(stream) {
    recordedChunks = [];

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITRATE,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => onRecordingStopped();

    // Handle stream ending (user stops screen share)
    stream.getVideoTracks().forEach(track => {
      track.onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          stopRecording();
        }
      };
    });

    mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
    recordingStartTime = Date.now();
    pausedDuration = 0;
    pauseStartTime = 0;
    startTimer();
  }

  // ── Recording Controls ────────────────────────────

  /** Toggle pause/resume on the recording. Tracks paused duration for accurate timer. */
  function togglePause() {
    if (!mediaRecorder) return;
    const btn = document.getElementById('btn-pause');

    if (isPaused) {
      pausedDuration += Date.now() - pauseStartTime;
      mediaRecorder.resume();
      isPaused = false;
      btn.textContent = '\u23F8\uFE0F Pause';
      startTimer();
      chrome.runtime.sendMessage({ action: 'recording-resumed' });
    } else {
      pauseStartTime = Date.now();
      mediaRecorder.pause();
      isPaused = true;
      btn.textContent = '\u25B6\uFE0F Resume';
      clearInterval(timerInterval);
      chrome.runtime.sendMessage({ action: 'recording-paused' });
    }
  }

  /** Toggle microphone mute/unmute. */
  function toggleMute() {
    if (!micGainNode) return;
    const btn = document.getElementById('btn-mute');

    isMicMuted = !isMicMuted;
    micGainNode.gain.value = isMicMuted ? 0 : 1;
    btn.textContent = isMicMuted ? '\uD83D\uDD07 Unmute' : '\uD83C\uDFA4 Mute';
  }

  /** Stop the recording and notify the service worker. */
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    clearInterval(timerInterval);
    chrome.runtime.sendMessage({ action: 'recording-stopped' });
  }

  /** Handle MediaRecorder stop event: assemble blob and open preview. */
  function onRecordingStopped() {
    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
    const duration = Date.now() - recordingStartTime;

    cleanupStreams();
    openPreview(blob, duration);
  }

  // ── Timer ─────────────────────────────────────────

  /** Start the recording timer display. */
  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }

  /**
   * Update the timer display, accounting for paused duration.
   */
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime - pausedDuration) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    document.getElementById('rec-timer').textContent = `${mm}:${ss}`;
  }

  // ── UI State ──────────────────────────────────────

  /** Switch from config panel to recording panel. */
  function showRecordingPanel() {
    document.getElementById('config-panel').style.display = 'none';
    document.getElementById('recording-panel').style.display = 'block';

    const labels = { tab: 'Tab Recording', screen: 'Screen Recording', camera: 'Camera Recording' };
    document.getElementById('rec-source-label').textContent = labels[currentSource] || '';
  }

  /**
   * Show an error message in the config panel.
   * @param {string} msg - Error message to display
   */
  function showError(msg) {
    const el = document.getElementById('error-msg');
    el.textContent = `\u26A0\uFE0F ${msg}`;
    el.style.display = 'block';
  }

  /** Hide the error message. */
  function hideError() {
    document.getElementById('error-msg').style.display = 'none';
  }

  // ── Preview ───────────────────────────────────────

  /**
   * Store the recording blob in chrome.storage and open the preview page.
   * @param {Blob} blob - Recorded video blob
   * @param {number} duration - Recording duration in ms
   */
  async function openPreview(blob, duration) {
    const blobUrl = URL.createObjectURL(blob);

    await chrome.storage.local.set({
      pendingRecording: {
        blobUrl,
        duration,
        size: blob.size,
        mimeType: blob.type,
        timestamp: Date.now(),
      },
    });

    // Serialize blob to storage chunks (up to ~500MB)
    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const totalChunks = Math.ceil(uint8.length / RECORDING_CHUNK_SIZE);

    const storageOps = {
      'recording-chunks-count': totalChunks,
      'recording-mime': blob.type,
    };

    for (let i = 0; i < totalChunks; i++) {
      const start = i * RECORDING_CHUNK_SIZE;
      const end = Math.min(start + RECORDING_CHUNK_SIZE, uint8.length);
      storageOps[`recording-chunk-${i}`] = Array.from(uint8.slice(start, end));
    }

    await chrome.storage.local.set(storageOps);

    // Revoke blob URL since data is now in storage
    URL.revokeObjectURL(blobUrl);

    chrome.tabs.create({ url: chrome.runtime.getURL('recorder/preview.html') });
  }

  // ── Cleanup ───────────────────────────────────────

  /**
   * Stop all media streams, cancel animation frames, and close audio context.
   * CRITICAL: Always call this when recording ends to prevent memory leaks.
   */
  function cleanupStreams() {
    if (pipAnimFrame) {
      cancelAnimationFrame(pipAnimFrame);
      pipAnimFrame = null;
    }
    if (meterAnimFrame) {
      cancelAnimationFrame(meterAnimFrame);
      meterAnimFrame = null;
    }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

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

    micAnalyser = null;
    micGainNode = null;
  }

  // ── External Stop Command Listener ────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') {
      sendResponse({ success: false });
      return false;
    }

    switch (message.action) {
      case 'stop-recording':
        stopRecording();
        sendResponse({ success: true });
        break;
      case 'toggle-pause':
        togglePause();
        sendResponse({ success: true });
        break;
      case 'toggle-mute':
        toggleMute();
        sendResponse({ success: true });
        break;
      default:
        // Do NOT respond to unknown messages — prevents race condition
        // with offscreen document clipboard operations (other listeners
        // responding synchronously would override the async offscreen response)
        return false;
    }
    return false;
  });
})();
