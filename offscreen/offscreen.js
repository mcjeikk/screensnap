/**
 * @file ScreenSnap — Offscreen Document
 * @description Handles clipboard operations that require DOM access.
 * MV3 service workers cannot access the clipboard API directly,
 * so this offscreen document acts as a proxy for clipboard writes.
 * @version 0.5.0
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== 'offscreen-copy-clipboard') {
    return false;
  }

  if (!message.dataUrl || typeof message.dataUrl !== 'string') {
    sendResponse({ success: false, error: 'Missing or invalid dataUrl' });
    return false;
  }

  copyImageToClipboard(message.dataUrl)
    .then(() => sendResponse({ success: true }))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true; // Keep channel open for async response
});

/**
 * Copy an image data URL to the system clipboard.
 * @param {string} dataUrl - Image data URL to copy
 * @returns {Promise<void>}
 * @throws {Error} If clipboard write fails
 */
async function copyImageToClipboard(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': blob }),
  ]);
}
