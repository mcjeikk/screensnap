/**
 * ScreenBolt -- Content Script
 *
 * Handles selection overlay for area capture and full-page scroll-and-stitch
 * capture. Injected into web pages via chrome.scripting.executeScript to
 * interact with page DOM for capturing purposes.
 *
 * Uses AbortController for clean event listener management.
 *
 * Standalone file -- no imports from utils (runs in ISOLATED world as a
 * classic script, not as an ES module).
 */

// -- Window augmentation for double-injection guard --------------------
// Using `as any` instead of `declare global` to avoid needing `export {}`
// which causes CJS/ESM output that breaks in content script context.

// Prevent double injection
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((window as any).__screenBoltInjected) {
  throw new Error('ScreenBolt content script already injected');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__screenBoltInjected = true;

// -- Constants --------------------------------------------------------

const MIN_SELECTION_SIZE = 5;
const SCROLL_CAPTURE_DELAY_MS = 150;
const LOG_PREFIX = '[ScreenBolt][Content]';
/** Maximum page height (px) for full-page capture to prevent OOM */
const MAX_FULL_PAGE_HEIGHT = 15_000;

// -- Types ------------------------------------------------------------

interface CaptureVisibleResponse {
  success: boolean;
  dataUrl?: string;
}

interface CaptureEntry {
  dataUrl: string;
  scrollY: number;
  isLast: boolean;
}

interface FullPageResult {
  success: boolean;
  error?: string;
}

interface ScrollStitchInfo {
  scrollY: number;
  viewportHeight: number;
  fullHeight: number;
  fullWidth: number;
}

/** Inbound messages handled by this content script. */
type ContentMessage =
  | { action: 'start-selection' }
  | { action: 'capture-full-page' }
  | { action: 'capture-visible-for-stitch' };

// -- State ------------------------------------------------------------

let selectionOverlay: HTMLDivElement | null = null;
let isSelecting = false;
let startX = 0;
let startY = 0;
let selectionAbortController: AbortController | null = null;

// -- Context Validation -----------------------------------------------

/**
 * Check if the extension context is still valid.
 * Returns false after extension update/reload while content script is
 * still injected.
 */
function isContextValid(): boolean {
  try {
    chrome.runtime.getURL('');
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely send a message to the service worker with context invalidation
 * handling. Retries once if the service worker is temporarily unreachable.
 */
async function safeSendMessage<T = unknown>(message: Record<string, unknown>): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error: unknown) {
    const msg = (error as Error).message ?? '';

    if (msg.includes('Extension context invalidated')) {
      console.warn(LOG_PREFIX, 'Extension was updated. Please refresh the page.');
      showRefreshBanner();
      return null;
    }

    if (msg.includes('Could not establish connection')) {
      console.warn(LOG_PREFIX, 'Service worker not available. Retrying...');
      await delay(500);
      try {
        return await chrome.runtime.sendMessage(message);
      } catch {
        console.error(LOG_PREFIX, 'Retry failed -- service worker unreachable');
        return null;
      }
    }

    throw error;
  }
}

/** Show a non-intrusive banner asking the user to refresh the page. */
function showRefreshBanner(): void {
  if (document.getElementById('screenbolt-refresh-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'screenbolt-refresh-banner';
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
    'padding:10px 20px;background:#4F46E5;color:#fff;text-align:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;' +
    'font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  banner.textContent = 'ScreenBolt was updated. Please refresh this page to continue using it.';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u2715';
  closeBtn.style.cssText =
    'background:none;border:none;color:#fff;font-size:16px;cursor:pointer;' +
    'margin-left:16px;padding:0 4px;';
  closeBtn.addEventListener('click', () => banner.remove());

  banner.appendChild(closeBtn);
  document.body.appendChild(banner);
}

// -- Message Listener -------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage | null,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
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

      case 'capture-visible-for-stitch': {
        const info: ScrollStitchInfo = {
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          fullHeight: document.documentElement.scrollHeight,
          fullWidth: document.documentElement.scrollWidth,
        };
        sendResponse(info);
        break;
      }

      default:
        sendResponse({
          success: false,
          error: `Unknown action: ${(message as { action: string }).action}`,
        });
    }
    return false;
  },
);

// -- Selection Mode ---------------------------------------------------

/**
 * Activate the selection overlay for area capture.
 * Creates a full-viewport overlay with crosshair cursor.
 */
function startSelectionMode(): void {
  removeSelectionOverlay();

  selectionAbortController = new AbortController();
  const { signal } = selectionAbortController;

  selectionOverlay = document.createElement('div');
  selectionOverlay.id = 'screenbolt-overlay';

  // Build instructions with safe DOM API (no innerHTML for text-only elements)
  const selectionBox = document.createElement('div');
  selectionBox.id = 'screenbolt-selection-box';
  selectionOverlay.appendChild(selectionBox);

  const instructions = document.createElement('div');
  instructions.id = 'screenbolt-instructions';
  instructions.textContent = 'Click and drag to select area \u2022 ESC to cancel';
  selectionOverlay.appendChild(instructions);

  document.body.appendChild(selectionOverlay);

  // Mouse events
  selectionOverlay.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0';
      selectionBox.style.height = '0';
    },
    { signal },
  );

  selectionOverlay.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      if (!isSelecting) return;

      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);

      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${width}px`;
      selectionBox.style.height = `${height}px`;
    },
    { signal },
  );

  selectionOverlay.addEventListener(
    'mouseup',
    async (_e: MouseEvent) => {
      if (!isSelecting) return;
      isSelecting = false;

      const rect = selectionBox.getBoundingClientRect();
      if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
        removeSelectionOverlay();
        return;
      }

      await captureSelection(rect);
    },
    { signal },
  );

  // ESC to cancel
  document.addEventListener('keydown', handleEscape, { signal });
}

/** Handle Escape key to cancel selection mode. */
function handleEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    removeSelectionOverlay();
  }
}

/** Remove the selection overlay and clean up all event listeners. */
function removeSelectionOverlay(): void {
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

// -- Capture Logic ----------------------------------------------------

/** Capture the selected area by requesting a visible tab capture and cropping. */
async function captureSelection(rect: DOMRect): Promise<void> {
  removeSelectionOverlay();

  try {
    const response = await safeSendMessage<CaptureVisibleResponse>({ action: 'capture-visible' });

    if (!response?.success || !response.dataUrl) {
      console.error(LOG_PREFIX, 'Failed to capture visible area');
      return;
    }

    const croppedDataUrl = await cropImage(
      response.dataUrl,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    );

    await safeSendMessage({
      action: 'selection-data',
      dataUrl: croppedDataUrl,
      filename: `ScreenBolt_Selection_${getTimestamp()}.png`,
    });
  } catch (err) {
    console.error(LOG_PREFIX, 'Selection capture failed:', err);
  }
}

/**
 * Crop an image data URL to the specified rectangle.
 * Accounts for device pixel ratio for high-DPI displays.
 */
function cropImage(
  dataUrl: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = width * dpr;
      canvas.height = height * dpr;

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(
        img,
        x * dpr,
        y * dpr,
        width * dpr,
        height * dpr,
        0,
        0,
        width * dpr,
        height * dpr,
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
 */
async function captureFullPage(): Promise<FullPageResult> {
  const fullHeight = document.documentElement.scrollHeight;
  const fullWidth = document.documentElement.scrollWidth;
  const viewportHeight = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  // OOM guard: reject pages that are too tall for safe canvas stitching
  if (fullHeight > MAX_FULL_PAGE_HEIGHT) {
    console.warn(
      LOG_PREFIX,
      `Page height (${fullHeight}px) exceeds safe limit (${MAX_FULL_PAGE_HEIGHT}px) -- aborting full-page capture`,
    );
    return {
      success: false,
      error: `Page too large to capture (${fullHeight}px tall, max ${MAX_FULL_PAGE_HEIGHT}px). Try capturing the visible area instead.`,
    };
  }

  // Save original state
  const originalScrollY = window.scrollY;
  const originalOverflow = document.documentElement.style.overflow;

  // Hide scrollbar during capture
  document.documentElement.style.overflow = 'hidden';

  const captures: CaptureEntry[] = [];
  const totalScrolls = Math.ceil(fullHeight / viewportHeight);

  try {
    for (let i = 0; i < totalScrolls; i++) {
      const scrollTo = Math.min(i * viewportHeight, fullHeight - viewportHeight);
      window.scrollTo(0, scrollTo);

      // Wait for scroll settle and re-paint
      await delay(SCROLL_CAPTURE_DELAY_MS);

      const response = await safeSendMessage<CaptureVisibleResponse>({
        action: 'capture-visible',
      });

      if (response?.success && response.dataUrl) {
        captures.push({
          dataUrl: response.dataUrl,
          scrollY: scrollTo,
          isLast: i === totalScrolls - 1,
        });
      }
    }

    const stitchedDataUrl = await stitchCaptures(
      captures,
      fullWidth,
      fullHeight,
      viewportHeight,
      dpr,
    );

    // Restore original state
    window.scrollTo(0, originalScrollY);
    document.documentElement.style.overflow = originalOverflow;

    await safeSendMessage({
      action: 'full-page-data',
      dataUrl: stitchedDataUrl,
      filename: `ScreenBolt_FullPage_${getTimestamp()}.png`,
    });

    return { success: true };
  } catch (err) {
    // Always restore on error
    window.scrollTo(0, originalScrollY);
    document.documentElement.style.overflow = originalOverflow;
    console.error(LOG_PREFIX, 'Full page capture failed:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Stitch multiple viewport captures into one tall image.
 *
 * Images load in parallel; drawing order is determined by each entry's
 * scrollY, not by load order, so the final canvas is correct regardless
 * of which image decodes first.
 */
function stitchCaptures(
  captures: CaptureEntry[],
  fullWidth: number,
  fullHeight: number,
  _viewportHeight: number,
  dpr: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = fullWidth * dpr;
    canvas.height = fullHeight * dpr;
    const ctx = canvas.getContext('2d')!;

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
          // Last capture might overlap -- draw aligned to the bottom
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

// -- Helpers ----------------------------------------------------------

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a formatted timestamp for filenames (YYYY-MM-DD_HH-MM-SS). */
function getTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
