import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import manifest from './manifest.json' with { type: 'json' };

/**
 * Plugin to pre-compile content scripts (TypeScript → JS) and copy static assets.
 * Content scripts are injected via chrome.scripting.executeScript() as classic
 * scripts (not modules), so they must be standalone compiled JS files.
 */
function handleContentScripts(): Plugin {
  const contentScripts = ['content-script', 'recording-widget'];
  const root = import.meta.dirname;

  return {
    name: 'handle-content-scripts',
    // Compile TS → JS before CRX plugin resolves manifest assets
    config() {
      for (const script of contentScripts) {
        const tsPath = resolve(root, `content/${script}.ts`);
        const jsPath = resolve(root, `content/${script}.js`);
        if (existsSync(tsPath)) {
          const tsCode = readFileSync(tsPath, 'utf-8');
          const result = ts.transpileModule(tsCode, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.None, // Classic script, not a module
              strict: false, // No runtime effect from strict in transpile-only
              removeComments: false,
            },
          });
          writeFileSync(jsPath, result.outputText);
        }
      }
    },
    // Copy compiled content scripts + static assets to dist
    writeBundle() {
      const dist = resolve(root, 'dist');
      mkdirSync(resolve(dist, 'content'), { recursive: true });
      for (const script of contentScripts) {
        const jsPath = resolve(root, `content/${script}.js`);
        if (existsSync(jsPath)) {
          cpSync(jsPath, resolve(dist, `content/${script}.js`));
        }
      }
      cpSync('content/content-style.css', resolve(dist, 'content/content-style.css'));

      mkdirSync(resolve(dist, 'assets/scripts'), { recursive: true });
      cpSync('assets/scripts/theme-init.js', resolve(dist, 'assets/scripts/theme-init.js'));
    },
  };
}

export default defineConfig({
  plugins: [handleContentScripts(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        editor: 'editor/editor.html',
        preview: 'recorder/preview.html',
        history: 'history/history.html',
        settings: 'settings/settings.html',
        welcome: 'welcome/welcome.html',
        permissions: 'permissions/permissions.html',
        offscreen: 'offscreen/recorder-offscreen.html',
      },
    },
  },
});
