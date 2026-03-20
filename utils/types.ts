/**
 * @file ScreenBolt — Shared Type Definitions
 * @description Cross-module interfaces used by multiple files.
 */

/** Recording configuration passed from popup → SW → offscreen.
 *  This is a transformed shape built by the SW from user settings,
 *  not the raw settings object. */
export interface RecordingConfig {
  source: 'tab' | 'screen' | 'camera';
  streamId?: string;
  resolution: '720' | '1080' | '2160';
  format?: 'mp4' | 'webm';
  microphone: boolean;
  systemAudio: boolean;
  pip: boolean;
  pipPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  pipSize: 'small' | 'medium' | 'large';
}

/** User settings stored in chrome.storage.sync.
 *  Must match DEFAULT_SETTINGS in constants.ts exactly. */
export interface Settings {
  screenshotFormat: 'png' | 'jpg';
  jpgQuality: number;
  afterCapture: 'editor' | 'save' | 'clipboard';
  saveSubfolder: string;
  recResolution: '720' | '1080' | '2160';
  recAudio: 'microphone' | 'system' | 'both' | 'none';
  recPip: 'on' | 'off';
  recPipPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  recPipSize: 'small' | 'medium' | 'large';
  recCountdown: 'on' | 'off';
  recFormat: 'webm';
  theme: 'light' | 'dark' | 'system';
  notifications: 'on' | 'off';
  keepHistory: 'on' | 'off';
  maxHistory: number;
}

/** History entry stored in chrome.storage.local */
export interface HistoryEntry {
  id: string;
  type: 'screenshot' | 'recording';
  name: string;
  timestamp: number;
  width: number;
  height: number;
  sizeBytes: number;
  format: string;
  thumbnail: string | null;
  dataUrl: string | null;
  duration: number | null;
}

/** Error log entry stored by logger ring buffer */
export interface ErrorLogEntry {
  timestamp: string;
  module: string;
  level: string;
  message: string;
}
