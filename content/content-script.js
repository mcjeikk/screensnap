/**
 * @file ScreenSnap — Content Script
 * @description Handles selection overlay for area capture and full-page scroll-and-stitch capture.
 * Injected into web pages to interact with page DOM for capturing purposes.
 * Uses AbortController for clean event listener management.
 * @version 0.5.0
 */

(() => {
  'use strict';

  // Prevent double injection
  if (window.__screenSnapInjected) return;
  window.__screenSnapInjected = true;

  // ── Constants ───────────────────────────────────
  const MIN_SELECTION_SIZE = 5;
  const SCROLL_CAPTURE_DELAY_MS = 150;
  const LOG_PREFIX = '[ScreenSnap][Content]';

  // ── State ───────────────────────────────────────
  /** @type {HTMLElement|null} */
  let selectionOverlay = null;

  /** @type {boolean} */
  let isSelecting = false;

  /** @type {number} */
  let startX = 0;

  /** @type {number} */
  let startY = 0;

  /** @type {AbortController|null} */
  let selectionAbortController = null;

  // ── Context Validation ─────────────────────────────

  /**
   * Check if the extension context is still valid.
   * Returns false after extension update/reload while content script is still injected.
   * @returns {boolean}
   */
  function isContextValid() {
    try {
      chrome.runtime.getURL('');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Safely send a message to the service worker with context invalidation handling.
   * @param {Object} message - Message to send
   * @returns {Promise<*>} Response from the service worker
   */
  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (error.message?.includes('Extension context invalidated')) {
        console.warn(LOG_PREFIX, 'Extension was updated. Please refresh the page.');
        showRefreshBanner();
        return null;
      }
      if (error.message?.includes('Could not establish connection')) {
        console.warn(LOG_PREFIX, 'Service worker not available. Retrying...');
        // Retry once after a short delay (SW may be restarting)
        await delay(500);
        try {
          return await chrome.runtime.sendMessage(message);
        } catch {
          console.error(LOG_PREFIX, 'Retry failed — service worker unreachable');
          return null;
        }
      }
      throw error;
    }
  }

  /**
   * Show a non-intrusive banner asking the user to refresh the page.
   */
  function showRefreshBanner() {
    if (document.getElementById('screensnap-refresh-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'screensnap-refresh-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'padding:10px 20px;background:#4F46E5;color:#fff;text-align:center;' +
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;' +
      'font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    banner.textContent = 'ScreenSnap was updated. Please refresh this page to continue using it.';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:none;border:none;color:#fff;font-size:16px;cursor:pointer;' +
      'margin-left:16px;padding:0 4px;';
    closeBtn.addEventListener('click', () => banner.remove());
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
  }

  // ── Message Listener ──────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isContextValid()) return false;

    if (!message || typeof message.action !== 'string') {
      sendResponse({ success: false, error: 'Invalid message' });
      return false;
    }

    switch (message.action) {
      case 'start-selection':
        startSelectionMode();
        sendResponse({ success: true });
        break;

      case 'capture-full-page':
        captureFullPage().then(sendResponse);
        return true; // async response

      case 'capture-visible-for-stitch':
        sendResponse({
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          fullHeight: document.documentElement.scrollHeight,
          fullWidth: document.documentElement.scrollWidth,
        });
        break;

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    }
    return false;
  });

  // ── Selection Mode ────────────────────────────────

  /**
   * Activate the selection overlay for area capture.
   * Creates a full-viewport overlay with crosshair cursor.
   */
  function startSelectionMode() {
    removeSelectionOverlay();

    selectionAbortController = new AbortController();
    const { signal } = selectionAbortController;

    selectionOverlay = document.createElement('div');
    selectionOverlay.id = 'screensnap-overlay';

    // Build instructions with safe DOM API (no innerHTML for text-only elements)
    const selectionBox = document.createElement('div');
    selectionBox.id = 'screensnap-selection-box';
    selectionOverlay.appendChild(selectionBox);

    const instructions = document.createElement('div');
    instructions.id = 'screensnap-instructions';
    instructions.textContent = 'Click and drag to select area \u2022 ESC to cancel';
    selectionOverlay.appendChild(instructions);

    document.body.appendChild(selectionOverlay);

    // ── Mouse Events ──
    selectionOverlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0';
      selectionBox.style.height = '0';
    }, { signal });

    selectionOverlay.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;

      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);

      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${width}px`;
      selectionBox.style.height = `${height}px`;
    }, { signal });

    selectionOverlay.addEventListener('mouseup', async (e) => {
      if (!isSelecting) return;
      isSelecting = false;

      const rect = selectionBox.getBoundingClientRect();
      if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
        removeSelectionOverlay();
        return;
      }

      await captureSelection(rect);
    }, { signal });

    // ESC to cancel
    document.addEventListener('keydown', handleEscape, { signal });
  }

  /**
   * Handle Escape key to cancel selection mode.
   * @param {KeyboardEvent} e
   */
  function handleEscape(e) {
    if (e.key === 'Escape') {
      removeSelectionOverlay();
    }
  }

  /**
   * Remove the selection overlay and clean up all event listeners.
   */
  function removeSelectionOverlay() {
    if (selectionAbortController) {
      selectionAbortController.abort();
      selectionAbortController = null;
    }
    if (selectionOverlay) {
      selectionOverlay.remove();
      selectionOverlay = null;
    }
    isSelecting = false;
  }

  /**
   * Capture the selected area by requesting a visible tab capture and cropping.
   * @param {DOMRect} rect - The selection rectangle
   */
  async function captureSelection(rect) {
    removeSelectionOverlay();

    try {
      const response = await safeSendMessage({ action: 'capture-visible' });

      if (!response?.success || !response.dataUrl) {
        console.error(LOG_PREFIX, 'Failed to capture visible area');
        return;
      }

      const croppedDataUrl = await cropImage(
        response.dataUrl,
        rect.left,
        rect.top,
        rect.width,
        rect.height
      );

      await safeSendMessage({
        action: 'selection-data',
        dataUrl: croppedDataUrl,
        filename: `ScreenSnap_Selection_${getTimestamp()}.png`,
      });
    } catch (err) {
      console.error(LOG_PREFIX, 'Selection capture failed:', err);
    }
  }

  /**
   * Crop an image data URL to the specified rectangle.
   * Accounts for device pixel ratio for high-DPI displays.
   * @param {string} dataUrl - Source image data URL
   * @param {number} x - Left coordinate
   * @param {number} y - Top coordinate
   * @param {number} width - Crop width
   * @param {number} height - Crop height
   * @returns {Promise<string>} Cropped image as data URL
   */
  function cropImage(dataUrl, x, y, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = width * dpr;
        canvas.height = height * dpr;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(
          img,
          x * dpr, y * dpr, width * dpr, height * dpr,
          0, 0, width * dpr, height * dpr
        );

        const result = canvas.toDataURL('image/png');

        // Cleanup canvas memory
        canvas.width = 0;
        canvas.height = 0;

        resolve(result);
      };
      img.onerror = () => reject(new Error('Failed to load capture image for cropping'));
      img.src = dataUrl;
    });
  }

  /**
   * Capture the full page by scrolling through and stitching screenshots.
   * Saves and restores the original scroll position and overflow style.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function captureFullPage() {
    const fullHeight = document.documentElement.scrollHeight;
    const fullWidth = document.documentElement.scrollWidth;
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // Save original state
    const originalScrollY = window.scrollY;
    const originalOverflow = document.documentElement.style.overflow;

    // Hide scrollbar during capture
    document.documentElement.style.overflow = 'hidden';

    /** @type {Array<{dataUrl: string, scrollY: number, isLast: boolean}>} */
    const captures = [];
    const totalScrolls = Math.ceil(fullHeight / viewportHeight);

    try {
      for (let i = 0; i < totalScrolls; i++) {
        const scrollTo = Math.min(i * viewportHeight, fullHeight - viewportHeight);
        window.scrollTo(0, scrollTo);

        // Wait for scroll settle and re-paint
        await delay(SCROLL_CAPTURE_DELAY_MS);

        const response = await safeSendMessage({ action: 'capture-visible' });

        if (response?.success && response.dataUrl) {
          captures.push({
            dataUrl: response.dataUrl,
            scrollY: scrollTo,
            isLast: i === totalScrolls - 1,
          });
        }
      }

      const stitchedDataUrl = await stitchCaptures(captures, fullWidth, fullHeight, viewportHeight, dpr);

      // Restore original state
      window.scrollTo(0, originalScrollY);
      document.documentElement.style.overflow = originalOverflow;

      await safeSendMessage({
        action: 'full-page-data',
        dataUrl: stitchedDataUrl,
        filename: `ScreenSnap_FullPage_${getTimestamp()}.png`,
      });

      return { success: true };
    } catch (err) {
      // Always restore on error
      window.scrollTo(0, originalScrollY);
      document.documentElement.style.overflow = originalOverflow;
      console.error(LOG_PREFIX, 'Full page capture failed:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Stitch multiple viewport captures into one tall image.
   * @param {Array} captures - Array of capture objects with dataUrl, scrollY, isLast
   * @param {number} fullWidth - Total page width
   * @param {number} fullHeight - Total page height
   * @param {number} viewportHeight - Browser viewport height
   * @param {number} dpr - Device pixel ratio
   * @returns {Promise<string>} Stitched image as data URL
   */
  function stitchCaptures(captures, fullWidth, fullHeight, viewportHeight, dpr) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = fullWidth * dpr;
      canvas.height = fullHeight * dpr;
      const ctx = canvas.getContext('2d');

      let loaded = 0;
      const total = captures.length;

      if (total === 0) {
        reject(new Error('No captures to stitch'));
        return;
      }

      captures.forEach((capture) => {
        const img = new Image();
        img.onload = () => {
          const yPos = capture.scrollY * dpr;

          if (capture.isLast) {
            // Last capture might overlap — draw aligned to the bottom
            const bottomY = fullHeight * dpr - img.height;
            ctx.drawImage(img, 0, Math.max(0, bottomY));
          } else {
            ctx.drawImage(img, 0, yPos);
          }

          loaded++;
          if (loaded === total) {
            const result = canvas.toDataURL('image/png');

            // Cleanup canvas memory
            canvas.width = 0;
            canvas.height = 0;

            resolve(result);
          }
        };
        img.onerror = () => reject(new Error('Failed to load capture for stitching'));
        img.src = capture.dataUrl;
      });
    });
  }

  // ── Helpers ─────────────────────────────────────

  /**
   * Promise-based delay.
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate a formatted timestamp for filenames.
   * @returns {string} Timestamp in YYYY-MM-DD_HH-MM-SS format
   */
  function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }
})();
