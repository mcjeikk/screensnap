/**
 * ScreenBolt — Preview Script
 *
 * Loads recorded video from IndexedDB, provides playback preview,
 * and offers download in WebM or MP4. Properly revokes Object URLs on cleanup.
 */

import { getTimestamp, formatFileSize } from '../utils/helpers.js';
import { getRecording, deleteRecording } from '../utils/idb-storage.js';
import type { RecordingEntry } from '../utils/idb-storage.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// -- Constants ---------------------------------------------------------------

const LOG_PREFIX = '[ScreenBolt][Preview]';
const RECORDING_ID = 'pending-recording';

// -- State -------------------------------------------------------------------

let videoBlob: Blob | null = null;
let videoMimeType = 'video/webm';
/** Object URL for the video element — must be revoked on cleanup. */
let videoBlobUrl: string | null = null;

/** Trim state (in seconds). */
let trimStart = 0;
let trimEnd = 0;
let videoDuration = 0;
let isTrimming = false;
let isExportingGif = false;

// -- Init --------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadRecording();
    bindButtons();
    bindTrimControls();
  } catch (err) {
    showError(`Failed to load recording: ${(err as Error).message}`);
  }
});

// -- Load Recording from IndexedDB -------------------------------------------

/** Load the recording blob from IndexedDB and set up the video player. */
async function loadRecording(): Promise<void> {
  const record: RecordingEntry | null = await getRecording(RECORDING_ID);

  if (!record || !record.blob) {
    throw new Error('No recording data found');
  }

  const { blob, metadata } = record;
  videoBlob = blob;
  videoMimeType = metadata?.mimeType || blob.type || 'video/webm';

  // Set up video player
  const video = document.getElementById('preview-video') as HTMLVideoElement;
  videoBlobUrl = URL.createObjectURL(videoBlob);
  video.src = videoBlobUrl;

  // Display metadata
  if (metadata?.duration) {
    const durationSec = Math.floor(metadata.duration / 1000);
    const mm = String(Math.floor(durationSec / 60)).padStart(2, '0');
    const ss = String(durationSec % 60).padStart(2, '0');
    (document.getElementById('meta-duration') as HTMLElement).textContent = `${mm}:${ss}`;
  }

  (document.getElementById('meta-size') as HTMLElement).textContent = formatFileSize(videoBlob.size);

  const formatLabel = videoMimeType.includes('mp4')
    ? 'MP4'
    : videoMimeType.includes('webm')
      ? 'WebM'
      : videoMimeType;
  (document.getElementById('meta-format') as HTMLElement).textContent = formatLabel;

  // Show content, hide loading
  (document.getElementById('loading') as HTMLElement).style.display = 'none';
  (document.getElementById('preview-content') as HTMLElement).style.display = 'block';
}

/** Remove recording from IndexedDB (best-effort). */
async function cleanupRecordingStorage(): Promise<void> {
  try {
    await deleteRecording(RECORDING_ID);
  } catch {
    /* best effort */
  }
}

// -- Button Handlers ---------------------------------------------------------

/** Bind download and discard buttons. */
function bindButtons(): void {
  (document.getElementById('btn-download') as HTMLButtonElement).addEventListener(
    'click',
    downloadRecording,
  );
  (document.getElementById('btn-discard') as HTMLButtonElement).addEventListener('click', discard);
  (document.getElementById('btn-gif') as HTMLButtonElement).addEventListener(
    'click',
    () => void exportAsGif(),
  );
}

/** Download the recording, trimming if handles are not at defaults. */
async function downloadRecording(): Promise<void> {
  if (!videoBlob || isTrimming) return;

  const needsTrim = trimStart > 0.05 || trimEnd < videoDuration - 0.05;

  if (needsTrim) {
    try {
      const trimmedBlob = await trimRecording();
      const ext = trimmedBlob.type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(trimmedBlob);
      triggerDownload(url, `ScreenBolt_${getTimestamp()}.${ext}`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      showError(`Trim failed: ${(err as Error).message}`);
      return;
    }
  } else {
    const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(videoBlob);
    triggerDownload(url, `ScreenBolt_${getTimestamp()}.${ext}`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  cleanupRecordingStorage();
}

/** Discard the recording and close the tab. */
function discard(): void {
  if (confirm('Discard this recording? This cannot be undone.')) {
    cleanupRecordingStorage();
    cleanup();
    window.close();
  }
}

// -- Trim Controls -----------------------------------------------------------

/** Format seconds as MM:SS. */
function formatTime(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Bind trim slider events and the reset link. */
function bindTrimControls(): void {
  const video = document.getElementById('preview-video') as HTMLVideoElement;
  const startSlider = document.getElementById('trim-start') as HTMLInputElement;
  const endSlider = document.getElementById('trim-end') as HTMLInputElement;
  const startLabel = document.getElementById('trim-start-label') as HTMLElement;
  const endLabel = document.getElementById('trim-end-label') as HTMLElement;
  const resetLink = document.getElementById('trim-reset') as HTMLAnchorElement;

  video.addEventListener('loadedmetadata', () => {
    videoDuration = video.duration;
    trimEnd = videoDuration;

    startSlider.max = String(videoDuration);
    startSlider.step = '0.1';
    startSlider.value = '0';

    endSlider.max = String(videoDuration);
    endSlider.step = '0.1';
    endSlider.value = String(videoDuration);

    startLabel.textContent = formatTime(0);
    endLabel.textContent = formatTime(videoDuration);
  });

  startSlider.addEventListener('input', () => {
    let val = parseFloat(startSlider.value);
    // Don't allow start to exceed end minus a small buffer
    if (val >= trimEnd - 0.2) {
      val = trimEnd - 0.2;
      startSlider.value = String(val);
    }
    trimStart = Math.max(0, val);
    startLabel.textContent = formatTime(trimStart);
  });

  endSlider.addEventListener('input', () => {
    let val = parseFloat(endSlider.value);
    // Don't allow end to go below start plus a small buffer
    if (val <= trimStart + 0.2) {
      val = trimStart + 0.2;
      endSlider.value = String(val);
    }
    trimEnd = Math.min(videoDuration, val);
    endLabel.textContent = formatTime(trimEnd);
  });

  resetLink.addEventListener('click', (e: Event) => {
    e.preventDefault();
    trimStart = 0;
    trimEnd = videoDuration;
    startSlider.value = '0';
    endSlider.value = String(videoDuration);
    startLabel.textContent = formatTime(0);
    endLabel.textContent = formatTime(videoDuration);
  });
}

/** Re-encode the video between trimStart and trimEnd using canvas + MediaRecorder. */
function trimRecording(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!videoBlob) {
      reject(new Error('No video blob available'));
      return;
    }

    isTrimming = true;
    const progressContainer = document.getElementById('trim-progress') as HTMLElement;
    const progressFill = document.getElementById('trim-progress-fill') as HTMLElement;
    const statusText = document.getElementById('trim-status') as HTMLElement;
    const downloadBtn = document.getElementById('btn-download') as HTMLButtonElement;

    progressContainer.style.display = 'block';
    downloadBtn.disabled = true;

    // Create offscreen video and canvas
    const srcVideo = document.createElement('video');
    srcVideo.muted = true;
    srcVideo.playsInline = true;
    srcVideo.src = URL.createObjectURL(videoBlob);

    srcVideo.addEventListener('loadedmetadata', () => {
      const w = srcVideo.videoWidth;
      const h = srcVideo.videoHeight;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctxOrNull = canvas.getContext('2d');
      if (!ctxOrNull) {
        cleanup();
        reject(new Error('Could not get canvas context'));
        return;
      }
      const ctx: CanvasRenderingContext2D = ctxOrNull;

      // Choose a mime type the browser supports for recording
      const recorderMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: recorderMime });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        const trimmedBlob = new Blob(chunks, { type: recorderMime });
        URL.revokeObjectURL(srcVideo.src);
        finishTrimUI();
        resolve(trimmedBlob);
      };

      recorder.onerror = () => {
        URL.revokeObjectURL(srcVideo.src);
        finishTrimUI();
        reject(new Error('MediaRecorder error during trim'));
      };

      // Seek to trimStart, then play and record
      srcVideo.currentTime = trimStart;

      srcVideo.addEventListener('seeked', function onSeeked() {
        srcVideo.removeEventListener('seeked', onSeeked);
        recorder.start();
        srcVideo.play();

        const totalDuration = trimEnd - trimStart;

        function drawFrame(): void {
          if (srcVideo.currentTime >= trimEnd || srcVideo.paused || srcVideo.ended) {
            srcVideo.pause();
            recorder.stop();
            return;
          }

          ctx.drawImage(srcVideo, 0, 0, w, h);

          // Update progress
          const elapsed = srcVideo.currentTime - trimStart;
          const pct = Math.min(100, Math.round((elapsed / totalDuration) * 100));
          progressFill.style.width = `${pct}%`;
          statusText.textContent = `Trimming\u2026 ${pct}%`;

          requestAnimationFrame(drawFrame);
        }

        requestAnimationFrame(drawFrame);
      });

      // Stop recording when video passes trimEnd via timeupdate as a safety net
      srcVideo.addEventListener('timeupdate', () => {
        if (srcVideo.currentTime >= trimEnd && recorder.state === 'recording') {
          srcVideo.pause();
          recorder.stop();
        }
      });
    });

    srcVideo.addEventListener('error', () => {
      finishTrimUI();
      reject(new Error('Failed to load video for trimming'));
    });

    function finishTrimUI(): void {
      isTrimming = false;
      progressContainer.style.display = 'none';
      progressFill.style.width = '0%';
      downloadBtn.disabled = false;
    }

    function cleanup(): void {
      isTrimming = false;
      progressContainer.style.display = 'none';
      downloadBtn.disabled = false;
    }
  });
}

// -- GIF Export --------------------------------------------------------------

/** Maximum GIF width — keeps file size reasonable. */
const GIF_MAX_WIDTH = 640;
/** Target frames per second for GIF output. */
// ── GIF Export ──────────────────────────────────────

const GIF_FPS = 10;

/** Export the current video as an animated GIF. */
async function exportAsGif(): Promise<void> {
  if (!videoBlob || isExportingGif || isTrimming) return;

  const gifBtn = document.getElementById('btn-gif') as HTMLButtonElement;
  const progressEl = document.getElementById('gif-progress') as HTMLElement;

  isExportingGif = true;
  gifBtn.disabled = true;
  progressEl.style.display = 'block';
  progressEl.textContent = 'Converting to GIF\u2026 0%';

  try {
    // Create an offscreen video element to seek through
    const srcVideo = document.createElement('video');
    srcVideo.muted = true;
    srcVideo.playsInline = true;
    srcVideo.preload = 'auto';
    srcVideo.src = URL.createObjectURL(videoBlob);

    await new Promise<void>((resolve, reject) => {
      srcVideo.addEventListener('loadeddata', () => resolve(), { once: true });
      srcVideo.addEventListener('error', () => reject(new Error('Failed to load video for GIF export')), { once: true });
    });

    const nativeW = srcVideo.videoWidth;
    const nativeH = srcVideo.videoHeight;

    // Scale down if wider than the cap
    const scale = nativeW > GIF_MAX_WIDTH ? GIF_MAX_WIDTH / nativeW : 1;
    const width = Math.round(nativeW * scale);
    const height = Math.round(nativeH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not get canvas 2D context');

    const duration = srcVideo.duration;
    const frameInterval = 1 / GIF_FPS;
    const frameDelay = Math.round(1000 / GIF_FPS); // ms per frame for GIF
    const totalFrames = Math.max(1, Math.floor(duration * GIF_FPS));

    const gif = GIFEncoder();

    for (let i = 0; i < totalFrames; i++) {
      const time = i * frameInterval;

      // Seek to the target time
      await seekVideo(srcVideo, time);

      // Draw video frame to canvas
      ctx.drawImage(srcVideo, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);

      // Quantize to 256 colors and apply palette
      const palette = quantize(imageData.data, 256);
      const index = applyPalette(imageData.data, palette);

      gif.writeFrame(index, width, height, {
        palette,
        delay: frameDelay,
        dispose: 2,
      });

      // Update progress
      const pct = Math.round(((i + 1) / totalFrames) * 100);
      progressEl.textContent = `Converting to GIF\u2026 ${pct}%`;
    }

    gif.finish();

    // Clean up offscreen video
    URL.revokeObjectURL(srcVideo.src);

    // Trigger download
    const gifBytes = gif.bytesView();
    const gifBuffer = new Uint8Array(gifBytes.length);
    gifBuffer.set(gifBytes);
    const gifBlob = new Blob([gifBuffer], { type: 'image/gif' });
    const url = URL.createObjectURL(gifBlob);
    triggerDownload(url, `ScreenBolt_${getTimestamp()}.gif`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    showError(`GIF export failed: ${(err as Error).message}`);
  } finally {
    isExportingGif = false;
    gifBtn.disabled = false;
    progressEl.style.display = 'none';
  }
}

/** Seek a video element to a specific time and wait for the seek to complete. */
function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    // If already at the target time (e.g. first frame at 0), resolve immediately
    if (Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = time;
  });
}

// -- Helpers -----------------------------------------------------------------

/** Trigger a file download via chrome.downloads API. */
function triggerDownload(url: string, filename: string): void {
  chrome.downloads.download({ url, filename, saveAs: true });
}

/** Show an error message and hide the loading state. */
function showError(msg: string): void {
  (document.getElementById('loading') as HTMLElement).style.display = 'none';
  (document.getElementById('error-container') as HTMLElement).style.display = 'block';
  (document.getElementById('error-msg') as HTMLElement).textContent = `\u26A0\uFE0F ${msg}`;
}

/** Clean up resources: revoke Object URLs and release blob. */
function cleanup(): void {
  if (videoBlobUrl) {
    URL.revokeObjectURL(videoBlobUrl);
    videoBlobUrl = null;
  }
  videoBlob = null;
}

// Cleanup on page hide (pagehide is preferred over beforeunload for bfcache compatibility)
window.addEventListener('pagehide', cleanup);
