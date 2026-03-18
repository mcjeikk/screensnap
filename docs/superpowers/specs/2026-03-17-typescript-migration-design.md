# Phase 3: TypeScript Migration

**Date:** 2026-03-17
**Status:** Draft
**Scope:** Migrate all ScreenBolt source files from JavaScript to TypeScript

---

## Goal

Add compile-time type safety to the entire codebase. No runtime behavior changes. The existing ~400 JSDoc annotations provide the foundation — most conversions are mechanical.

## Approach

`strict: true` from day 1 with `skipLibCheck: true` (industry standard). `@ts-expect-error` allowed only for Chrome API edge cases (target: <10 total). No `any` except explicitly typed `unknown` narrowing patterns.

---

## 1. Setup

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["chrome"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist", "docs"]
}
```

Key decisions:
- `noEmit: true` — Vite handles transpilation, `tsc` is only for type checking
- `moduleResolution: "bundler"` — matches Vite's resolution strategy; `.js` extension imports automatically resolve to `.ts` files
- `isolatedModules: true` — required by Vite (single-file transpilation)
- `types: ["chrome"]` — provides Chrome extension API types globally
- No `allowImportingTsExtensions` — not needed. With `moduleResolution: "bundler"`, existing `.js` imports resolve `.ts` files automatically

### Dependencies

```bash
npm install -D typescript @types/chrome typescript-eslint
```

### ESLint Update

Replace `@eslint/js` with `typescript-eslint` flat config. Both `.ts` and remaining `.js` files get linted — `tseslint.configs.recommended` includes base JS rules for non-TS files:

```js
// eslint.config.js
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'store/**',
      'docs/**',
      '*.md',
      'assets/icons/generate-icons.js',
      'assets/scripts/theme-init.js',
    ],
  },
);
```

### Package.json scripts

Add type check script:
```json
"typecheck": "tsc --noEmit"
```

### CI Update

Add `npm run typecheck` step after lint in the `lint-test-build` job in `ci.yml`.

### Files that stay JS

- `assets/scripts/theme-init.js` — injected as raw non-module `<script>`, cannot be TypeScript
- `assets/icons/generate-icons.js` — Node CLI utility, not part of extension
- `eslint.config.js` — stays JS (eslint flat config doesn't require TS)

---

## 2. Shared Types File

Create `utils/types.ts` with interfaces used across multiple files.

```ts
/** Recording configuration passed from popup → SW → offscreen.
 *  This is a transformed shape built by the SW from user settings,
 *  not the raw settings object. The SW maps recResolution→resolution,
 *  recAudio→microphone/systemAudio, recPip→pip, etc. */
export interface RecordingConfig {
  source: 'tab' | 'screen' | 'camera';
  streamId?: string;
  resolution: '720' | '1080' | '2160';
  microphone: boolean;
  systemAudio: boolean;
  pip: boolean;
  pipPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  pipSize: 'small' | 'medium' | 'large';
}

/** User settings stored in chrome.storage.sync.
 *  Must match DEFAULT_SETTINGS in utils/constants.ts exactly. */
export interface Settings {
  // Screenshot
  screenshotFormat: 'png' | 'jpg';
  jpgQuality: number;
  afterCapture: 'editor' | 'download' | 'clipboard';
  saveSubfolder: string;
  // Recording
  recResolution: '720' | '1080' | '2160';
  recAudio: 'microphone' | 'system' | 'both' | 'none';
  recPip: 'on' | 'off';
  recPipPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  recPipSize: 'small' | 'medium' | 'large';
  recCountdown: 'on' | 'off';
  recFormat: 'webm';
  // General
  theme: 'light' | 'dark' | 'system';
  notifications: 'on' | 'off';
  keepHistory: 'on' | 'off';
  maxHistory: number;
}

/** History entry stored in chrome.storage.local.
 *  `duration` is explicitly `null` for screenshots (not undefined). */
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
```

Additional types (annotation shapes, message payloads) will be defined inline in the files that own them.

---

## 3. Migration Order

Files migrated in dependency-graph order (leaves first). After each wave: `tsc --noEmit && npm run lint && npm test` must pass.

### Wave 1: Pure utilities (no Chrome API)

| File | Lines | Notes |
|------|-------|-------|
| `utils/types.ts` | New | Shared interfaces |
| `utils/constants.ts` | 236 | Enums → `as const` objects, export types |
| `utils/helpers.ts` | 197 | Pure functions, rich JSDoc |
| `utils/errors.ts` | 104 | ErrorCodes enum, ExtensionError class |

### Wave 2: Chrome-dependent utilities

Migrate `logger.ts` first within this wave — it's imported by `storage.ts`, `messages.ts`, and `migration.ts`.

| File | Lines | Notes |
|------|-------|-------|
| `utils/logger.ts` | 232 | Logger class + error buffer. Migrate first. |
| `utils/storage.ts` | 192 | Generic `get<T>()` wrappers |
| `utils/messages.ts` | 76 | Message send/receive typing |
| `utils/feature-detection.ts` | 105 | Chrome API capability checks |
| `utils/migration.ts` | 115 | Versioned migration runner |
| `utils/idb-storage.ts` | 147 | IndexedDB Promise wrapper |

### Wave 3: Core recording path

| File | Lines | Notes |
|------|-------|-------|
| `background/service-worker.ts` | 878 | Largest, most Chrome API usage |
| `offscreen/recorder-offscreen.ts` | 531 | MediaRecorder, AudioContext types |
| `recorder/preview.ts` | 150 | Simple IDB read + video player |

### Wave 4: Content scripts

| File | Lines | Notes |
|------|-------|-------|
| `content/content-script.ts` | 460 | Selection overlay, DOM manipulation |
| `content/recording-widget.ts` | 430 | Shadow DOM, element creation |

**Content script build strategy:** Add both as additional Rollup `input` entries in `vite.config.ts`. This makes Vite compile them as standalone chunks. Update the `copyDynamicFiles` plugin to copy the compiled output from `dist/content/` instead of raw source. Update `manifest.json` `web_accessible_resources` to reference the compiled `content/recording-widget.js` path (the CRX plugin may handle this automatically for declared inputs).

### Wave 5: UI pages

All page scripts are IIFEs (`(() => { ... })()`). Since they're loaded as `<script type="module">` via Vite's HTML processing, the IIFEs can be unwrapped to top-level module code as a mechanical step during migration. This is safe because ES modules already provide their own scope isolation.

| File | Lines | Notes |
|------|-------|-------|
| `popup/popup.ts` | 463 | DOM manipulation, Chrome API |
| `settings/settings.ts` | 171 | Form handling, storage |
| `history/history.ts` | 402 | Grid rendering, filtering |
| `welcome/welcome.ts` | 92 | Simple carousel |
| `permissions/permissions.ts` | 92 | Permission requests |
| `editor/editor.ts` | 1065 | Canvas API, annotation types |

### Wave 6: Tests + config

Update `vitest.config.ts` include pattern to `'tests/**/*.test.ts'` and `setupFiles` to `'./tests/setup.ts'` when renaming test files. Without this change, Vitest would find zero tests.

| File | Lines | Notes |
|------|-------|-------|
| `tests/setup.ts` | 40 | Chrome mock types |
| `tests/utils/*.test.ts` | ~600 | Test files |
| `vite.config.ts` | 43 | Build config + content script input update |
| `vitest.config.ts` | 10 | Update include glob + setupFiles path |
| `playwright.config.ts` | 8 | E2E config |

---

## 4. Per-File Migration Process

For each `.js` → `.ts` conversion:

1. **Rename** the file: `mv file.js file.ts`
2. **Unwrap IIFEs** in page scripts — replace `(() => { 'use strict'; ... })()` with top-level code (modules are already strict and scoped)
3. **Convert JSDoc types** to TypeScript signatures:
   - `/** @param {string} name */` → parameter type annotation
   - `/** @type {HTMLElement|null} */` → explicit variable type
   - `/** @returns {Promise<void>} */` → return type annotation
4. **Add missing types** where JSDoc didn't exist
5. **Replace `Object.freeze({...})` enums** with `as const` satisfies patterns where appropriate
6. **Verify**: `tsc --noEmit && npm run lint && npm test`
7. **No runtime changes** — if TypeScript reveals a latent bug, document it as a TODO, don't fix it in this phase

---

## 5. What NOT to do

- No runtime behavior changes
- No refactoring large files (editor.js stays monolithic — that's future work)
- No new features
- No changing the public API of any module
- `theme-init.js` stays JS (non-module script)
- `generate-icons.js` stays JS (Node CLI tool)

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| `strict: true` from day 1 | Catches the most bugs; JSDoc provides 70% of types already |
| `skipLibCheck: true` | Industry standard; avoids `@types/chrome` internal conflicts |
| `noEmit: true` | Vite handles compilation; `tsc` is type-checker only |
| `moduleResolution: "bundler"` | Matches Vite's resolution; `.js` imports resolve `.ts` files |
| No `allowImportingTsExtensions` | Not needed — bundler resolution handles `.js`→`.ts` |
| Shared `types.ts` for cross-module interfaces | Avoids circular dependencies; keeps types discoverable |
| Wave-based migration (6 waves) | Dependency-order ensures each wave compiles independently |
| Logger first in Wave 2 | It's a dependency of most other Wave 2 files |
| Content scripts as Rollup inputs | Compiles TS → JS, avoids raw copy of source |
| Unwrap IIFEs in page scripts | Modules provide scope isolation; IIFEs are redundant |
| Tests migrated last | Tests can import `.ts` modules from `.js` test files (Vitest handles it) |
| `eslint.config.js` stays JS | ESLint flat config works fine as JS; no benefit to TS |

## Files Created/Modified

| File | Change |
|------|--------|
| `tsconfig.json` | New |
| `utils/types.ts` | New: shared interfaces |
| `eslint.config.js` | Rewrite for typescript-eslint (stays `.js`) |
| `package.json` | Add typescript, @types/chrome, typescript-eslint; add `typecheck` script |
| `.github/workflows/ci.yml` | Add `npm run typecheck` step |
| `manifest.json` | Update `web_accessible_resources` path if needed |
| All `utils/*.js` | Rename to `.ts`, add types |
| All page `*.js` | Rename to `.ts`, add types, unwrap IIFEs |
| `content/*.js` | Rename to `.ts`, add as Rollup inputs |
| `vite.config.js` → `vite.config.ts` | Rename, add content script inputs, update copy plugin |
| `vitest.config.js` → `vitest.config.ts` | Rename, update include glob + setupFiles |
| `tests/**/*.js` | Rename to `.ts` |
