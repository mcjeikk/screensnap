/**
 * ScreenBolt — Recording Offscreen Document
 *
 * Runs MediaRecorder in an offscreen document context.
 * Receives a streamId and config from the service worker, acquires the
 * real MediaStream, records it, and serializes the result to IndexedDB.
 * Handles audio mixing (mic + tab/system audio) via AudioContext.
 */

import { saveRecording } from '../utils/idb-storage.js';
import type { RecordingConfig } from '../utils/types.js';

// ── Constants ─────────────────────────────────────

const LOG_PREFIX = '[ScreenBolt][OffscreenRecorder]';
const VIDEO_BITRATE = 5_000_000;
const PIP_CANVAS_FPS = 30;
const PIP_MARGIN = 20;
const MEDIA_RECORDER_TIMESLICE_MS = 1000;
const RECORDING_ID = 'pending-recording';
const PIP_SIZES: Readonly<Record<string, number>> = Object.freeze({
  small: 120,
  medium: 180,
  large: 240,
});

// ── Extended MediaStream with audio playback bookkeeping ──

interface AudioPlayback {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
}

interface MediaStreamWithPlayback extends MediaStream {
  _audioPlayback?: AudioPlayback;
}

// ── Chrome mandatory constraints (non-standard but required for tabCapture) ──

interface ChromeMediaTrackConstraints extends MediaTrackConstraints {
  mandatory?: Record<string, string>;
}

interface ChromeMediaStreamConstraints {
  video: ChromeMediaTrackConstraints | boolean;
  audio: ChromeMediaTrackConstraints | boolean;
}

// ── Resolution preset ─────────────────────────────

interface ResolutionPreset {
  width: number;
  height: number;
}

// ── State ─────────────────────────────────────────

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStartTime = 0;
let isPaused = false;
let pausedDuration = 0; // Total ms in paused state
let pauseStartTime = 0; // Timestamp when current pause started

// Streams
let mainStream: MediaStreamWithPlayback | null = null;
let micStream: MediaStream | null = null;
let webcamStream: MediaStream | null = null;
let combinedStream: MediaStream | null = null;
let pipAnimFrame: ReturnType<typeof setInterval> | null = null;

// Audio
let audioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;

// ── Message Listener ──────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean => {
    if (!message || typeof (message as Record<string, unknown>).action !== 'string') return false;

    const msg = message as Record<string, unknown>;

    switch (msg.action) {
      case 'offscreen-start-recording':
        handleStartRecording(msg.config as RecordingConfig)
          .then(() => sendResponse({ success: true }))
          .catch((err: Error) => {
            console.error(LOG_PREFIX, 'Start recording failed:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // async response

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
      case 'offscreen-copy-clipboard': {
        const dataUrl = msg.dataUrl;
        if (!dataUrl || typeof dataUrl !== 'string') {
          sendResponse({ success: false, error: 'Missing or invalid dataUrl' });
          return false;
        }
        copyImageToClipboard(dataUrl)
          .then(() => sendResponse({ success: true }))
          .catch((err: Error) => sendResponse({ success: false, error: err.message }));
        return true; // async response
      }

      default:
        return false;
    }
  },
);

// ── Recording Logic ───────────────────────────────

/**
 * Start recording with the given configuration.
 * Acquires streams based on config, combines them, and starts MediaRecorder.
 */
async function handleStartRecording(config: RecordingConfig): Promise<void> {
  console.info(LOG_PREFIX, 'Starting recording with config:', config);
  recordedChunks = [];

  mainStream = await acquireMainStream(config);

  // Microphone — getUserMedia in the offscreen context.
  // Requires prior permission grant from the permissions page.
  if (config.microphone) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      console.info(LOG_PREFIX, `Microphone acquired (${micStream.getAudioTracks().length} tracks)`);
    } catch (err) {
      console.error(
        LOG_PREFIX,
        'Mic acquisition failed:',
        (err as Error).name,
        (err as Error).message,
        '— User must grant mic access via the permissions page first.',
      );
    }
  }

  // PiP webcam is handled by the content script (visible on page, captured by tabCapture).
  // Offscreen only records the tab stream — the webcam bubble is part of the tab content.

  combinedStream = buildCombinedStream(mainStream, micStream, null, config);

  // Play back tab audio to the user — chrome.tabCapture mutes the tab
  if (config.source === 'tab' && mainStream && mainStream.getAudioTracks().length > 0) {
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(new MediaStream(mainStream.getAudioTracks()));
      source.connect(audioCtx.destination);
      mainStream._audioPlayback = { ctx: audioCtx, source };
      console.info(LOG_PREFIX, 'Tab audio playback enabled');
    } catch (err) {
      console.warn(LOG_PREFIX, 'Audio playback setup failed:', (err as Error).message);
    }
  }

  startMediaRecorder(combinedStream, config.format);
  recordingStartTime = Date.now();
  pausedDuration = 0;
  pauseStartTime = 0;
  isPaused = false;
}

/** Acquire the main video/audio stream based on source type. */
async function acquireMainStream(config: RecordingConfig): Promise<MediaStream> {
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
      audio: systemAudio
        ? {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
            },
          }
        : false,
    } as ChromeMediaStreamConstraints as MediaStreamConstraints);
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
      audio: systemAudio
        ? {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: streamId,
            },
          }
        : false,
    } as ChromeMediaStreamConstraints as MediaStreamConstraints);
  }

  throw new Error(`Unknown source: ${source}`);
}

/** Get resolution preset dimensions. */
function getResolutionPreset(resolution: string): ResolutionPreset {
  const presets: Record<string, ResolutionPreset> = {
    720: { width: 1280, height: 720 },
    1080: { width: 1920, height: 1080 },
    2160: { width: 3840, height: 2160 },
  };
  return presets[resolution] || presets['1080'];
}

/**
 * Build the final combined stream with video, optional PiP, and all audio tracks.
 */
function buildCombinedStream(
  main: MediaStream,
  mic: MediaStream | null,
  webcam: MediaStream | null,
  config: RecordingConfig,
): MediaStream {
  let videoStream: MediaStream = main;

  if (config.pip && webcam && config.source !== 'camera') {
    videoStream = createPiPStream(main, webcam, config.pipPosition, config.pipSize);
  }

  const audioTracks: MediaStreamTrack[] = [];

  // Main stream audio (tab/system)
  main.getAudioTracks().forEach((t) => audioTracks.push(t));

  // Mic audio with gain control
  if (mic) {
    audioContext = audioContext || new AudioContext();
    const micSource = audioContext.createMediaStreamSource(mic);
    micGainNode = audioContext.createGain();
    micGainNode.gain.value = 1.0;
    micSource.connect(micGainNode);

    const dest = audioContext.createMediaStreamDestination();
    micGainNode.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => audioTracks.push(t));
  }

  return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
}

/**
 * Create a PiP composited stream using Canvas.
 * Uses setInterval instead of requestAnimationFrame because offscreen
 * documents are hidden and don't get rAF callbacks reliably.
 */
function createPiPStream(
  mainVideoStream: MediaStream,
  webcamVideoStream: MediaStream,
  position: string,
  sizeStr: string,
): MediaStream {
  const canvas = document.getElementById('pip-canvas') as HTMLCanvasElement;
  const screenVideo = document.getElementById('pip-screen') as HTMLVideoElement;
  const camVideo = document.getElementById('pip-webcam') as HTMLVideoElement;

  const mainTrack = mainVideoStream.getVideoTracks()[0];
  const settings = mainTrack.getSettings();
  canvas.width = settings.width || 1920;
  canvas.height = settings.height || 1080;

  screenVideo.srcObject = new MediaStream([mainTrack]);
  camVideo.srcObject = webcamVideoStream;

  // Explicitly play both videos — hidden documents may not autoplay
  screenVideo.play().catch((err: Error) => console.warn(LOG_PREFIX, 'Screen video play failed:', err.message));
  camVideo.play().catch((err: Error) => console.warn(LOG_PREFIX, 'Webcam video play failed:', err.message));

  const ctx = canvas.getContext('2d')!;
  const bubbleSize = PIP_SIZES[sizeStr] || PIP_SIZES['medium'];

  /** Calculate bubble position. */
  function getBubblePos(): { x: number; y: number } {
    const w = canvas.width;
    const h = canvas.height;
    switch (position) {
      case 'top-left':
        return { x: PIP_MARGIN, y: PIP_MARGIN };
      case 'top-right':
        return { x: w - bubbleSize - PIP_MARGIN, y: PIP_MARGIN };
      case 'bottom-left':
        return { x: PIP_MARGIN, y: h - bubbleSize - PIP_MARGIN };
      default:
        return { x: w - bubbleSize - PIP_MARGIN, y: h - bubbleSize - PIP_MARGIN };
    }
  }

  /** Draw one composited frame. */
  function drawFrame(): void {
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
  }

  // Use setInterval at ~30fps (33ms) — offscreen docs don't get rAF reliably
  pipAnimFrame = setInterval(drawFrame, 33);

  return canvas.captureStream(PIP_CANVAS_FPS);
}

/** Configure and start MediaRecorder. */
function startMediaRecorder(stream: MediaStream, preferredFormat?: 'mp4' | 'webm'): void {
  // Select MIME type based on user preference
  let mimeType: string;
  if (preferredFormat === 'webm') {
    mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
  } else {
    // Default: prefer MP4 H.264 (Chrome 130+), fallback to WebM
    mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
      ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';
  }

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITRATE,
  });

  mediaRecorder.ondataavailable = (e: BlobEvent): void => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = (): void => {
    onRecordingStopped();
  };

  // Handle stream ending (user stops screen share via browser UI)
  stream.getVideoTracks().forEach((track) => {
    track.onended = (): void => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        handleStopRecording();
      }
    };
  });

  mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
  console.info(LOG_PREFIX, 'MediaRecorder started with MIME:', mimeType);
}

// ── Control Handlers ──────────────────────────────

/** Stop the MediaRecorder. */
function handleStopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

/** Toggle pause/resume. */
function handleTogglePause(): void {
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
function handleToggleMute(): void {
  if (!micGainNode) return;
  const currentlyMuted = micGainNode.gain.value === 0;
  micGainNode.gain.value = currentlyMuted ? 1 : 0;
}

/** Get elapsed recording time in ms (excluding paused duration). */
function getElapsedMs(): number {
  if (!recordingStartTime) return 0;
  const now = Date.now();
  const currentPause = isPaused ? now - pauseStartTime : 0;
  return now - recordingStartTime - pausedDuration - currentPause;
}

// ── Recording Stopped Handler ─────────────────────

/**
 * Handle MediaRecorder stop: save blob directly to IndexedDB and notify SW.
 * IndexedDB is shared between all extension pages (same origin), so the
 * preview page can read the blob directly without any relay through the SW.
 */
async function onRecordingStopped(): Promise<void> {
  console.info(LOG_PREFIX, 'MediaRecorder stopped, saving to IndexedDB...');

  const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
  const duration = getElapsedMs();

  try {
    await saveRecording(RECORDING_ID, blob, {
      duration,
      size: blob.size,
      mimeType: blob.type,
      timestamp: Date.now(),
    });
    console.info(LOG_PREFIX, `Recording saved to IndexedDB (${formatSize(blob.size)})`);
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to save recording to IndexedDB:', err);
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
    console.warn(LOG_PREFIX, 'Failed to notify SW:', (err as Error).message);
  }
}

/** Stop all media streams and clean up resources. */
function cleanupStreams(): void {
  if (pipAnimFrame) {
    clearInterval(pipAnimFrame);
    pipAnimFrame = null;
  }

  // Close tab audio playback if active
  if (mainStream?._audioPlayback) {
    mainStream._audioPlayback.source.disconnect();
    mainStream._audioPlayback.ctx.close().catch(() => {});
  }

  [mainStream, micStream, webcamStream, combinedStream].forEach((stream) => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
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

// ── Clipboard (original offscreen functionality) ──

/** Copy an image data URL to the system clipboard. */
async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Format byte size for logging. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
