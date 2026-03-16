/**
 * @file ScreenSnap — Logger Utility
 * @description Provides a structured logging system with levels and module prefixes.
 * Debug mode can be activated via storage setting.
 * @version 0.5.0
 */

import { EXTENSION_NAME } from './constants.js';

/** @enum {number} Log level numeric values for comparison */
const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
});

/**
 * Logger class with module-scoped prefixes and configurable level.
 */
class Logger {
  /** @type {string} */
  #module;

  /** @type {number} */
  #level;

  /**
   * @param {string} module - Module name to prefix in logs
   * @param {number} [level=LOG_LEVELS.INFO] - Minimum log level
   */
  constructor(module, level = LOG_LEVELS.INFO) {
    this.#module = module;
    this.#level = level;
  }

  /**
   * Set the minimum log level.
   * @param {number} level - One of LOG_LEVELS values
   */
  setLevel(level) {
    this.#level = level;
  }

  /**
   * Enable debug mode (show all log levels).
   */
  enableDebug() {
    this.#level = LOG_LEVELS.DEBUG;
  }

  /**
   * Internal logging method.
   * @param {number} level - Numeric log level
   * @param {string} levelName - Display name for the level
   * @param {...*} args - Values to log
   */
  #log(level, levelName, ...args) {
    if (level < this.#level) return;

    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = `[${timestamp}][${EXTENSION_NAME}][${this.#module}][${levelName}]`;

    switch (level) {
      case LOG_LEVELS.ERROR:
        console.error(prefix, ...args);
        break;
      case LOG_LEVELS.WARN:
        console.warn(prefix, ...args);
        break;
      case LOG_LEVELS.INFO:
        console.info(prefix, ...args);
        break;
      default:
        console.debug(prefix, ...args);
    }
  }

  /**
   * Log a debug-level message.
   * @param {...*} args - Values to log
   */
  debug(...args) {
    this.#log(LOG_LEVELS.DEBUG, 'DEBUG', ...args);
  }

  /**
   * Log an info-level message.
   * @param {...*} args - Values to log
   */
  info(...args) {
    this.#log(LOG_LEVELS.INFO, 'INFO', ...args);
  }

  /**
   * Log a warning-level message.
   * @param {...*} args - Values to log
   */
  warn(...args) {
    this.#log(LOG_LEVELS.WARN, 'WARN', ...args);
  }

  /**
   * Log an error-level message.
   * @param {...*} args - Values to log
   */
  error(...args) {
    this.#log(LOG_LEVELS.ERROR, 'ERROR', ...args);
  }
}

/**
 * Factory function to create a logger for a specific module.
 * @param {string} module - Module identifier (e.g., 'ServiceWorker', 'Editor', 'Popup')
 * @returns {Logger} Configured logger instance
 *
 * @example
 * import { createLogger } from '../utils/logger.js';
 * const log = createLogger('Editor');
 * log.info('Editor initialized');
 * log.error('Save failed', error);
 */
export function createLogger(module) {
  return new Logger(module);
}

export { LOG_LEVELS };
