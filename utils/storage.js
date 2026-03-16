/**
 * @file ScreenSnap — Storage Utility
 * @description Wrapper around chrome.storage with error handling, defaults, and typed accessors.
 * Centralizes all storage operations for the extension.
 * @version 0.5.0
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('Storage');

/**
 * Load extension settings from chrome.storage.sync, merged with defaults.
 * @returns {Promise<Object>} The settings object with all defaults applied
 */
export async function getSettings() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  } catch (err) {
    log.error('Failed to load settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save extension settings to chrome.storage.sync.
 * @param {Object} settings - The full settings object to save
 * @returns {Promise<boolean>} True if save succeeded
 */
export async function saveSettings(settings) {
  try {
    await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
    return true;
  } catch (err) {
    log.error('Failed to save settings:', err);
    return false;
  }
}

/**
 * Load history entries from chrome.storage.local.
 * @returns {Promise<Array>} Array of history entry objects
 */
export async function getHistory() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.HISTORY_ENTRIES);
    return result[STORAGE_KEYS.HISTORY_ENTRIES] || [];
  } catch (err) {
    log.error('Failed to load history:', err);
    return [];
  }
}

/**
 * Save history entries to chrome.storage.local.
 * @param {Array} entries - The full array of history entries
 * @returns {Promise<boolean>} True if save succeeded
 */
export async function saveHistory(entries) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY_ENTRIES]: entries });
    return true;
  } catch (err) {
    log.error('Failed to save history:', err);
    if (err.message && err.message.includes('QUOTA_BYTES')) {
      log.warn('Storage quota exceeded — pruning oldest entries');
      const pruned = entries.slice(0, Math.floor(entries.length / 2));
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY_ENTRIES]: pruned });
        return true;
      } catch (retryErr) {
        log.error('Failed to save even after pruning:', retryErr);
      }
    }
    return false;
  }
}

/**
 * Add a single entry to the history, respecting max limit.
 * @param {Object} entry - The history entry to add
 * @param {number} [maxItems=100] - Maximum number of entries to keep
 * @returns {Promise<boolean>} True if save succeeded
 */
export async function addToHistory(entry, maxItems = 100) {
  const entries = await getHistory();
  entries.unshift(entry);

  while (entries.length > maxItems) {
    entries.pop();
  }

  return saveHistory(entries);
}

/**
 * Remove a single entry from history by ID.
 * @param {string} id - The entry ID to remove
 * @returns {Promise<Array>} Updated entries array
 */
export async function removeFromHistory(id) {
  const entries = await getHistory();
  const filtered = entries.filter(e => e.id !== id);
  await saveHistory(filtered);
  return filtered;
}

/**
 * Clear all history entries.
 * @returns {Promise<boolean>} True if clear succeeded
 */
export async function clearHistory() {
  return saveHistory([]);
}

/**
 * Get a value from chrome.storage.local.
 * @param {string} key - The storage key
 * @param {*} [defaultValue=null] - Default if key not found
 * @returns {Promise<*>} The stored value or default
 */
export async function getLocal(key, defaultValue = null) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? defaultValue;
  } catch (err) {
    log.error(`Failed to get local key "${key}":`, err);
    return defaultValue;
  }
}

/**
 * Set a value in chrome.storage.local.
 * @param {string} key - The storage key
 * @param {*} value - The value to store
 * @returns {Promise<boolean>} True if save succeeded
 */
export async function setLocal(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (err) {
    log.error(`Failed to set local key "${key}":`, err);
    return false;
  }
}

/**
 * Set multiple values in chrome.storage.local at once.
 * @param {Object} items - Key-value pairs to store
 * @returns {Promise<boolean>} True if save succeeded
 */
export async function setLocalBatch(items) {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch (err) {
    log.error('Failed to batch set local storage:', err);
    return false;
  }
}

/**
 * Get multiple values from chrome.storage.local.
 * @param {string[]} keys - Array of storage keys
 * @returns {Promise<Object>} Object with key-value pairs
 */
export async function getLocalBatch(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    log.error('Failed to batch get local storage:', err);
    return {};
  }
}

/**
 * Remove keys from chrome.storage.local.
 * @param {string|string[]} keys - Key(s) to remove
 * @returns {Promise<boolean>} True if removal succeeded
 */
export async function removeLocal(keys) {
  try {
    await chrome.storage.local.remove(keys);
    return true;
  } catch (err) {
    log.error('Failed to remove local keys:', err);
    return false;
  }
}
