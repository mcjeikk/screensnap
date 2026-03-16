/**
 * @file ScreenBolt — Recording Offscreen Document
 * @description Runs MediaRecorder in an offscreen document context.
 * Receives a streamId and config from the service worker, acquires the
 * real MediaStream, records it, and serializes the result to chrome.storage.
 * Handles audio mixing (mic + tab/system audio) via AudioContext.
 * @version 0.7.0
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[ScreenBolt][OffscreenRecorder]';
  const VIDEO_BITRATE = 5_000_000;
  const PIP_CANVAS_FPS = 30;
  const PIP_MARGIN = 20;
  const MEDIA_RECORDER_TIMESLICE_MS = 1000;
  const RECORDING_CHUNK_SIZE = 5 * 1024 * 1024;
  const PIP_SIZES = Object.freeze({ small: 120, medium: 180, large: 240 });

  // ── State ───────────────────────────────────────
  /** @type {MediaRecorder|null} */
  let mediaRecorder = null;

  /** @type {Blob[]} */
  let recordedChunks = [];

  /** @type {number} */
  let recordingStartTime = 0;

  /** @type {boolean} */
  let isPaused = false;

  /** @type {number} Total ms in paused state */
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
  /** @type {GainNode|null} */
  let micGainNode = null;

  // ── Message Listener ────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    switch (message.action) {
      case 'offscreen-start-recording':
        handleStartRecording(message.config)
          .then(() => sendResponse({ success: true }))
          .catch((err) => {
            console.error(LOG_PREFIX, 'Start recording failed:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true;

      case 'offscreen-stop-recording':
        handleStopRecording();
        sendResponse({ success: true });
        return false;

      case 'offscreen-toggle-pause':
        handleTogglePause();
        sendResponse({ success: true, isPaused });
        return false;

      case 'offscreen-toggle-mute':
        handleToggleMute();
        sendResponse({ success: true });
        return false;

      case 'offscreen-get-time':
        sendResponse({ success: true, elapsed: getElapsedMs() });
        return false;

      // Clipboard handler (original offscreen functionality)
      case 'offscreen-copy-clipboard':
        if (!message.dataUrl || typeof message.dataUrl !== 'string') {
          sendResponse({ success: false, error: 'Missing or invalid dataUrl' });
          return false;
        }
        copyImageToClipboard(message.dataUrl)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;

      default:
        return false;
    }
  });

  // ── Recording Logic ─────────────────────────────

  /**
   * Start recording with the given configuration.
   * Acquires streams based on config, combines them, and starts MediaRecorder.
   * @param {Object} config - Recording configuration
   * @param {string} config.source - 'tab' | 'screen' | 'camera'
   * @param {string} [config.streamId] - Chrome tabCapture/desktopCapture stream ID
   * @param {string} config.resolution - '720' | '1080' | '2160'
   * @param {boolean} config.microphone - Whether to capture mic audio
   * @param {boolean} config.systemAudio - Whether to capture system/tab audio
   * @param {boolean} config.pip - Whether to enable PiP webcam overlay
   * @param {string} config.pipPosition - PiP position ('bottom-right', etc.)
   * @param {string} config.pipSize - PiP size ('small' | 'medium' | 'large')
   * @returns {Promise<void>}
   */
  async function handleStartRecording(config) {
    console.info(LOG_PREFIX, 'Starting recording with config:', config);
    recordedChunks = [];

    mainStream = await acquireMainStream(config);

    // Microphone — check permission first (offscreen can't show prompts)
    if (config.microphone) {
      try {
        const micPerm = await navigator.permissions.query({ name: 'microphone' });
        if (micPerm.state === 'granted') {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          console.info(LOG_PREFIX, 'Mic permission not granted, skipping (use Grant Permissions button)');
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Mic access error:', err.message);
      }
    }

    // Webcam for PiP — check permission first
    if (config.pip && config.source !== 'camera') {
      try {
        const camPerm = await navigator.permissions.query({ name: 'camera' });
        if (camPerm.state === 'granted') {
          webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 320 },
            audio: false,
          });
        } else {
          console.info(LOG_PREFIX, 'Camera permission not granted, skipping (use Grant Permissions button)');
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Webcam for PiP error:', err.message);
      }
    }

    combinedStream = buildCombinedStream(mainStream, micStream, webcamStream, config);
    startMediaRecorder(combinedStream);
    recordingStartTime = Date.now();
    pausedDuration = 0;
    pauseStartTime = 0;
    isPaused = false;
  }

  /**
   * Acquire the main video/audio stream based on source type.
   * @param {Object} config - Recording config with source and streamId
   * @returns {Promise<MediaStream>}
   */
  async function acquireMainStream(config) {
    const { source, streamId, resolution, systemAudio } = config;

    if (source === 'camera') {
      const preset = getResolutionPreset(resolution);
      return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: preset.width }, height: { ideal: preset.height } },
        audio: false,
      });
    }

    if (!streamId) {
      throw new Error('No streamId provided for tab/screen capture');
    }

    // For tab capture, use the streamId with chromeMediaSource
    if (source === 'tab') {
      return navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        audio: systemAudio ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        } : false,
      });
    }

    // For screen capture (desktopCapture streamId)
    if (source === 'screen') {
      return navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        },
        audio: systemAudio ? {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        } : false,
      });
    }

    throw new Error(`Unknown source: ${source}`);
  }

  /**
   * Get resolution preset dimensions.
   * @param {string} resolution - '720' | '1080' | '2160'
   * @returns {{width: number, height: number}}
   */
  function getResolutionPreset(resolution) {
    const presets = { '720': { width: 1280, height: 720 }, '1080': { width: 1920, height: 1080 }, '2160': { width: 3840, height: 2160 } };
    return presets[resolution] || presets['1080'];
  }

  /**
   * Build the final combined stream with video, optional PiP, and all audio tracks.
   * @param {MediaStream} main - Main video/audio stream
   * @param {MediaStream|null} mic - Microphone audio stream
   * @param {MediaStream|null} webcam - Webcam video for PiP
   * @param {Object} config - Recording config
   * @returns {MediaStream}
   */
  function buildCombinedStream(main, mic, webcam, config) {
    let videoStream = main;

    if (config.pip && webcam && config.source !== 'camera') {
      videoStream = createPiPStream(main, webcam, config.pipPosition, config.pipSize);
    }

    const audioTracks = [];

    // Main stream audio (tab/system)
    main.getAudioTracks().forEach(t => audioTracks.push(t));

    // Mic audio with gain control
    if (mic) {
      audioContext = audioContext || new AudioContext();
      const micSource = audioContext.createMediaStreamSource(mic);
      micGainNode = audioContext.createGain();
      micGainNode.gain.value = 1.0;
      micSource.connect(micGainNode);

      const dest = audioContext.createMediaStreamDestination();
      micGainNode.connect(dest);
      dest.stream.getAudioTracks().forEach(t => audioTracks.push(t));
    }

    return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
  }

  /**
   * Create a PiP composited stream using Canvas.
   * @param {MediaStream} mainVideoStream - Screen/tab video stream
   * @param {MediaStream} webcamVideoStream - Webcam video stream
   * @param {string} position - PiP position
   * @param {string} sizeStr - PiP size name
   * @returns {MediaStream}
   */
  function createPiPStream(mainVideoStream, webcamVideoStream, position, sizeStr) {
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
    const bubbleSize = PIP_SIZES[sizeStr] || PIP_SIZES.medium;

    /**
     * Calculate bubble position.
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

    /** Draw one composited frame. */
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

  /**
   * Configure and start MediaRecorder.
   * @param {MediaStream} stream - Combined stream to record
   */
  function startMediaRecorder(stream) {
    // Prefer MP4 (Chrome 130+), fallback to WebM
    const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
      ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
      : MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,opus')
        ? 'video/mp4;codecs=avc1.42E01E,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
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

    // Handle stream ending (user stops screen share via browser UI)
    stream.getVideoTracks().forEach(track => {
      track.onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          handleStopRecording();
        }
      };
    });

    mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
    console.info(LOG_PREFIX, 'MediaRecorder started with MIME:', mimeType);
  }

  // ── Control Handlers ────────────────────────────

  /** Stop the MediaRecorder. */
  function handleStopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  /** Toggle pause/resume. */
  function handleTogglePause() {
    if (!mediaRecorder) return;

    if (isPaused) {
      pausedDuration += Date.now() - pauseStartTime;
      mediaRecorder.resume();
      isPaused = false;
    } else {
      pauseStartTime = Date.now();
      mediaRecorder.pause();
      isPaused = true;
    }
  }

  /** Toggle microphone mute/unmute. */
  function handleToggleMute() {
    if (!micGainNode) return;
    const currentlyMuted = micGainNode.gain.value === 0;
    micGainNode.gain.value = currentlyMuted ? 1 : 0;
  }

  /**
   * Get elapsed recording time in ms (excluding paused duration).
   * @returns {number}
   */
  function getElapsedMs() {
    if (!recordingStartTime) return 0;
    const now = Date.now();
    const currentPause = isPaused ? (now - pauseStartTime) : 0;
    return now - recordingStartTime - pausedDuration - currentPause;
  }

  // ── Recording Stopped Handler ───────────────────

  /**
   * Handle MediaRecorder stop: serialize blob and send to SW for storage.
   * Offscreen documents don't have access to chrome.storage, so we relay
   * the data to the service worker which stores it in chrome.storage.local.
   */
  async function onRecordingStopped() {
    console.info(LOG_PREFIX, 'MediaRecorder stopped, processing chunks...');

    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
    const duration = getElapsedMs();

    // Serialize blob and send chunks to SW for storage
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      const totalChunks = Math.ceil(uint8.length / RECORDING_CHUNK_SIZE);

      // Send metadata first
      await chrome.runtime.sendMessage({
        action: 'offscreen-store-recording-meta',
        totalChunks,
        mimeType: blob.type,
        duration,
        size: blob.size,
      });

      // Send each chunk to SW for storage
      for (let i = 0; i < totalChunks; i++) {
        const start = i * RECORDING_CHUNK_SIZE;
        const end = Math.min(start + RECORDING_CHUNK_SIZE, uint8.length);
        await chrome.runtime.sendMessage({
          action: 'offscreen-store-recording-chunk',
          index: i,
          data: Array.from(uint8.slice(start, end)),
        });
      }

      console.info(LOG_PREFIX, `Sent ${totalChunks} chunks to SW (${formatSize(blob.size)})`);
    } catch (err) {
      console.error(LOG_PREFIX, 'Failed to serialize recording:', err);
    }

    // Cleanup streams
    cleanupStreams();

    // Notify the service worker that recording data is ready
    try {
      await chrome.runtime.sendMessage({
        action: 'offscreen-recording-complete',
        duration,
        size: blob.size,
      });
    } catch (err) {
      console.warn(LOG_PREFIX, 'Failed to notify SW:', err.message);
    }
  }

  /**
   * Stop all media streams and clean up resources.
   */
  function cleanupStreams() {
    if (pipAnimFrame) {
      cancelAnimationFrame(pipAnimFrame);
      pipAnimFrame = null;
    }

    [mainStream, micStream, webcamStream, combinedStream].forEach(stream => {
      if (stream) stream.getTracks().forEach(t => t.stop());
    });

    mainStream = null;
    micStream = null;
    webcamStream = null;
    combinedStream = null;

    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }

    micGainNode = null;
    mediaRecorder = null;
    recordedChunks = [];
  }

  // ── Clipboard (original offscreen functionality) ─

  /**
   * Copy an image data URL to the system clipboard.
   * @param {string} dataUrl - Image data URL
   * @returns {Promise<void>}
   */
  async function copyImageToClipboard(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }

  /**
   * Format byte size for logging.
   * @param {number} bytes - Size in bytes
   * @returns {string}
   */
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
})();
