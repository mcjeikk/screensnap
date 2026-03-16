/**
 * @file ScreenSnap — Shared Helper Functions
 * @description Utility functions used across multiple extension components.
 * Includes timestamp formatting, file size display, sanitization, and debouncing.
 * @version 0.5.0
 */

/**
 * Generate a formatted timestamp string for filenames.
 * @returns {string} Timestamp in YYYY-MM-DD_HH-MM-SS format
 *
 * @example
 * getTimestamp(); // "2026-03-16_14-30-05"
 */
export function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Format a byte count into a human-readable file size.
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format a duration in seconds to MM:SS display.
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted time string (e.g., "02:34")
 */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Generate a unique identifier using crypto.randomUUID.
 * @returns {string} UUID v4 string
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * Sanitize a filename by removing unsafe characters.
 * @param {string} name - Raw filename string
 * @returns {string} Cleaned filename safe for downloads
 */
export function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'untitled';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 200) || 'untitled';
}

/**
 * Sanitize user-provided text to prevent XSS when used in the DOM.
 * Strips HTML tags and trims whitespace.
 * @param {string} text - Raw user input
 * @returns {string} Sanitized plain text
 */
export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.textContent.trim();
}

/**
 * Create a debounced version of a function.
 * @param {Function} fn - Function to debounce
 * @param {number} delayMs - Delay in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(fn, delayMs) {
  let timerId = null;
  return function (...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn.apply(this, args), delayMs);
  };
}

/**
 * Create a throttled version of a function.
 * @param {Function} fn - Function to throttle
 * @param {number} limitMs - Minimum interval in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(fn, limitMs) {
  let lastRun = 0;
  let timerId = null;
  return function (...args) {
    const now = Date.now();
    const remaining = limitMs - (now - lastRun);
    clearTimeout(timerId);
    if (remaining <= 0) {
      lastRun = now;
      fn.apply(this, args);
    } else {
      timerId = setTimeout(() => {
        lastRun = Date.now();
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * Promise-based delay utility.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} Resolves after the delay
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Estimate the byte size of a base64 data URL.
 * @param {string} dataUrl - A base64-encoded data URL
 * @returns {number} Estimated size in bytes
 */
export function estimateDataUrlSize(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return 0;
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return 0;
  const base64Length = dataUrl.length - commaIndex - 1;
  return Math.round((base64Length * 3) / 4);
}

/**
 * Convert a base64 string to a Uint8Array.
 * @param {string} base64 - Base64-encoded string (without data URL prefix)
 * @returns {Uint8Array} Decoded byte array
 */
export function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Check if a tab URL is capturable (not a chrome:// or extension page).
 * @param {string} url - The tab URL to check
 * @returns {boolean} True if the page can be captured
 */
export function isCapturableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return !url.startsWith('chrome://') &&
         !url.startsWith('chrome-extension://') &&
         !url.startsWith('about:') &&
         !url.startsWith('edge://');
}

/**
 * Create a safe DOM element with text content (avoids innerHTML).
 * @param {string} tag - HTML tag name
 * @param {Object} [attrs={}] - Attributes to set
 * @param {string} [textContent=''] - Text content
 * @returns {HTMLElement} The created element
 */
export function createElement(tag, attrs = {}, textContent = '') {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      el.className = value;
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) {
        el.dataset[dk] = dv;
      }
    } else if (key.startsWith('aria')) {
      el.setAttribute(`aria-${key.slice(4).toLowerCase()}`, value);
    } else {
      el.setAttribute(key, value);
    }
  }
  if (textContent) {
    el.textContent = textContent;
  }
  return el;
}
