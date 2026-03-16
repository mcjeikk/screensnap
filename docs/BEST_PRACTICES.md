# Chrome Extension Best Practices — Guía Definitiva para ScreenSnap

> Documento de referencia para el desarrollo profesional de extensiones Chrome MV3.
> Basado en documentación oficial de Chrome, Mozilla Extension Workshop, Microsoft Edge docs, y mejores prácticas de la industria.
> Fecha de compilación: 2026-03-16 | Última actualización: 2026-03-16

---

## Tabla de Contenidos

1. [Arquitectura de Extensiones Profesionales](#1-arquitectura-de-extensiones-profesionales)
2. [Service Worker Lifecycle Deep Dive](#2-service-worker-lifecycle-deep-dive)
3. [Seguridad](#3-seguridad)
4. [Performance](#4-performance)
5. [Código Profesional](#5-código-profesional)
6. [chrome.scripting API — Dynamic Injection](#6-chromescripting-api--dynamic-injection)
7. [Side Panel API](#7-side-panel-api)
8. [UX/UI](#8-uxui)
9. [Testing Strategy](#9-testing-strategy)
10. [Chrome Web Store Publishing Guide](#10-chrome-web-store-publishing-guide)
11. [Cross-Browser Compatibility](#11-cross-browser-compatibility)
12. [Anti-Patrones — Qué NO Hacer](#12-anti-patrones--qué-no-hacer)
13. [Error Recovery Patterns](#13-error-recovery-patterns)
14. [Audit Checklist para ScreenSnap](#14-audit-checklist-para-screensnap)

---

## 1. Arquitectura de Extensiones Profesionales

### 1.1 Componentes y Separación de Concerns

Una extensión Chrome MV3 profesional tiene estos componentes claramente separados:

| Componente | Responsabilidad | DOM Access | Extension APIs |
|---|---|---|---|
| **Service Worker** (background) | Lógica central, event handling, coordinación | ❌ No | ✅ Todas |
| **Content Scripts** | Interactuar con páginas web | ✅ Página web | ⚠️ Limitado (storage, runtime, i18n, dom) |
| **Popup** | UI rápida del toolbar | ✅ Propio | ✅ Todas |
| **Side Panel** | UI persistente lateral | ✅ Propio | ✅ Todas |
| **Extension Pages** (options, editor, etc.) | UI compleja, configuración | ✅ Propio | ✅ Todas |
| **Offscreen Documents** | DOM APIs sin UI visible | ✅ Propio | ⚠️ Solo runtime |

**Regla de oro:** Cada componente debe tener UNA responsabilidad clara.

```
screensnap/
├── manifest.json
├── background/           # Service Worker — coordinación y lógica central
│   └── service-worker.js
├── content/              # Content scripts — interacción con páginas
│   ├── content-script.js
│   └── content-style.css
├── popup/                # UI del popup
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── sidepanel/            # Side Panel UI (Chrome 114+)
│   ├── sidepanel.html
│   ├── sidepanel.js
│   └── sidepanel.css
├── offscreen/            # Offscreen documents — DOM APIs sin UI
│   ├── offscreen.html
│   └── offscreen.js
├── shared/               # Módulos compartidos
│   ├── constants.js
│   ├── storage-manager.js
│   ├── message-types.js
│   └── utils.js
├── pages/                # Extension pages (editor, history, etc.)
│   ├── editor/
│   ├── history/
│   └── settings/
├── assets/
│   ├── icons/
│   ├── styles/
│   └── _locales/         # i18n
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 1.2 Patrones de Diseño Recomendados

#### Module Pattern con ES Modules

MV3 soporta ES modules en service workers si `"type": "module"` está en el manifest:

```json
{
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  }
}
```

```javascript
// shared/constants.js
export const MESSAGE_TYPES = Object.freeze({
  CAPTURE_VISIBLE: 'capture-visible',
  CAPTURE_FULL: 'capture-full',
  CAPTURE_SELECTION: 'capture-selection',
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  RECORDING_STATUS: 'recording-status',
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  HISTORY: 'capture-history',
  RECORDING_STATE: 'recording-state',
});
```

#### Pub/Sub Pattern para Message Passing

Implementar un router de mensajes centralizado en el service worker:

```javascript
// background/message-router.js
const handlers = new Map();

export function registerHandler(type, handler) {
  if (handlers.has(type)) {
    console.warn(`Handler already registered for: ${type}`);
  }
  handlers.set(type, handler);
}

export function initMessageRouter() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message;
    const handler = handlers.get(type);

    if (!handler) {
      console.warn(`No handler for message type: ${type}`);
      return false;
    }

    // Support async handlers
    const result = handler(payload, sender);
    if (result instanceof Promise) {
      result
        .then(response => sendResponse({ success: true, data: response }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response
    }

    sendResponse({ success: true, data: result });
    return false;
  });
}
```

```javascript
// background/service-worker.js
import { initMessageRouter, registerHandler } from './message-router.js';
import { MESSAGE_TYPES } from '../shared/constants.js';
import { handleCaptureVisible } from './handlers/capture.js';
import { handleStartRecording, handleStopRecording } from './handlers/recording.js';

registerHandler(MESSAGE_TYPES.CAPTURE_VISIBLE, handleCaptureVisible);
registerHandler(MESSAGE_TYPES.START_RECORDING, handleStartRecording);
registerHandler(MESSAGE_TYPES.STOP_RECORDING, handleStopRecording);

initMessageRouter();
```

#### State Management Pattern

Para estado compartido entre componentes, usar `chrome.storage.session` (en memoria, rápido) para estado efímero y `chrome.storage.local` para persistente:

```javascript
// shared/state-manager.js
export class StateManager {
  #cache = {};
  #storageArea;
  #listeners = new Map();

  constructor(storageArea = 'session') {
    this.#storageArea = chrome.storage[storageArea];
    this.#initListener();
  }

  #initListener() {
    this.#storageArea.onChanged.addListener((changes) => {
      for (const [key, { newValue }] of Object.entries(changes)) {
        this.#cache[key] = newValue;
        const callbacks = this.#listeners.get(key) || [];
        callbacks.forEach(cb => cb(newValue));
      }
    });
  }

  async get(key, defaultValue = null) {
    if (key in this.#cache) return this.#cache[key];
    const result = await this.#storageArea.get(key);
    this.#cache[key] = result[key] ?? defaultValue;
    return this.#cache[key];
  }

  async set(key, value) {
    this.#cache[key] = value;
    await this.#storageArea.set({ [key]: value });
  }

  onChange(key, callback) {
    if (!this.#listeners.has(key)) {
      this.#listeners.set(key, []);
    }
    this.#listeners.get(key).push(callback);
    return () => {
      const cbs = this.#listeners.get(key);
      const idx = cbs.indexOf(callback);
      if (idx !== -1) cbs.splice(idx, 1);
    };
  }
}
```

### 1.3 Comunicación entre Componentes

#### One-time Messages (Simple requests)

```javascript
// Desde content script o popup → service worker
const response = await chrome.runtime.sendMessage({
  type: MESSAGE_TYPES.CAPTURE_VISIBLE,
  payload: { format: 'png', quality: 0.95 }
});

if (!response.success) {
  console.error('Capture failed:', response.error);
}
```

#### Long-lived Connections (Streaming data)

Ideal para screen recording donde necesitas comunicación continua:

```javascript
// content-script.js — Abrir conexión para recording updates
const port = chrome.runtime.connect({ name: 'recording-channel' });

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'recording-started':
      showRecordingIndicator();
      break;
    case 'recording-time-update':
      updateTimer(msg.elapsed);
      break;
    case 'recording-stopped':
      hideRecordingIndicator();
      break;
  }
});

port.onDisconnect.addListener(() => {
  // Cleanup on disconnect
  hideRecordingIndicator();
});
```

```javascript
// service-worker.js — Manejar conexiones
const recordingPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'recording-channel') return;

  recordingPorts.add(port);

  port.onDisconnect.addListener(() => {
    recordingPorts.delete(port);
  });

  port.onMessage.addListener((msg) => {
    // Handle messages from content script
  });
});

// Broadcast to all connected ports
function broadcastRecordingStatus(status) {
  for (const port of recordingPorts) {
    try {
      port.postMessage(status);
    } catch (e) {
      recordingPorts.delete(port);
    }
  }
}
```

### 1.4 Offscreen Documents

Offscreen documents provide DOM access when the service worker needs it (e.g., for audio/video processing, canvas manipulation, or clipboard access). **Only one offscreen document can exist at a time per extension.**

```javascript
// background/offscreen-manager.js
let creating = null;

async function ensureOffscreenDocument(path, reasons, justification) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)]
  });

  if (existingContexts.length > 0) return;

  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: reasons,
      justification: justification
    });
    await creating;
    creating = null;
  }
}

// Usage for ScreenSnap recording
await ensureOffscreenDocument(
  'offscreen/offscreen.html',
  ['USER_MEDIA', 'DISPLAY_MEDIA'],
  'Recording tab audio and video'
);

// Close when done to free resources
async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}
```

**Valid reasons for offscreen documents:**

| Reason | Use Case |
|---|---|
| `TESTING` | Testing purposes |
| `AUDIO_PLAYBACK` | Playing audio |
| `IFRAME_SCRIPTING` | Interacting with iframes |
| `DOM_SCRAPING` | DOM manipulation |
| `BLOBS` | Working with Blob URLs |
| `DOM_PARSER` | Parsing DOM (DOMParser) |
| `USER_MEDIA` | getUserMedia() |
| `DISPLAY_MEDIA` | getDisplayMedia() |
| `WEB_RTC` | WebRTC connections |
| `CLIPBOARD` | Clipboard access |
| `LOCAL_STORAGE` | localStorage access |
| `WORKERS` | Spawning web workers |
| `BATTERY_STATUS` | Battery API |
| `MATCH_MEDIA` | matchMedia() queries |
| `GEOLOCATION` | Geolocation API |

### 1.5 Error Handling y Recovery

```javascript
// shared/errors.js
export class ExtensionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ExtensionError';
    this.code = code;
    this.details = details;
  }
}

export const ErrorCodes = Object.freeze({
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  RECORDING_FAILED: 'RECORDING_FAILED',
  STORAGE_FULL: 'STORAGE_FULL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  OFFSCREEN_FAILED: 'OFFSCREEN_FAILED',
  SW_TERMINATED: 'SW_TERMINATED',
  CONTEXT_INVALIDATED: 'CONTEXT_INVALIDATED',
});

// Wrapper para chrome API calls con retry
export async function chromeApiCall(apiFn, ...args) {
  try {
    const result = await apiFn(...args);
    if (chrome.runtime.lastError) {
      throw new ExtensionError(
        chrome.runtime.lastError.message,
        'CHROME_API_ERROR'
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(error.message, 'UNEXPECTED_ERROR', { original: error });
  }
}
```

```javascript
// Uso con retry pattern
export async function withRetry(fn, { maxRetries = 3, delay = 1000, backoff = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay * Math.pow(backoff, attempt)));
      }
    }
  }
  throw lastError;
}
```

---

## 2. Service Worker Lifecycle Deep Dive

### 2.1 Lifecycle Events (In Order)

The extension service worker follows this lifecycle:

1. **`install`** (standard SW event) — Fired when the SW is first installed
2. **`chrome.runtime.onInstalled`** — Fired when extension is installed/updated or Chrome is updated
3. **`activate`** (standard SW event) — Fired immediately after install (unlike web SWs, no page reload needed)
4. **`chrome.runtime.onStartup`** — Fired when a user profile starts (no SW events invoked)

```javascript
// Correct order of event registration — GLOBAL SCOPE, not nested!
// ⚠️ Event handlers MUST be registered synchronously at top level

// ✅ CORRECT — Top-level registration
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'pages/welcome/welcome.html' });
    initDefaultSettings();
  } else if (details.reason === 'update') {
    migrateData(details.previousVersion);
  }
});

chrome.action.onClicked.addListener(handleActionClick);
chrome.alarms.onAlarm.addListener(handleAlarm);

// ❌ WRONG — Nested registration (may miss events!)
chrome.storage.local.get(['badgeText'], ({ badgeText }) => {
  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.onClicked.addListener(handleActionClick); // ← TOO LATE!
});
```

### 2.2 Termination Rules

Chrome terminates service workers under these conditions:

| Condition | Timer | Notes |
|---|---|---|
| **Inactivity** | 30 seconds | Receiving an event or calling an extension API resets this timer |
| **Single request** | 5 minutes max | A single event or API call cannot take longer |
| **fetch() response** | 30 seconds | Time for a fetch() response to arrive |

**Important:** All extension events and Chrome API calls reset the 30-second idle timer (since Chrome 110).

### 2.3 Chrome Version Improvements Timeline

Understanding which Chrome version introduced which improvement is critical for setting `minimum_chrome_version`:

| Chrome Version | Improvement |
|---|---|
| **105** | `chrome.runtime.connectNative()` keeps SW alive |
| **109** | Messages from offscreen documents reset timers |
| **110** | All extension API calls reset idle timer; SW stays alive while actively processing events |
| **114** | Sending messages with long-lived messaging (`runtime.connect`) keeps SW alive |
| **116** | WebSocket connections extend SW lifetimes; `desktopCapture.chooseDesktopMedia()`, `identity.launchWebAuthFlow()`, `management.uninstall()`, `permissions.request()` bypass 5-min timeout |
| **118** | Active `chrome.debugger` sessions keep SW alive |
| **120** | `chrome.alarms` minimum period reduced to 30 seconds |

### 2.4 Keepalive Strategies

#### For Recording Sessions (Critical for ScreenSnap)

```javascript
// Strategy 1: chrome.alarms keepalive (works in all MV3 versions)
function startKeepAlive() {
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 }); // Every 24s
}

function stopKeepAlive() {
  chrome.alarms.clear('sw-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sw-keepalive') {
    // Just receiving the event keeps SW alive — no-op is fine
  }
});

// Strategy 2: Long-lived port connections (Chrome 114+)
// A connected port keeps the SW alive as long as messages are being sent
function keepAliveViaPort() {
  const port = chrome.runtime.connect({ name: 'keepalive' });
  port.onDisconnect.addListener(() => {
    // Reconnect if still needed
    if (isRecording) keepAliveViaPort();
  });
}

// Strategy 3: WebSocket (Chrome 116+)
// Active WebSocket connections extend SW lifetime
// Sending or receiving messages resets the idle timer
const ws = new WebSocket('wss://your-server.com/recording');
ws.onmessage = () => { /* resets timer */ };
```

#### Persist State for Unexpected Termination

```javascript
// Always save state that must survive SW termination
async function saveRecordingState(state) {
  await chrome.storage.session.set({
    recordingState: {
      isRecording: state.isRecording,
      startTime: state.startTime,
      tabId: state.tabId,
      settings: state.settings,
      timestamp: Date.now()
    }
  });
}

// On SW startup, check for orphaned recording state
async function recoverRecordingState() {
  const { recordingState } = await chrome.storage.session.get('recordingState');
  if (recordingState?.isRecording) {
    console.warn('SW was terminated during recording. Attempting recovery...');
    // Check if the tab still exists
    try {
      const tab = await chrome.tabs.get(recordingState.tabId);
      // Tab exists — notify user that recording was interrupted
      await chrome.notifications.create('recording-interrupted', {
        type: 'basic',
        iconUrl: 'assets/icons/icon-128.png',
        title: 'Recording Interrupted',
        message: 'The recording was interrupted. Please try again.',
      });
    } catch {
      // Tab no longer exists
    }
    // Clean up state
    await chrome.storage.session.remove('recordingState');
  }
}
```

### 2.5 Storage Options for Persistence

| Storage | Limit | Persistence | Speed | Use Case |
|---|---|---|---|---|
| `chrome.storage.session` | 10 MB | In-memory only | ⚡ Fast | Ephemeral state (recording status, UI state) |
| `chrome.storage.local` | 10 MB (or unlimited) | Disk, survives restart | 🔵 Normal | Settings, history, metadata |
| `chrome.storage.sync` | ~100 KB total, 8 KB/item | Syncs across devices | 🟡 Slower | User preferences, small config |
| `IndexedDB` | Large (browser-managed) | Disk | 🔵 Normal | Large blobs, images, video data |
| `CacheStorage` | Large (browser-managed) | Disk | 🔵 Normal | Network request/response caching |

### 2.6 Event Registration Best Practices

```javascript
// ✅ Register ALL event handlers at top level, synchronously
// This ensures Chrome can dispatch events to the SW as soon as it starts

// Filters reduce unnecessary event calls
const navigationFilter = {
  url: [{ urlMatches: 'https://www.example.com/' }]
};

chrome.webNavigation.onCompleted.addListener((details) => {
  console.log('User navigated to target site');
}, navigationFilter);

// ✅ Use webNavigation with filters instead of tabs.onUpdated
// tabs.onUpdated fires on EVERY tab update, webNavigation can be filtered

// ✅ Prefer extension messaging over ServiceWorkerGlobal.message
// They are NOT interoperable — messages from sendMessage() are not
// intercepted by SW message handlers and vice versa
```

---

## 3. Seguridad

### 3.1 Content Security Policy (CSP) para MV3

MV3 impone un CSP más estricto. El `"extension_pages"` field solo permite:

- `self`
- `none`
- `wasm-unsafe-eval`
- Localhost (solo para desarrollo/extensiones desempaquetadas)

**No se permite:** `unsafe-eval`, `unsafe-inline`, CDNs remotos, o código remoto.

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'",
    "sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';"
  }
}
```

**Regla fundamental MV3:** Todo el código debe estar bundled en la extensión. No se puede cargar JS desde servidores externos.

### 3.2 Permissions — Principle of Least Privilege

#### Permission Categories

```json
{
  "permissions": ["activeTab", "storage"],        // Required at install time
  "optional_permissions": ["tabCapture"],          // Requested at runtime
  "host_permissions": ["https://api.example.com/*"], // Host access at install
  "optional_host_permissions": ["https://*/*"]     // Host access at runtime
}
```

#### activeTab vs host_permissions — Detailed Tradeoffs

| Feature | `activeTab` | `host_permissions` |
|---|---|---|
| **Warning** | ❌ No install warning | ⚠️ Shows warning |
| **Scope** | Current tab only, on user gesture | All matching URLs, always |
| **Duration** | Until user navigates away or closes tab | Permanent |
| **Trigger** | Action click, context menu, keyboard shortcut, omnibox | Always available |
| **Use case** | One-time actions (capture, inject on click) | Background monitoring, automatic injection |
| **Security** | Much safer — requires user gesture | Higher risk if extension is compromised |

```javascript
// activeTab — User clicks action icon, then we inject
// No install warning, temporary access only
chrome.action.onClicked.addListener(async (tab) => {
  // activeTab gives us temporary permission for this tab
  if (!tab.url.startsWith('chrome://')) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js']
    });
  }
});

// host_permissions — Needed when you must act WITHOUT user gesture
// Example: auto-inject content script on specific domains
// Shows warning: "Read and change your data on [matched sites]"
```

**For ScreenSnap:** Use `activeTab` + `scripting` for on-demand capture. The user clicks the extension, which triggers capture. No need for `<all_urls>` or declarative content scripts.

#### Permissions That Trigger Warnings

High-warning permissions that increase review time:

- `<all_urls>`, `https://*/*`, `http://*/*` — "Read and change all your data on all websites"
- `tabs` — "Read your browsing history" (because it exposes URL/title)
- `webRequest` + host permissions — "Read and change data on websites"
- `bookmarks` — "Read and change your bookmarks"
- `history` — "Read and change your browsing history"
- `downloads` — "Manage your downloads"

**Best practice:** Use `optional_permissions` for everything not needed at install time:

```javascript
// Request permissions only when the user needs the feature
async function requestRecordingPermission() {
  const granted = await chrome.permissions.request({
    permissions: ['tabCapture', 'desktopCapture']
  });

  if (!granted) {
    showMessage('Recording permissions are required for this feature');
    return false;
  }
  return true;
}

// Check if we have permissions before using them
async function hasRecordingPermission() {
  return chrome.permissions.contains({
    permissions: ['tabCapture', 'desktopCapture']
  });
}
```

### 3.3 Content Script Isolated World — Deep Dive

Content scripts run in an **isolated world**: they share the DOM with the page but have separate JavaScript execution environments.

**What this means:**

- Content scripts see the same DOM elements as the page
- They have their **own JavaScript global scope** (separate `window`, `document.defaultView`)
- Page scripts cannot access content script variables and vice versa
- Both can modify the DOM, but their JS does not collide

```javascript
// Page has: window.myApp = { data: 'secret' };
// Content script CANNOT access window.myApp — isolated world!

// But both see the same DOM:
// Content script can read: document.getElementById('output').textContent
// This is the SAME element the page sees

// ⚠️ Security implications:
// 1. Page can modify DOM that content scripts read — never trust DOM data
// 2. Page can set custom properties on DOM elements
// 3. Page can override native DOM methods (prototype pollution)

// ✅ SAFE: Use Chrome messaging to communicate between content script and SW
chrome.runtime.sendMessage({ type: 'page-data', data: sanitizedData });

// ❌ DANGEROUS: Reading data from page-controlled DOM without validation
const userInput = document.querySelector('#user-form input').value;
// This value comes from the page — treat it as untrusted!
```

**Execution Worlds (Chrome 95+):**

```javascript
// You can choose which world a content script runs in
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => {
    // This runs in MAIN world — same as the page!
    // Can access page's JS variables directly
    return window.myApp?.data;
  },
  world: 'MAIN'  // or 'ISOLATED' (default)
});
```

**MAIN world** is useful for accessing page JS objects but is DANGEROUS — the page can see and interfere with your code. Only use when absolutely necessary.

### 3.4 Sanitización de Inputs

**Nunca** insertar HTML no sanitizado, especialmente en content scripts:

```javascript
// ❌ PELIGROSO — XSS vulnerability
element.innerHTML = userInput;
document.write(untrustedData);

// ✅ SEGURO — Usar DOM APIs safe
const textNode = document.createTextNode(userInput);
element.appendChild(textNode);

// ✅ SEGURO — setAttribute para atributos
element.setAttribute('title', userInput);

// ✅ SEGURO — textContent para texto
element.textContent = userInput;
```

**Para HTML dinámico, usar DOMPurify:**

```javascript
import DOMPurify from './lib/dompurify.min.js';

const cleanHTML = DOMPurify.sanitize(dirtyHTML, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
  ALLOWED_ATTR: ['href', 'title']
});
element.innerHTML = cleanHTML;
```

### 3.5 XSS Prevention en Extensiones

1. **Nunca usar `eval()`, `new Function()`, o `setTimeout(string)`** en extension pages
2. **No insertar scripts remotos** — todo debe ser local (MV3 requirement)
3. **Usar template literals con DOM APIs**, no string concatenation para HTML
4. **Content scripts corren en isolated world** — pero pueden ser afectados por páginas que modifican el DOM

```javascript
// ❌ MAL — String-based HTML construction
const html = `<div class="${userClass}" onclick="${handler}">${userContent}</div>`;
container.innerHTML = html;

// ✅ BIEN — DOM API construction
const div = document.createElement('div');
div.className = sanitizeClassName(userClass);
div.textContent = userContent;
div.addEventListener('click', handler);
container.appendChild(div);
```

### 3.6 Safe Eval Alternatives — Sandboxed Pages

Si necesitas evaluar código dinámico, usa **sandboxed pages**:

```json
// manifest.json
{
  "sandbox": {
    "pages": ["sandbox/sandbox.html"]
  }
}
```

```javascript
// Comunicación con sandbox via postMessage
const iframe = document.createElement('iframe');
iframe.src = chrome.runtime.getURL('sandbox/sandbox.html');
document.body.appendChild(iframe);

iframe.contentWindow.postMessage({ code: dynamicCode }, '*');

window.addEventListener('message', (event) => {
  if (event.source === iframe.contentWindow) {
    console.log('Sandbox result:', event.data);
  }
});
```

### 3.7 OWASP Browser Extension Security Considerations

Based on OWASP security principles applied to browser extensions:

1. **Data minimization:** Only collect/store data absolutely necessary for functionality
2. **Secure communication:** Always use HTTPS for any external requests
3. **Input validation:** Validate ALL data from page DOM, messages, and storage
4. **Secure storage:** Never store sensitive data in `chrome.storage.local` unencrypted if it's sensitive
5. **Update security:** Sign extensions and verify integrity of updates
6. **Permission audit:** Regularly audit permissions — remove any that are no longer needed
7. **Third-party code:** Audit all bundled libraries for vulnerabilities; keep them updated
8. **Cross-extension messaging:** Validate sender identity when receiving external messages

```javascript
// Validate external messages
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Only accept messages from known extension IDs
  const ALLOWED_EXTENSIONS = ['abcdefghijklmnop', 'qrstuvwxyz123456'];
  if (!ALLOWED_EXTENSIONS.includes(sender.id)) {
    console.warn('Rejected message from unknown extension:', sender.id);
    return;
  }
  // Process message...
});
```

### 3.8 Host Permissions Best Practices

```json
// ❌ MAL — Acceso a todas las URLs
{ "host_permissions": ["<all_urls>"] }

// ✅ MEJOR — URLs específicas cuando sea posible
{ "host_permissions": ["https://api.myservice.com/*"] }

// ✅ MEJOR AÚN — Usar activeTab para interacción manual
{ "permissions": ["activeTab"] }

// ✅ MEJOR — optional_host_permissions for on-demand access
{ "optional_host_permissions": ["https://*/*"] }
```

---

## 4. Performance

### 4.1 Service Worker Optimization

```javascript
// ❌ MAL — Global state que se pierde
let captureCount = 0;
let currentSettings = {};

// ✅ BIEN — Persistir en storage con cache
const storageCache = {};
const initPromise = chrome.storage.session.get().then(items => {
  Object.assign(storageCache, items);
});

// Asegurar que el cache está listo antes de operar
chrome.action.onClicked.addListener(async (tab) => {
  await initPromise;
  // Ahora es safe usar storageCache
});
```

### 4.2 Memory Management (Canvas y Video Streams)

**Especialmente crítico para ScreenSnap:**

```javascript
// ✅ Liberar MediaStreams cuando ya no se necesitan
function stopAllTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach(track => {
    track.stop();
    stream.removeTrack(track);
  });
}

// ✅ Revocar Object URLs después de usarlos
const url = URL.createObjectURL(blob);
try {
  await downloadFile(url, filename);
} finally {
  URL.revokeObjectURL(url);
}

// ✅ Limpiar canvas cuando ya no se necesita
function cleanupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

// ✅ Para video recording — cleanup agresivo
class RecordingManager {
  #mediaStream = null;
  #mediaRecorder = null;
  #chunks = [];

  async startRecording(stream) {
    this.#mediaStream = stream;
    this.#chunks = [];
    this.#mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 2500000
    });

    this.#mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.#chunks.push(e.data);
    };

    this.#mediaRecorder.start(1000); // Collect every 1 second
  }

  async stopRecording() {
    return new Promise((resolve) => {
      this.#mediaRecorder.onstop = () => {
        const blob = new Blob(this.#chunks, { type: 'video/webm' });
        this.cleanup();
        resolve(blob);
      };
      this.#mediaRecorder.stop();
    });
  }

  cleanup() {
    stopAllTracks(this.#mediaStream);
    this.#mediaStream = null;
    this.#mediaRecorder = null;
    this.#chunks = [];
  }
}
```

### 4.3 Lazy Loading de Recursos

```javascript
// ✅ Importar módulos solo cuando se necesitan (dynamic import)
chrome.action.onClicked.addListener(async (tab) => {
  const { captureVisibleTab } = await import('./handlers/capture.js');
  await captureVisibleTab(tab);
});

// ✅ En extension pages — lazy load de componentes pesados
async function openEditor(imageData) {
  const { initCanvasEditor } = await import('./editor/canvas-editor.js');
  initCanvasEditor(imageData);
}
```

### 4.4 Storage Quota Management

| Storage Area | Límite | Per-item | Notas |
|---|---|---|---|
| `storage.local` | 10 MB (o ilimitado con `unlimitedStorage`) | Sin límite por item | Persiste hasta desinstalar |
| `storage.sync` | ~100 KB total | 8 KB por item, 512 items max | Se sincroniza entre dispositivos |
| `storage.session` | 10 MB | Sin límite | En memoria, se pierde al reiniciar |

```javascript
// ✅ Monitorear uso de storage
async function checkStorageUsage() {
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);
  const maxBytes = chrome.storage.local.QUOTA_BYTES; // 10485760

  const usagePercent = (bytesInUse / maxBytes) * 100;

  if (usagePercent > 80) {
    console.warn(`Storage usage: ${usagePercent.toFixed(1)}% — consider cleanup`);
    await cleanupOldCaptures();
  }

  return { bytesInUse, maxBytes, usagePercent };
}

// ✅ Para ScreenSnap: NO guardar imágenes/videos grandes en chrome.storage
// Usar IndexedDB para blobs grandes, o descargar directamente
async function saveCapture(blob, metadata) {
  // Metadata en chrome.storage (pequeño)
  const captures = await chrome.storage.local.get('captures');
  const list = captures.captures || [];
  list.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: metadata.type,
    format: metadata.format,
    size: blob.size,
  });
  await chrome.storage.local.set({ captures: list });

  // Blob grande → descargar directamente
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: metadata.filename,
    saveAs: metadata.saveAs
  });
  URL.revokeObjectURL(url);
}
```

### 4.5 Efficient Message Passing

```javascript
// ❌ MAL — Enviar datos grandes por message passing
chrome.runtime.sendMessage({
  type: 'save-capture',
  imageData: hugeBase64String // Puede ser megabytes
});

// ✅ BIEN — Usar referencias, no datos directos
await chrome.storage.session.set({ [`capture-${id}`]: imageData });
chrome.runtime.sendMessage({
  type: 'save-capture',
  captureId: id
});
```

**Límite de mensaje:** 64 MiB máximo. Pero mensajes grandes bloquean.

### 4.6 requestAnimationFrame vs setInterval

```javascript
// ❌ MAL — setInterval para animaciones
setInterval(() => {
  updateRecordingTimer();
  drawAnnotation();
}, 16);

// ✅ BIEN — requestAnimationFrame para rendering
function animate() {
  updateRecordingTimer();
  drawAnnotation();
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
```

### 4.7 Back/Forward Cache Considerations

```javascript
// ❌ MAL — unload handler (deprecated, invalida bfcache)
window.addEventListener('unload', cleanup);

// ✅ BIEN — pagehide event
window.addEventListener('pagehide', cleanup);

// ❌ MAL — Dejar listeners sin limpiar
window.addEventListener('scroll', heavyHandler);

// ✅ BIEN — Cleanup con AbortController
const controller = new AbortController();
window.addEventListener('scroll', heavyHandler, { signal: controller.signal });
controller.abort(); // Cleanup all at once
```

---

## 5. Código Profesional

### 5.1 Estructura de Carpetas Recomendada

```
screensnap/
├── manifest.json
├── background/
│   ├── service-worker.js          # Entry point, importa módulos
│   ├── message-router.js          # Routing de mensajes
│   └── handlers/                  # Handlers organizados por feature
│       ├── capture.js
│       ├── recording.js
│       └── download.js
├── content/
│   ├── content-script.js          # Entry point
│   ├── selection-overlay.js       # UI de selección de área
│   ├── recording-controls.js      # Controles de grabación
│   └── styles/
│       ├── content-style.css
│       └── recording-controls.css
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.js
│   └── sidepanel.css
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
├── pages/
│   ├── editor/
│   ├── history/
│   ├── settings/
│   └── welcome/
├── shared/
│   ├── constants.js
│   ├── state-manager.js
│   ├── storage-utils.js
│   ├── errors.js
│   ├── utils.js
│   └── logger.js
├── lib/                           # Third-party libraries (bundled)
│   └── dompurify.min.js
├── assets/
│   ├── icons/
│   ├── images/
│   └── fonts/
├── _locales/
│   ├── en/messages.json
│   └── es/messages.json
├── docs/
│   └── BEST_PRACTICES.md
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 5.2 Naming Conventions

```javascript
// Files: kebab-case
// content-script.js, message-router.js, canvas-tools.js

// Classes: PascalCase
class RecordingManager {}
class StateManager {}

// Functions: camelCase, verbos descriptivos
function captureVisibleTab() {}
function startRecording() {}

// Constants: UPPER_SNAKE_CASE
const MAX_CAPTURE_SIZE = 10 * 1024 * 1024;
const DEFAULT_FORMAT = 'png';

// Private members: # prefix (ES2022)
class MyClass {
  #privateField;
  #privateMethod() {}
}

// Event handlers: handle + Event/Subject
function handleCaptureRequest() {}
function handleStorageChange() {}

// Boolean variables: is/has/should prefix
let isRecording = false;
let hasPermission = true;
```

### 5.3 JSDoc Documentation Standards

```javascript
/**
 * Captures the visible area of the active tab.
 *
 * @param {chrome.tabs.Tab} tab - The tab to capture
 * @param {Object} options - Capture options
 * @param {string} [options.format='png'] - Image format ('png' | 'jpeg' | 'webp')
 * @param {number} [options.quality=0.92] - JPEG/WebP quality (0-1)
 * @returns {Promise<Blob>} The captured image as a Blob
 * @throws {ExtensionError} If capture fails or tab is not accessible
 *
 * @example
 * const blob = await captureVisibleTab(tab, { format: 'png' });
 * downloadBlob(blob, 'screenshot.png');
 */
async function captureVisibleTab(tab, { format = 'png', quality = 0.92 } = {}) {
  // Implementation
}
```

### 5.4 Error Boundaries

```javascript
// shared/error-boundary.js
export function withErrorBoundary(fn, context = '') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error(`[${context}] Error:`, error);
      await logError(context, error);

      if (error instanceof ExtensionError) throw error;
      throw new ExtensionError(
        `Unexpected error in ${context}: ${error.message}`,
        'UNEXPECTED_ERROR',
        { originalError: error.stack }
      );
    }
  };
}

const safeCaptureVisible = withErrorBoundary(captureVisibleTab, 'capture-visible');
```

### 5.5 Logging y Debugging

```javascript
// shared/logger.js
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

class Logger {
  #prefix;
  #level;

  constructor(prefix, level = LOG_LEVELS.INFO) {
    this.#prefix = prefix;
    this.#level = level;
  }

  #log(level, levelName, ...args) {
    if (level < this.#level) return;
    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = `[${timestamp}][${this.#prefix}][${levelName}]`;
    switch (level) {
      case LOG_LEVELS.ERROR: console.error(prefix, ...args); break;
      case LOG_LEVELS.WARN:  console.warn(prefix, ...args);  break;
      case LOG_LEVELS.INFO:  console.info(prefix, ...args);  break;
      default:               console.debug(prefix, ...args);
    }
  }

  debug(...args) { this.#log(LOG_LEVELS.DEBUG, 'DEBUG', ...args); }
  info(...args)  { this.#log(LOG_LEVELS.INFO, 'INFO', ...args);   }
  warn(...args)  { this.#log(LOG_LEVELS.WARN, 'WARN', ...args);   }
  error(...args) { this.#log(LOG_LEVELS.ERROR, 'ERROR', ...args); }
}

export function createLogger(module) {
  return new Logger(module);
}
```

---

## 6. chrome.scripting API — Dynamic Injection

The `chrome.scripting` API (Chrome 88+, MV3) provides programmatic injection as a superior alternative to declarative content scripts.

### 6.1 When to Use Programmatic vs Declarative Injection

| Aspect | Declarative (`content_scripts`) | Programmatic (`chrome.scripting`) |
|---|---|---|
| **Timing** | Auto-injects on page load | On-demand, triggered by code |
| **Performance** | Runs on ALL matching pages | Runs only when needed |
| **Permissions** | Requires host_permissions | Works with activeTab |
| **Flexibility** | Static match patterns | Dynamic targeting |
| **Install warning** | Yes (if broad patterns) | No (with activeTab) |

### 6.2 Injection Methods

```javascript
// Inject a file
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ['content/content-script.js']
});

// Inject a function directly (with arguments)
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: (backgroundColor) => {
    document.body.style.backgroundColor = backgroundColor;
  },
  args: ['#ff0000']
});

// Inject into all frames
await chrome.scripting.executeScript({
  target: { tabId: tab.id, allFrames: true },
  files: ['content/content-script.js']
});

// Inject into specific frames
await chrome.scripting.executeScript({
  target: { tabId: tab.id, frameIds: [frameId1, frameId2] },
  files: ['content/content-script.js']
});

// Inject CSS
await chrome.scripting.insertCSS({
  target: { tabId: tab.id },
  files: ['content/styles.css']
});

// Inject CSS string
await chrome.scripting.insertCSS({
  target: { tabId: tab.id },
  css: 'body { border: 2px solid red; }'
});

// Remove injected CSS
await chrome.scripting.removeCSS({
  target: { tabId: tab.id },
  files: ['content/styles.css']
});
```

### 6.3 Dynamic Content Script Registration

```javascript
// Register content scripts dynamically (persist across SW restarts)
await chrome.scripting.registerContentScripts([{
  id: 'screensnap-overlay',
  matches: ['<all_urls>'],
  js: ['content/selection-overlay.js'],
  css: ['content/styles/overlay.css'],
  runAt: 'document_idle',
  // persistAcrossSessions defaults to true
}]);

// Update registered scripts
await chrome.scripting.updateContentScripts([{
  id: 'screensnap-overlay',
  excludeMatches: ['*://sensitive-site.com/*']
}]);

// Unregister when no longer needed
await chrome.scripting.unregisterContentScripts({
  ids: ['screensnap-overlay']
});

// List all registered dynamic content scripts
const scripts = await chrome.scripting.getRegisteredContentScripts();
```

### 6.4 Handling Results

```javascript
// executeScript returns results per frame
const results = await chrome.scripting.executeScript({
  target: { tabId: tab.id, allFrames: true },
  func: () => document.title
});

for (const { frameId, result } of results) {
  console.log(`Frame ${frameId}: ${result}`);
}
// Main frame is always first in the results array

// If the function returns a Promise, Chrome waits for it to resolve
const results = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: async () => {
    const response = await fetch('/api/data');
    return response.json();
  }
});
```

### 6.5 Prevent Double Injection

```javascript
// In the content script itself — guard against re-injection
if (window.__screensnap_injected) {
  // Already injected, skip initialization
} else {
  window.__screensnap_injected = true;
  initContentScript();
}

// Or from the service worker — check before injecting
async function injectContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__screensnap_injected
    });
    if (results[0]?.result) return; // Already injected
  } catch {
    // Tab might not be accessible (chrome:// pages)
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js']
  });
}
```

---

## 7. Side Panel API

The Side Panel API (Chrome 114+) allows extensions to display persistent UI alongside web content.

### 7.1 Basic Setup

```json
// manifest.json
{
  "permissions": ["sidePanel"],
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  }
}
```

### 7.2 Open Side Panel on Action Click

```javascript
// service-worker.js
// Replace popup with side panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);
```

### 7.3 Per-Tab Side Panels

```javascript
// Enable side panel only on specific sites
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  const url = new URL(tab.url);

  if (url.hostname === 'www.example.com') {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel/site-specific.html',
      enabled: true
    });
  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    });
  }
});
```

### 7.4 Programmatic Open (Chrome 116+)

```javascript
// Open from context menu
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openSidePanel') {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Open for specific tab
chrome.sidePanel.open({ tabId: tab.id });
```

### 7.5 Switch Panel Content

```javascript
// Change panel content dynamically
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: 'sidepanel/welcome.html' });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { path } = await chrome.sidePanel.getOptions({ tabId });
  if (path === 'sidepanel/welcome.html') {
    chrome.sidePanel.setOptions({ path: 'sidepanel/main.html' });
  }
});
```

### 7.6 Side Panel vs Popup — When to Use Which

| Feature | Popup | Side Panel |
|---|---|---|
| **Persistence** | Closes on blur | Stays open across tabs |
| **Size** | Small (300-400px wide) | Full sidebar width |
| **Use case** | Quick actions, menus | Long-form content, tools |
| **Navigation** | None | Persists during navigation |
| **Availability** | Chrome 88+ | Chrome 114+ |

**For ScreenSnap:** Side panel could be used for capture history, annotation tools, or recording controls — anything that benefits from persistent visibility.

---

## 8. UX/UI

### 8.1 Popup Design Guidelines

- **Tamaño recomendado:** 300-400px wide, no más de 600px tall
- **Cargar rápido:** El popup se cierra si pierde foco
- **No hacer requests lentos en popup:** Iniciar acciones en service worker
- **Feedback inmediato:** Mostrar loading states al iniciar acciones

```javascript
// popup.js — Pattern para acciones rápidas
document.getElementById('btn-capture').addEventListener('click', async () => {
  const btn = document.getElementById('btn-capture');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

  try {
    await chrome.runtime.sendMessage({
      type: 'CAPTURE_VISIBLE',
      payload: { format: 'png' }
    });
    window.close(); // Cerrar popup rápido
  } catch (error) {
    btn.disabled = false;
    btn.textContent = 'Capture';
    showError('Capture failed');
  }
});
```

### 8.2 Accesibilidad (A11y)

```html
<!-- ✅ Roles ARIA apropiados -->
<button id="btn-capture"
        role="button"
        aria-label="Capture visible area screenshot"
        tabindex="0">
  <svg aria-hidden="true"><!-- icon --></svg>
  <span>Screenshot</span>
</button>

<!-- ✅ Status region para screen readers -->
<div role="status" aria-live="polite" id="status-message"></div>
```

```javascript
// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelCurrentAction();
  if (e.key === 'Enter' || e.key === ' ') {
    if (document.activeElement.matches('button, [role="button"]')) {
      document.activeElement.click();
    }
  }
});
```

### 8.3 Consistent Theming

```css
/* assets/styles/theme.css */
:root {
  --color-primary: #4285F4;
  --color-primary-hover: #3367D6;
  --color-secondary: #34A853;
  --color-error: #EA4335;
  --color-warning: #FBBC05;
  --surface-bg: #FFFFFF;
  --surface-fg: #202124;
  --surface-secondary: #F1F3F4;
  --surface-border: #DADCE0;
  --font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  --font-size-base: 14px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --transition-fast: 150ms ease;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface-bg: #202124;
    --surface-fg: #E8EAED;
    --surface-secondary: #303134;
    --surface-border: #5F6368;
  }
}
```

### 8.4 Internationalization (i18n)

```json
// _locales/en/messages.json
{
  "extensionName": {
    "message": "ScreenSnap",
    "description": "Extension name"
  },
  "captureVisible": {
    "message": "Capture Visible Area",
    "description": "Button to capture the visible tab area"
  }
}
```

```javascript
// Auto-translate data-i18n attributes
document.querySelectorAll('[data-i18n]').forEach(el => {
  el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
});
```

---

## 9. Testing Strategy

### 9.1 Testing Pyramid for Extensions

```
    ╱╲
   ╱E2E╲        Few — Slow, expensive, but catches integration issues
  ╱──────╲
 ╱Integration╲   Some — Test component interactions
╱──────────────╲
╱  Unit Tests   ╲  Many — Fast, test individual functions/modules
╱────────────────╲
```

### 9.2 Unit Testing (Jest / Vitest)

Test shared modules and pure business logic by mocking Chrome APIs:

```javascript
// tests/unit/setup.js — Mock chrome APIs
global.chrome = {
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      getBytesInUse: jest.fn(),
      onChanged: { addListener: jest.fn() },
    },
    session: {
      get: jest.fn(),
      set: jest.fn(),
      onChanged: { addListener: jest.fn() },
    },
  },
  runtime: {
    sendMessage: jest.fn(),
    onMessage: { addListener: jest.fn() },
    getURL: jest.fn((path) => `chrome-extension://test-id/${path}`),
    lastError: null,
  },
  tabs: {
    query: jest.fn(),
    get: jest.fn(),
  },
  scripting: {
    executeScript: jest.fn(),
    insertCSS: jest.fn(),
  },
};

// tests/unit/state-manager.test.js
import { StateManager } from '../../shared/state-manager.js';

describe('StateManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should cache values after first get', async () => {
    chrome.storage.session.get.mockResolvedValue({ key: 'value' });
    const manager = new StateManager('session');
    await manager.get('key');
    await manager.get('key');
    expect(chrome.storage.session.get).toHaveBeenCalledTimes(1);
  });

  test('should return default value when key not found', async () => {
    chrome.storage.session.get.mockResolvedValue({});
    const manager = new StateManager('session');
    const result = await manager.get('missing', 'default');
    expect(result).toBe('default');
  });

  test('should update cache on set', async () => {
    chrome.storage.session.set.mockResolvedValue();
    const manager = new StateManager('session');
    await manager.set('key', 'newValue');
    chrome.storage.session.get.mockResolvedValue({});
    const result = await manager.get('key');
    expect(result).toBe('newValue');
  });
});

// tests/unit/message-router.test.js
import { registerHandler, initMessageRouter } from '../../background/message-router.js';

describe('MessageRouter', () => {
  test('should route messages to correct handler', () => {
    const mockHandler = jest.fn().mockReturnValue('result');
    registerHandler('TEST_TYPE', mockHandler);
    initMessageRouter();

    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = jest.fn();

    listener({ type: 'TEST_TYPE', payload: { data: 1 } }, {}, sendResponse);
    expect(mockHandler).toHaveBeenCalledWith({ data: 1 }, {});
    expect(sendResponse).toHaveBeenCalledWith({ success: true, data: 'result' });
  });
});
```

### 9.3 End-to-End Testing with Puppeteer

```javascript
// tests/e2e/capture.test.js
const puppeteer = require('puppeteer');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../');

describe('ScreenSnap E2E', () => {
  let browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: 'new', // new headless supports extensions
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  test('extension should load successfully', async () => {
    // Find the extension's service worker
    const workerTarget = await browser.waitForTarget(
      target => target.type() === 'service_worker'
    );
    expect(workerTarget).toBeTruthy();
  });

  test('popup should open and display capture buttons', async () => {
    // Get extension ID from service worker URL
    const workerTarget = await browser.waitForTarget(
      target => target.type() === 'service_worker'
    );
    const workerUrl = workerTarget.url();
    const extensionId = workerUrl.split('/')[2];

    // Open popup as a page
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    // Check that capture buttons exist
    const captureBtn = await page.$('#btn-capture-visible');
    expect(captureBtn).toBeTruthy();
  });

  test('should capture visible tab', async () => {
    const page = await browser.newPage();
    await page.goto('https://example.com');

    // Navigate to popup and click capture
    const workerTarget = await browser.waitForTarget(
      target => target.type() === 'service_worker'
    );
    const worker = await workerTarget.worker();

    // Execute capture via service worker
    const result = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      // Test the capture logic...
      return { success: true };
    });

    expect(result.success).toBe(true);
  });

  test('should inspect extension state via service worker', async () => {
    const workerTarget = await browser.waitForTarget(
      target => target.type() === 'service_worker'
    );
    const worker = await workerTarget.worker();

    const storageData = await worker.evaluate(() => {
      return chrome.storage.local.get('settings');
    });

    expect(storageData).toBeDefined();
  });
});
```

### 9.4 End-to-End Testing with Playwright

```javascript
// tests/e2e/playwright.test.js
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../');

test.describe('ScreenSnap E2E (Playwright)', () => {
  let context;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false, // Extensions require headed mode in Playwright
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('popup should render', async () => {
    // Get extension ID from service worker
    let extensionId;
    const serviceWorker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker');
    extensionId = serviceWorker.url().split('/')[2];

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    await expect(page.locator('#btn-capture-visible')).toBeVisible();
  });
});
```

### 9.5 Testing Service Worker Termination

```javascript
// Test that extension recovers from SW termination
test('should recover from service worker termination', async () => {
  const workerTarget = await browser.waitForTarget(
    target => target.type() === 'service_worker'
  );

  // Force-terminate the service worker
  const worker = await workerTarget.worker();
  await worker.evaluate(() => {
    // Trigger some state before termination
    chrome.storage.session.set({ testState: 'before-termination' });
  });

  // In Puppeteer, use Chrome DevTools Protocol to terminate SW
  const client = await workerTarget.createCDPSession();
  await client.send('Target.closeTarget', {
    targetId: workerTarget._targetId
  });

  // Wait for new service worker
  const newWorkerTarget = await browser.waitForTarget(
    target => target.type() === 'service_worker'
  );
  const newWorker = await newWorkerTarget.worker();

  // Verify state was persisted
  const state = await newWorker.evaluate(() => {
    return chrome.storage.session.get('testState');
  });
  expect(state.testState).toBe('before-termination');
});
```

### 9.6 Testing Libraries Comparison

| Library | Extension Support | Headless | Service Worker Access | Recommendation |
|---|---|---|---|---|
| **Puppeteer** | ✅ Full | ✅ `headless: 'new'` | ✅ Direct | Best for Chrome-only testing |
| **Playwright** | ✅ Full | ❌ Headed only | ✅ Via serviceWorkers() | Best for multi-browser |
| **Selenium** | ✅ Via ChromeOptions | ✅ | ⚠️ Indirect only | Good for existing Selenium infra |
| **WebDriverIO** | ✅ | ✅ | ⚠️ Limited | Good for web extension testing |

**⚠️ Selenium caveat:** ChromeDriver attaches a debugger to all service workers, preventing them from being terminated automatically. This means SW termination tests won't work with Selenium.

### 9.7 Setting a Fixed Extension ID for Testing

Use a consistent extension ID across test runs:

```json
// manifest.json (for development/testing only)
{
  "key": "MIIBIjANBgkqh..." // Public key for consistent ID
}
```

Generate a key using:
```bash
# Generate a .pem file
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
# Get the public key for the manifest
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

### 9.8 What to Test — Checklist

- [ ] Extension loads without errors
- [ ] Popup renders correctly
- [ ] Core features work (capture, recording, etc.)
- [ ] Permissions denied — graceful fallback
- [ ] Service worker survives termination and restart
- [ ] Content script injection on various page types
- [ ] Error paths — not just happy paths
- [ ] Storage limits — behavior when storage is full
- [ ] Keyboard shortcuts work
- [ ] i18n — messages display correctly in different locales
- [ ] Chrome internal pages (`chrome://`) — graceful rejection

---

## 10. Chrome Web Store Publishing Guide

### 10.1 Pre-Submission Checklist

Before submitting, ensure:

1. **Developer account:** Register at [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 fee)
2. **Manifest V3:** Required for all new extensions
3. **All code bundled:** No remote code loading (MV3 requirement)
4. **Privacy policy:** Required if you access any user data or page content
5. **Permissions justified:** Each permission has a clear justification
6. **Single purpose:** Extension has one clear, narrow purpose

### 10.2 Store Listing — Assets Required

| Asset | Size | Required | Notes |
|---|---|---|---|
| **Extension icon** | 128×128 px | ✅ Yes | Actual icon 96×96 with 16px transparent padding; PNG only |
| **Small promo tile** | 440×280 px | ✅ Yes | Main promotional image |
| **Screenshots** | 1280×800 px | ✅ Yes (1-5) | Show actual extension functionality |
| **Marquee promo tile** | 1400×560 px | ❌ Optional | Required for featured placement |
| **YouTube video** | — | ❌ Optional | Showcase features |

#### Icon Guidelines

- Use 96×96 actual artwork within 128×128 image (16px transparent padding per side)
- Face the viewer (no dramatic perspective)
- Work on both light and dark backgrounds
- Avoid large drop shadows (Chrome adds its own)
- PNG format only

#### Promotional Image Best Practices

- **Don't just use a screenshot** — communicate the brand
- Avoid text (it won't be readable when shrunk)
- Use saturated colors
- Fill the entire region with well-defined edges
- Make sure it works at half size

#### Screenshot Tips

- 1280×800 or 640×400 pixels
- Show the extension actually working
- Include annotated callouts for key features
- Show different use cases across screenshots
- Localize screenshots for different markets

### 10.3 Privacy Tab — Required Fields

The Privacy tab has four critical sections:

#### 1. Single Purpose Description
Clearly state what your extension does in one concise statement.

> Example for ScreenSnap: "ScreenSnap captures screenshots and records screen activity from browser tabs, allowing users to annotate and save captures locally."

#### 2. Permission Justifications
For each permission in your manifest, explain WHY it's needed:

| Permission | Justification Example |
|---|---|
| `activeTab` | "Required to capture the currently visible tab content when user clicks the extension" |
| `storage` | "Stores user preferences and capture history metadata locally" |
| `scripting` | "Injects capture overlay UI into the active tab for area selection" |
| `offscreen` | "Creates offscreen document for audio/video recording using MediaRecorder API" |
| `tabCapture` | "Captures tab audio/video stream for screen recording functionality" |

#### 3. Remote Code Declaration
- Select "No, I am not using remote code" (MV3 should never use remote code)
- If you DO use remote code, you must justify it and expect longer review times

#### 4. Data Use Certification
Declare which data types your extension collects:
- ✅ Check applicable data types
- ✅ Certify compliance with limited use policy
- For ScreenSnap: If all processing is local and no data leaves the browser, declare that

### 10.4 The Review Process

#### What Reviewers Check

1. Compliance with [Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/)
2. Each permission is justified and actually used
3. No remote code execution
4. No obfuscated code (minification is OK, obfuscation is NOT)
5. Extension provides real functionality (not empty/spam)
6. Description matches actual functionality
7. No deceptive installation tactics

#### Review Timeline

- Most submissions: **under 24 hours**
- 90%+ within **3 days**
- Can be longer for:
  - New developers
  - New extensions
  - Broad host permissions
  - Sensitive permission requests
  - Significant code changes
  - Post-rejection resubmissions
  - Large or hard-to-review code

#### Common Rejection Reasons

1. **Excessive permissions** — Requesting permissions not used or not justified
2. **Missing privacy policy** — Required when accessing user data
3. **Misleading description** — Description doesn't match functionality
4. **Obfuscated code** — Only minification is allowed
5. **Minimal functionality** — Extension doesn't do enough to warrant existence
6. **Remote code** — Loading JS from external servers
7. **Keyword spam** — Stuffing description with unrelated keywords

#### Rejection vs Warning vs Takedown

- **Rejection:** New submission blocked; fix and resubmit
- **Warning:** Published item has minor violation; fix within deadline
- **Takedown:** Published item removed from store; fix and resubmit
- **Malware verdict:** Immediate removal, possible developer ban

### 10.5 Publishing Workflow

```
1. Create ZIP of extension files
   └── zip -r screensnap.zip . -x "*.git*" "node_modules/*" "tests/*" "docs/*"

2. Upload to Chrome Developer Dashboard
   └── chrome.google.com/webstore/devconsole

3. Fill out all tabs:
   ├── Package (auto-filled from ZIP)
   ├── Store Listing (description, screenshots, promo images)
   ├── Privacy (purpose, permissions justification, data use)
   ├── Distribution (countries, visibility)
   └── Test Instructions (if needed for reviewers)

4. Submit for Review
   └── Option: Deferred publishing (publish manually after approval)

5. Wait for Review (usually <24h)
   └── Check status in dashboard

6. Published! (or fix rejections and resubmit)
```

### 10.6 Update Strategy

```javascript
// Handle updates gracefully
chrome.runtime.onInstalled.addListener((details) => {
  switch (details.reason) {
    case 'install':
      chrome.tabs.create({
        url: chrome.runtime.getURL('pages/welcome/welcome.html')
      });
      initDefaultSettings();
      break;

    case 'update':
      const previousVersion = details.previousVersion;
      const currentVersion = chrome.runtime.getManifest().version;
      console.info(`Updated from ${previousVersion} to ${currentVersion}`);

      migrateData(previousVersion, currentVersion);

      if (shouldShowChangelog(previousVersion)) {
        chrome.notifications.create('update-notification', {
          type: 'basic',
          iconUrl: 'assets/icons/icon-128.png',
          title: `ScreenSnap updated to v${currentVersion}`,
          message: 'Click to see what\'s new!',
        });
      }
      break;
  }
});
```

### 10.7 Versioning

Follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

Chrome supports up to 4 numbers: `MAJOR.MINOR.PATCH.BUILD`

```
1.0.0   → First public release
1.1.0   → New feature (area selection)
1.1.1   → Bug fix
1.2.0   → New feature (video recording)
2.0.0   → Breaking change (settings restructure)
```

**⚠️ Important:** Updating permissions may disable the extension for existing users until they accept the new permissions.

---

## 11. Cross-Browser Compatibility

### 11.1 Browser Extension API Landscape

| Browser | API Namespace | Manifest | Extension Store |
|---|---|---|---|
| **Chrome** | `chrome.*` | MV3 | Chrome Web Store |
| **Firefox** | `browser.*` + `chrome.*` | MV2/MV3 | Firefox Add-ons (AMO) |
| **Edge** | `chrome.*` | MV3 | Microsoft Edge Add-ons |
| **Safari** | `browser.*` | MV3 (with Xcode) | App Store |
| **Opera** | `chrome.*` | MV3 | Opera Add-ons |

### 11.2 Porting Chrome → Firefox

Firefox supports most Chrome extension APIs under both `chrome.*` and `browser.*` namespaces. Key differences:

```javascript
// Use the browser namespace polyfill for cross-browser compatibility
// https://github.com/nicolo-ribaudo/browser-polyfill

// Differences to watch for:
// 1. Firefox supports Promise-based APIs natively via browser.*
//    Chrome uses callbacks (or Promises in MV3)
// 2. Some APIs may have different behavior or be missing

// Cross-browser pattern
const api = typeof browser !== 'undefined' ? browser : chrome;

// Or use Mozilla's webextension-polyfill
// npm install webextension-polyfill
import browser from 'webextension-polyfill';
```

**Steps to port to Firefox:**

1. Review [Chrome incompatibilities](https://developer.mozilla.org/Add-ons/WebExtensions/Chrome_incompatibilities)
2. Use Mozilla's [Add-on Developer Hub](https://addons.mozilla.org/developers/addon/validate) to validate
3. Install via `about:debugging` or `web-ext` tool for testing
4. Test thoroughly
5. Submit to [addons.mozilla.org](https://addons.mozilla.org) for signing and distribution

**Common incompatibilities:**
- `chrome.sidePanel` — Not available in Firefox (use sidebar_action instead)
- `chrome.offscreen` — Not available in Firefox (background scripts have DOM access)
- Manifest V3 differences in Firefox (background scripts vs service workers)
- Some permission names differ

### 11.3 Porting Chrome → Edge

Edge is Chromium-based, so porting is usually trivial:

1. **Remove `update_url`** from manifest.json
2. **Rebrand:** Replace "Chrome" with "Microsoft Edge" in name/description
3. Test by sideloading in Edge (`edge://extensions`)
4. If using `chrome.runtime.connectNative()`, update `allowed_origins` to include Edge's extension ID
5. Submit to [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com)

```json
// Most manifest.json files work as-is in Edge
// Just remove auto-update URL if present:
{
  // ❌ Remove this for Edge
  "update_url": "https://clients2.google.com/service/update2/crx"
}
```

### 11.4 Cross-Browser Build Strategy

```javascript
// build.config.js — Platform-specific builds
const platforms = {
  chrome: {
    manifest: {
      // Chrome-specific manifest
    }
  },
  firefox: {
    manifest: {
      // Firefox-specific: use background.scripts instead of service_worker
      background: {
        scripts: ['background/service-worker.js']
      },
      // Firefox-specific: browser_specific_settings
      browser_specific_settings: {
        gecko: {
          id: 'screensnap@yourname.com',
          strict_min_version: '109.0'
        }
      }
    }
  },
  edge: {
    manifest: {
      // Usually identical to Chrome
    }
  }
};

// Build script generates platform-specific ZIPs
// with merged manifests and any platform-specific code
```

### 11.5 Feature Detection Pattern

```javascript
// Instead of checking browser, check for API availability
function hasSidePanelSupport() {
  return typeof chrome !== 'undefined' && !!chrome.sidePanel;
}

function hasOffscreenSupport() {
  return typeof chrome !== 'undefined' && !!chrome.offscreen;
}

// Use feature detection to enable/disable features
if (hasSidePanelSupport()) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} else {
  // Fallback: use popup or sidebar_action
}
```

---

## 12. Anti-Patrones — Qué NO Hacer

### 12.1 Common Mistakes en MV3

#### ❌ Usar variables globales para estado

```javascript
// ❌ MAL — Se pierde cuando el service worker se apaga
let isRecording = false;
let captureHistory = [];

// ✅ BIEN — Persistir en chrome.storage.session
await chrome.storage.session.set({ isRecording: true });
```

#### ❌ Asumir que el service worker siempre está corriendo

```javascript
// ❌ MAL — setInterval en service worker (se pierde)
setInterval(() => { checkRecordingStatus(); }, 1000);

// ✅ BIEN — Usar chrome.alarms
chrome.alarms.create('check-recording', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-recording') checkRecordingStatus();
});
```

#### ❌ Registrar event handlers de forma condicional o anidada

```javascript
// ❌ MAL — Handler registrado dentro de callback (puede no registrarse a tiempo)
chrome.storage.local.get(['config'], (result) => {
  if (result.config.enabled) {
    chrome.action.onClicked.addListener(handleClick); // ← TOO LATE!
  }
});

// ✅ BIEN — Registrar siempre en top level, filtrar dentro
chrome.action.onClicked.addListener(async (tab) => {
  const { config } = await chrome.storage.local.get('config');
  if (!config?.enabled) return;
  handleClick(tab);
});
```

#### ❌ No manejar la reconexión del service worker

```javascript
// ❌ MAL — Port muere silenciosamente al reiniciar SW
const port = chrome.runtime.connect({ name: 'recording' });

// ✅ BIEN — Reconectar automáticamente
function createPort() {
  const port = chrome.runtime.connect({ name: 'recording' });
  port.onDisconnect.addListener(() => {
    setTimeout(createPort, 100); // Reconnect
  });
  port.onMessage.addListener(handleMessage);
  return port;
}
```

### 12.2 Memory Leaks Comunes

```javascript
// ❌ Memory leak — Object URL nunca se libera
const url = URL.createObjectURL(blob);
img.src = url;

// ✅ Revocar cuando ya no se necesita
img.src = url;
img.onload = () => URL.revokeObjectURL(url);

// ❌ Memory leak — MediaStream sigue activo
const stream = await navigator.mediaDevices.getDisplayMedia();
// user cancels but stream never stopped

// ✅ Always cleanup
try {
  const stream = await navigator.mediaDevices.getDisplayMedia();
} finally {
  if (stream) stream.getTracks().forEach(track => track.stop());
}

// ❌ Listeners sin cleanup en content scripts
window.addEventListener('resize', onResize);

// ✅ AbortController for cleanup
const controller = new AbortController();
window.addEventListener('resize', onResize, { signal: controller.signal });
function cleanup() { controller.abort(); }

// ❌ Canvas grande sin liberar
canvas.width = 3840; canvas.height = 2160; // ~31 MB

// ✅ Reset dimensions to free memory
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}
```

### 12.3 Pitfalls de tabCapture / desktopCapture

```javascript
// ❌ tabCapture.capture() solo funciona en response a user gesture
// No se puede llamar en un timer o automáticamente

// ✅ Iniciar desde popup click o keyboard shortcut
chrome.action.onClicked.addListener(async (tab) => {
  // Verify it's not a chrome:// page
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    showError('Cannot capture this page');
    return;
  }
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });
});

// ❌ desktopCapture — Not handling user cancel
chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
  if (!streamId) return; // ← User cancelled!
});

// ✅ Save capture ID to allow cancellation
const captureId = chrome.desktopCapture.chooseDesktopMedia(
  ['screen', 'window', 'tab'],
  handleStreamId
);
// Cancel if needed:
chrome.desktopCapture.cancelChooseDesktopMedia(captureId);
```

### 12.4 Storage Anti-Patterns

```javascript
// ❌ Guardar blobs grandes en chrome.storage
await chrome.storage.local.set({ screenshot: base64EncodedImage }); // 5-30 MB!

// ✅ Usar chrome.downloads o IndexedDB para blobs

// ❌ Muchas escrituras rápidas (rate limits on sync)
for (const item of items) {
  await chrome.storage.sync.set({ [item.id]: item.data });
}

// ✅ Batch writes
const batch = {};
items.forEach(item => { batch[item.id] = item.data; });
await chrome.storage.sync.set(batch);

// ❌ No manejar storage lleno
await chrome.storage.local.set({ captures: hugeArray });

// ✅ Verify space and handle error
try {
  await chrome.storage.local.set({ captures: data });
} catch (error) {
  if (error.message.includes('QUOTA_BYTES')) {
    await cleanupOldData();
    await chrome.storage.local.set({ captures: data });
  }
}
```

### 12.5 Content Script Anti-Patterns

```javascript
// ❌ Declarative injection on all URLs when not needed
{
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content-script.js"]
  }]
}

// ✅ Programmatic injection only when needed
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/content-script.js']
  });
});
```

### 12.6 Code that Gets Rejected

- **Obfuscated code** — CWS will reject. Minification is OK.
- **`document.write()` with untrusted data** — XSS risk
- **`innerHTML` with user input** — Always use DOM APIs
- **Unused permissions** — Remove any permission you don't actually use

---

## 13. Error Recovery Patterns

### 13.1 Context Invalidated Error

When a content script's context is invalidated (e.g., extension updated while content script is active):

```javascript
// In content script — detect invalidated context
function isContextValid() {
  try {
    chrome.runtime.getURL('');
    return true;
  } catch {
    return false;
  }
}

// Wrap all chrome API calls in content scripts
async function safeSendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (error.message.includes('Extension context invalidated')) {
      console.warn('Extension was updated. Please refresh the page.');
      showRefreshBanner();
      return null;
    }
    throw error;
  }
}
```

### 13.2 Service Worker Termination Recovery

```javascript
// service-worker.js — Recovery on startup
chrome.runtime.onStartup.addListener(async () => {
  await recoverRecordingState();
  await recoverPendingOperations();
});

async function recoverPendingOperations() {
  const { pendingOps } = await chrome.storage.session.get('pendingOps');
  if (!pendingOps?.length) return;

  for (const op of pendingOps) {
    try {
      switch (op.type) {
        case 'download':
          await retryDownload(op);
          break;
        case 'process':
          await retryProcessing(op);
          break;
      }
    } catch (e) {
      console.error('Failed to recover operation:', op, e);
    }
  }

  await chrome.storage.session.remove('pendingOps');
}
```

### 13.3 Tab Not Found Recovery

```javascript
async function safeTabOperation(tabId, operation) {
  try {
    return await operation(tabId);
  } catch (error) {
    if (error.message.includes('No tab with id')) {
      console.warn(`Tab ${tabId} no longer exists`);
      // Clean up any state referencing this tab
      await cleanupTabState(tabId);
      return null;
    }
    throw error;
  }
}

// Usage
await safeTabOperation(tabId, async (id) => {
  await chrome.scripting.executeScript({
    target: { tabId: id },
    files: ['content/content-script.js']
  });
});
```

### 13.4 Permission Denied Graceful Handling

```javascript
async function captureWithPermissionCheck() {
  const hasPermission = await chrome.permissions.contains({
    permissions: ['tabCapture']
  });

  if (!hasPermission) {
    const granted = await chrome.permissions.request({
      permissions: ['tabCapture']
    });

    if (!granted) {
      // Show user-friendly message, not a cryptic error
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'assets/icons/icon-128.png',
        title: 'Permission Required',
        message: 'ScreenSnap needs recording permission to capture your screen. Click the extension icon to grant access.',
      });
      return null;
    }
  }

  return await startCapture();
}
```

---

## 14. AUDIT CHECKLIST para ScreenSnap

### 🔒 Seguridad

- [ ] **Permissions audit:** ¿Cada permiso es realmente necesario?
- [ ] **`activeTab` vs `host_permissions`:** ¿Se puede usar `activeTab` en lugar de `<all_urls>`?
- [ ] **Content script declarativo:** ¿Se carga en todas las páginas innecesariamente? ¿Puede ser programático?
- [ ] **Sanitización de inputs:** Revisar todo uso de `innerHTML`, `document.write()`, `insertAdjacentHTML()`
- [ ] **CSP en manifest:** ¿Está definido `content_security_policy`?
- [ ] **web_accessible_resources:** ¿Solo los recursos mínimos están expuestos?
- [ ] **No eval/Function:** Verificar que no hay `eval()`, `new Function()`, `setTimeout(string)`
- [ ] **External message validation:** ¿Se valida el sender en `onMessageExternal`?
- [ ] **Content script isolated world:** ¿Se trata DOM data como untrusted?
- [ ] **Third-party libraries:** ¿Están actualizadas y auditadas?
- [ ] **No remote code:** Todo JS está bundled en la extensión
- [ ] **OWASP principles:** Data minimization, secure communication, input validation

### ⚡ Performance

- [ ] **Variables globales en SW:** ¿Hay estado en variables que se pierde al apagar SW?
- [ ] **MediaStream cleanup:** ¿Se detienen todos los tracks al parar grabación?
- [ ] **Object URL cleanup:** ¿Se llama `URL.revokeObjectURL()` después de cada uso?
- [ ] **Canvas cleanup:** ¿Se resetean dimensiones cuando ya no se usan?
- [ ] **Event listeners cleanup:** ¿Content scripts usan `AbortController`?
- [ ] **Storage size:** ¿Se guardan blobs grandes en `chrome.storage`? Migrar a downloads/IndexedDB
- [ ] **Back/forward cache:** ¿Hay `unload` listeners? ¿WebSockets en content scripts?
- [ ] **setInterval en SW:** ¿Hay intervalos que se pierden? Migrar a `chrome.alarms`
- [ ] **Lazy loading:** ¿Se importan módulos pesados solo cuando se necesitan?
- [ ] **Event filters:** ¿Se usan filtros en webNavigation/tabs para reducir event calls?

### 🔄 Service Worker Lifecycle

- [ ] **Event handlers at top level:** ¿Todos los listeners registrados en global scope?
- [ ] **No nested event registration:** ¿Ningún handler registrado dentro de callbacks?
- [ ] **State persistence:** ¿Todo estado crítico se guarda en `chrome.storage.session`?
- [ ] **Keepalive strategy:** ¿Hay keepalive durante recording (alarms, ports, WebSocket)?
- [ ] **Termination recovery:** ¿Qué pasa si el SW muere durante una grabación?
- [ ] **`minimum_chrome_version`:** ¿Está definido? (Recomendado: `"116"`)
- [ ] **initPromise pattern:** ¿Se espera a que el cache esté listo antes de operar?

### 🏗️ Arquitectura

- [ ] **Separación de concerns:** ¿Cada archivo tiene una responsabilidad clara?
- [ ] **Message types centralizados:** ¿Hay strings mágicos esparcidos? Crear `constants.js`
- [ ] **Error handling consistente:** ¿Todos los handlers async tienen try/catch?
- [ ] **Message router:** ¿Hay un pattern limpio para routing de mensajes?
- [ ] **ES Modules:** ¿El SW usa `"type": "module"`?
- [ ] **shared/ directory:** ¿El código compartido está centralizado?
- [ ] **Offscreen document lifecycle:** ¿Se verifica antes de crear? ¿Se cierra cuando no se necesita?
- [ ] **Double injection prevention:** ¿Content scripts verifican si ya están inyectados?

### 📁 Estructura de Archivos

- [ ] **Naming consistency:** ¿Todos los archivos siguen kebab-case?
- [ ] **Pages agrupadas:** Editor, history, settings, welcome en `pages/`
- [ ] **Shared utilities:** ¿Hay código duplicado que debería estar en `shared/`?
- [ ] **Assets organizados:** Icons, styles, fonts en subdirectorios claros
- [ ] **Tests directory:** ¿unit/, integration/, e2e/ existen?

### 📝 Código

- [ ] **JSDoc en funciones públicas:** ¿Las funciones exportadas tienen documentación?
- [ ] **Constantes:** ¿Hay magic numbers o strings hardcodeados?
- [ ] **Error types:** ¿Se usan error types específicos?
- [ ] **Logging consistente:** ¿Hay un sistema de logging centralizado?
- [ ] **Async/await consistente:** ¿Se mezclan callbacks y promises innecesariamente?

### 🎨 UX/UI

- [ ] **Loading states:** ¿Acciones lentas muestran feedback visual?
- [ ] **Error feedback:** ¿Errores se comunican claramente al usuario?
- [ ] **Keyboard navigation:** ¿Se puede operar sin mouse?
- [ ] **ARIA labels:** ¿Elementos interactivos tienen labels accesibles?
- [ ] **Dark mode:** ¿Se respeta `prefers-color-scheme`?
- [ ] **Theme consistency:** ¿CSS variables centralizadas?
- [ ] **Side Panel consideration:** ¿Beneficiaría tener side panel para historia/herramientas?

### 🧪 Testing

- [ ] **Unit tests:** ¿Existen para shared modules y handlers?
- [ ] **E2E tests:** ¿Hay tests con Puppeteer o Playwright?
- [ ] **Error paths:** ¿Se testan caminos de error?
- [ ] **Permissions denied:** ¿Se testa qué pasa cuando usuario niega permisos?
- [ ] **SW restart:** ¿Se testa que la extensión sobrevive un reinicio del SW?
- [ ] **Chrome internal pages:** ¿Se testa rechazo graceful en `chrome://` pages?
- [ ] **Fixed extension ID:** ¿Hay un key para ID consistente en testing?
- [ ] **Headless mode:** ¿Tests corren en CI con `headless: 'new'`?

### 🔧 Manifest

- [ ] **`minimum_chrome_version`:** Definido (recomendado: `"116"`)
- [ ] **Permisos opcionales:** `tabCapture`, `desktopCapture`, `notifications` como optional
- [ ] **ES Module en SW:** `"type": "module"` presente
- [ ] **i18n ready:** Nombre y descripción usan `__MSG_*__`
- [ ] **Version:** Sigue semver correctamente
- [ ] **Commands:** Keyboard shortcuts definidos con `suggested_key`
- [ ] **Side panel:** Definido si se usa

### 📋 Publicación (Chrome Web Store)

- [ ] **Privacy policy:** Existe y está actualizada
- [ ] **Store listing:** Screenshots (1280×800), description, category correctos
- [ ] **Promotional images:** Small tile (440×280) y marquee (1400×560)
- [ ] **Icon:** 128×128 con 96×96 artwork, PNG format
- [ ] **Permission justifications:** Cada permiso justificado en dashboard
- [ ] **Single purpose:** Declarado en Privacy tab
- [ ] **Data use certification:** Completado en Privacy tab
- [ ] **Remote code declaration:** "No remote code" si aplica
- [ ] **onInstalled handler:** Maneja `install` y `update` correctamente
- [ ] **Data migration:** Plan para migrar datos entre versiones
- [ ] **Deferred publishing:** Considerar para controlar timing de releases

### 🌐 Cross-Browser

- [ ] **Feature detection:** ¿Se usa feature detection en lugar de browser sniffing?
- [ ] **Firefox compatibility:** ¿Se ha evaluado porting a Firefox?
- [ ] **Edge compatibility:** ¿Se ha probado en Edge? (usualmente trivial)
- [ ] **webextension-polyfill:** ¿Se usa para cross-browser API normalization?
- [ ] **Platform-specific builds:** ¿Hay build pipeline para diferentes browsers?

### 🚨 Específicos de ScreenSnap

- [ ] **tabCapture user gesture:** ¿Capturas siempre inician desde user gesture?
- [ ] **Chrome pages check:** ¿Se verifica que no se intente capturar `chrome://`?
- [ ] **desktopCapture cancel:** ¿Se maneja cuando usuario cancela picker?
- [ ] **Offscreen document lifecycle:** ¿Se verifica si ya existe? ¿Se cierra al terminar?
- [ ] **Recording state recovery:** Si el SW se reinicia, ¿se recupera o notifica al usuario?
- [ ] **Large capture handling:** ¿Full-page screenshots de páginas largas causan OOM?
- [ ] **Multi-monitor:** ¿Se manejan correctamente capturas multi-monitor?
- [ ] **Content script re-injection:** ¿Qué pasa si se inyecta dos veces en la misma página?
- [ ] **Context invalidated:** ¿Se maneja el error cuando la extensión se actualiza mid-use?

---

## Referencias

### Chrome Extension Development
- [Chrome Extensions Developer Guide](https://developer.chrome.com/docs/extensions/develop/)
- [Manifest V3 Overview](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Service Workers Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Service Worker Events](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)
- [Longer Service Worker Lifetimes](https://developer.chrome.com/blog/longer-esw-lifetimes/)
- [Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Message Passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

### APIs
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [chrome.scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [chrome.sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [chrome.offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [chrome.action API](https://developer.chrome.com/docs/extensions/reference/api/action)

### Permissions & Security
- [Declare Permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [activeTab Permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Permission Warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)
- [Improve Extension Security (MV3)](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

### Testing
- [Testing Chrome Extensions](https://developer.chrome.com/docs/extensions/how-to/test/)
- [End-to-End Testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)
- [Puppeteer Chrome Extensions Guide](https://pptr.dev/guides/chrome-extensions)
- [Playwright Chrome Extensions Guide](https://playwright.dev/docs/chrome-extensions)

### Chrome Web Store
- [Publish to Chrome Web Store](https://developer.chrome.com/docs/webstore/publish/)
- [CWS Review Process](https://developer.chrome.com/docs/webstore/review-process/)
- [CWS Privacy Fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/)
- [CWS Listing Information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing/)
- [Supplying Images](https://developer.chrome.com/docs/webstore/images/)
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/)

### Cross-Browser
- [Porting to Firefox](https://extensionworkshop.com/documentation/develop/porting-a-google-chrome-extension/)
- [Porting to Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/port-chrome-extension)
- [Chrome Incompatibilities (Firefox)](https://developer.mozilla.org/Add-ons/WebExtensions/Chrome_incompatibilities)
- [Build a Secure Extension (Mozilla)](https://extensionworkshop.com/documentation/develop/build-a-secure-extension/)

---

*Documento generado como referencia definitiva para el desarrollo profesional del proyecto ScreenSnap.*
*Última actualización: 2026-03-16*
