/**
 * @file ScreenBolt — Preview Script v0.5.0
 * @description Loads recorded video from chrome.storage, provides playback preview,
 * and offers download in WebM or MP4 (via ffmpeg.wasm lazy-loaded from CDN).
 * Properly revokes Object URLs on cleanup.
 * @version 0.5.0
 */


'use strict';

// ── Constants ───────────────────────────────────
const LOG_PREFIX = '[ScreenBolt][Preview]';

// ── State ───────────────────────────────────────
/** @type {Blob|null} */
let videoBlob = null;

/** @type {string} */
let videoMimeType = 'video/webm';

/** @type {string|null} Object URL for the video element — must be revoked */
let videoBlobUrl = null;

// ── Init ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadRecording();
    bindButtons();
  } catch (err) {
    showError(`Failed to load recording: ${err.message}`);
  }
});

// ── Load Recording from Storage ─────────────────

/**
 * Reassemble the recording from storage chunks and set up the video player.
 * @throws {Error} If no recording data is found
 */
async function loadRecording() {
  const meta = await chrome.storage.local.get([
    'pendingRecording',
    'recording-chunks-count',
    'recording-mime',
  ]);

  const info = meta.pendingRecording;
  const chunkCount = meta['recording-chunks-count'];
  videoMimeType = meta['recording-mime'] || 'video/webm';

  if (!chunkCount || chunkCount === 0) {
    throw new Error('No recording data found');
  }

  // Read all chunks
  const chunkKeys = [];
  for (let i = 0; i < chunkCount; i++) {
    chunkKeys.push(`recording-chunk-${i}`);
  }

  const chunkData = await chrome.storage.local.get(chunkKeys);

  // Reassemble into a single Uint8Array
  const parts = [];
  let totalLength = 0;
  for (let i = 0; i < chunkCount; i++) {
    const arr = chunkData[`recording-chunk-${i}`];
    if (!arr) throw new Error(`Missing recording chunk ${i}`);
    totalLength += arr.length;
    parts.push(new Uint8Array(arr));
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  videoBlob = new Blob([combined], { type: videoMimeType });

  // Set up video player
  const video = document.getElementById('preview-video');
  videoBlobUrl = URL.createObjectURL(videoBlob);
  video.src = videoBlobUrl;

  // Display metadata
  if (info) {
    const durationSec = Math.floor((info.duration || 0) / 1000);
    const mm = String(Math.floor(durationSec / 60)).padStart(2, '0');
    const ss = String(durationSec % 60).padStart(2, '0');
    document.getElementById('meta-duration').textContent = `${mm}:${ss}`;
  }

  document.getElementById('meta-size').textContent = formatFileSize(videoBlob.size);
  const formatLabel = videoMimeType.includes('mp4') ? 'MP4'
    : videoMimeType.includes('webm') ? 'WebM'
    : videoMimeType;
  document.getElementById('meta-format').textContent = formatLabel;

  // Show content, hide loading
  document.getElementById('loading').style.display = 'none';
  document.getElementById('preview-content').style.display = 'block';

  // Clean up storage (recording data is now in memory)
  cleanupStorage(chunkCount);
}

/**
 * Remove recording chunks from chrome.storage.local.
 * @param {number} chunkCount - Number of chunks to remove
 */
async function cleanupStorage(chunkCount) {
  const keys = ['pendingRecording', 'recording-chunks-count', 'recording-mime'];
  for (let i = 0; i < chunkCount; i++) {
    keys.push(`recording-chunk-${i}`);
  }
  await chrome.storage.local.remove(keys);
}

// ── Button Handlers ─────────────────────────────

/** Bind download and discard buttons. */
function bindButtons() {
  document.getElementById('btn-download').addEventListener('click', downloadRecording);
  document.getElementById('btn-discard').addEventListener('click', discard);
}

/** Download the recording in its native format. */
function downloadRecording() {
  if (!videoBlob) return;
  const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(videoBlob);
  triggerDownload(url, `ScreenBolt_${getTimestamp()}.${ext}`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Discard the recording and close the tab. */
function discard() {
  if (confirm('Discard this recording? This cannot be undone.')) {
    cleanup();
    window.close();
  }
}

// ── Helpers ───────────────────────────────────────

/**
 * Trigger a file download via chrome.downloads API.
 * @param {string} url - Object URL or data URL to download
 * @param {string} filename - Target filename
 */
function triggerDownload(url, filename) {
  chrome.downloads.download({ url, filename, saveAs: true });
}

/**
 * Generate a formatted timestamp for filenames.
 * @returns {string} Compact timestamp
 */
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Format a byte count into a human-readable file size.
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Show an error message and hide the loading state.
 * @param {string} msg - Error message
 */
function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('error-container').style.display = 'block';
  document.getElementById('error-msg').textContent = `\u26A0\uFE0F ${msg}`;
}

/**
 * Clean up resources: revoke Object URLs and release blob.
 */
function cleanup() {
  if (videoBlobUrl) {
    URL.revokeObjectURL(videoBlobUrl);
    videoBlobUrl = null;
  }
  videoBlob = null;
}

// Cleanup on page hide (pagehide is preferred over beforeunload for bfcache compatibility)
window.addEventListener('pagehide', cleanup);

