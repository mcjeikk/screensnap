/**
 * @file ScreenSnap — Message Passing Utility
 * @description Type-safe message sending/receiving helpers and message validation.
 * Provides consistent message format across all extension components.
 * @version 0.5.0
 */

import { MESSAGE_TYPES } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('Messages');

/** @type {Set<string>} Set of all valid message types for validation */
const VALID_TYPES = new Set(Object.values(MESSAGE_TYPES));

/**
 * Send a message to the background service worker with standard format.
 * @param {string} action - Message action type (from MESSAGE_TYPES)
 * @param {Object} [payload={}] - Additional message data
 * @returns {Promise<Object>} Response from the service worker
 * @throws {Error} If the action type is invalid
 */
export async function sendMessage(action, payload = {}) {
  if (!VALID_TYPES.has(action)) {
    log.warn('Sending unknown message type:', action);
  }

  try {
    const response = await chrome.runtime.sendMessage({ action, ...payload });
    return response || { success: false, error: 'No response' };
  } catch (err) {
    log.error(`Message "${action}" failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a message to a specific tab's content script.
 * @param {number} tabId - Target tab ID
 * @param {string} action - Message action type
 * @param {Object} [payload={}] - Additional message data
 * @returns {Promise<Object>} Response from the content script
 */
export async function sendToTab(tabId, action, payload = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action, ...payload });
    return response || { success: true };
  } catch (err) {
    log.warn(`Message to tab ${tabId} failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Validate an incoming message has the expected structure.
 * @param {Object} message - The message object to validate
 * @returns {boolean} True if the message has a valid action field
 */
export function isValidMessage(message) {
  return message != null &&
         typeof message === 'object' &&
         typeof message.action === 'string' &&
         message.action.length > 0;
}

/**
 * Check if a message action is a known type.
 * @param {string} action - The action string to check
 * @returns {boolean} True if the action is in MESSAGE_TYPES
 */
export function isKnownAction(action) {
  return VALID_TYPES.has(action);
}
