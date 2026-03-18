/**
 * ScreenBolt — Preview Script
 *
 * Loads recorded video from IndexedDB, provides playback preview,
 * and offers download in WebM or MP4. Properly revokes Object URLs on cleanup.
 */

import { getTimestamp, formatFileSize } from '../utils/helpers.js';
import { getRecording, deleteRecording } from '../utils/idb-storage.js';
import type { RecordingEntry } from '../utils/idb-storage.js';

// -- Constants ---------------------------------------------------------------

const LOG_PREFIX = '[ScreenBolt][Preview]';
const RECORDING_ID = 'pending-recording';

// -- State -------------------------------------------------------------------

let videoBlob: Blob | null = null;
let videoMimeType = 'video/webm';
/** Object URL for the video element — must be revoked on cleanup. */
let videoBlobUrl: string | null = null;

// -- Init --------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadRecording();
    bindButtons();
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
}

/** Download the recording in its native format and clean up IndexedDB. */
function downloadRecording(): void {
  if (!videoBlob) return;
  const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(videoBlob);
  triggerDownload(url, `ScreenBolt_${getTimestamp()}.${ext}`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
