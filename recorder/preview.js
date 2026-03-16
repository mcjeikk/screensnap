/**
 * ScreenSnap — Preview Script
 * Loads recorded video from storage, plays it, and offers download in WebM or MP4.
 */

let videoBlob = null;
let videoMimeType = 'video/webm';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadRecording();
    bindButtons();
  } catch (err) {
    showError('Failed to load recording: ' + err.message);
  }
});

// ── Load Recording from Storage ─────────────────────

async function loadRecording() {
  // Read chunk count and metadata
  const meta = await chrome.storage.local.get([
    'pendingRecording',
    'recording-chunks-count',
    'recording-mime'
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

  // Reassemble blob
  const parts = [];
  let totalLength = 0;
  for (let i = 0; i < chunkCount; i++) {
    const arr = chunkData[`recording-chunk-${i}`];
    if (!arr) throw new Error(`Missing chunk ${i}`);
    totalLength += arr.length;
    parts.push(new Uint8Array(arr));
  }

  // Combine into single Uint8Array
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  videoBlob = new Blob([combined], { type: videoMimeType });

  // Set up video player
  const video = document.getElementById('preview-video');
  video.src = URL.createObjectURL(videoBlob);

  // Display metadata
  if (info) {
    const durationSec = Math.floor((info.duration || 0) / 1000);
    const mm = String(Math.floor(durationSec / 60)).padStart(2, '0');
    const ss = String(durationSec % 60).padStart(2, '0');
    document.getElementById('meta-duration').textContent = `${mm}:${ss}`;
  }

  document.getElementById('meta-size').textContent = formatFileSize(videoBlob.size);
  document.getElementById('meta-format').textContent = videoMimeType.includes('webm') ? 'WebM' : videoMimeType;

  // Show content
  document.getElementById('loading').style.display = 'none';
  document.getElementById('preview-content').style.display = 'block';

  // Clean up storage (keep blob in memory)
  cleanupStorage(chunkCount);
}

/** Remove recording chunks from storage */
async function cleanupStorage(chunkCount) {
  const keys = ['pendingRecording', 'recording-chunks-count', 'recording-mime'];
  for (let i = 0; i < chunkCount; i++) {
    keys.push(`recording-chunk-${i}`);
  }
  await chrome.storage.local.remove(keys);
}

// ── Button Handlers ─────────────────────────────────

function bindButtons() {
  document.getElementById('btn-download-webm').addEventListener('click', downloadWebM);
  document.getElementById('btn-download-mp4').addEventListener('click', downloadMP4);
  document.getElementById('btn-discard').addEventListener('click', discard);
}

/** Download as WebM (native format) */
function downloadWebM() {
  if (!videoBlob) return;
  const url = URL.createObjectURL(videoBlob);
  triggerDownload(url, `ScreenSnap_${getTimestamp()}.webm`);
  URL.revokeObjectURL(url);
}

/** Download as MP4 using ffmpeg.wasm (lazy loaded) */
async function downloadMP4() {
  if (!videoBlob) return;

  const progressContainer = document.getElementById('mp4-progress');
  const progressBar = document.getElementById('mp4-progress-bar');
  const statusText = document.getElementById('mp4-status');
  const btn = document.getElementById('btn-download-mp4');

  btn.disabled = true;
  progressContainer.style.display = 'block';
  statusText.textContent = 'Loading ffmpeg.wasm from CDN…';
  progressBar.style.width = '10%';

  try {
    // Lazy-load ffmpeg.wasm
    const { FFmpeg } = await import(
      /* webpackIgnore: true */
      'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm'
    );
    const { fetchFile, toBlobURL } = await import(
      /* webpackIgnore: true */
      'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm'
    );

    progressBar.style.width = '25%';
    statusText.textContent = 'Initializing ffmpeg…';

    const ffmpeg = new FFmpeg();

    ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.min(95, 30 + progress * 65);
      progressBar.style.width = pct + '%';
      statusText.textContent = `Converting… ${Math.round(progress * 100)}%`;
    });

    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    progressBar.style.width = '30%';
    statusText.textContent = 'Converting to MP4…';

    // Write input file
    const inputData = await fetchFile(videoBlob);
    await ffmpeg.writeFile('input.webm', inputData);

    // Convert
    await ffmpeg.exec(['-i', 'input.webm', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', 'output.mp4']);

    // Read output
    const data = await ffmpeg.readFile('output.mp4');
    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });

    progressBar.style.width = '100%';
    statusText.textContent = 'Done! Downloading…';

    const url = URL.createObjectURL(mp4Blob);
    triggerDownload(url, `ScreenSnap_${getTimestamp()}.mp4`);
    URL.revokeObjectURL(url);

    // Cleanup
    await ffmpeg.deleteFile('input.webm');
    await ffmpeg.deleteFile('output.mp4');

    setTimeout(() => {
      progressContainer.style.display = 'none';
      btn.disabled = false;
    }, 2000);

  } catch (err) {
    console.error('[ScreenSnap] MP4 conversion failed:', err);
    statusText.textContent = '❌ Conversion failed: ' + err.message;
    progressBar.style.width = '0%';
    btn.disabled = false;
  }
}

/** Discard recording and close tab */
function discard() {
  if (confirm('Discard this recording? This cannot be undone.')) {
    videoBlob = null;
    window.close();
  }
}

// ── Helpers ─────────────────────────────────────────

function triggerDownload(url, filename) {
  chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
}

function getTimestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '_',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0')
  ].join('');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('error-container').style.display = 'block';
  document.getElementById('error-msg').textContent = '⚠️ ' + msg;
}
