// tests/e2e/extension.spec.js
import { test, expect } from './fixtures.js';

test('extension loads with active service worker', async ({ extensionId }) => {
  expect(extensionId).toBeTruthy();
  expect(extensionId.length).toBeGreaterThan(10);
});

test('popup page renders with action buttons', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#btn-visible')).toBeVisible();
  await expect(page.locator('#btn-full')).toBeVisible();
});

test('settings page loads and toggles persist', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings/settings.html`);
  await expect(page.locator('#ss-format')).toBeVisible();

  // Change a setting
  await page.selectOption('#ss-format', 'jpg');

  // Reload and verify persistence
  await page.reload();
  await expect(page.locator('#ss-format')).toHaveValue('jpg');
});

test('history page renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/history/history.html`);
  await expect(page.locator('.history-app')).toBeVisible();
  await expect(page.locator('#count-label')).toBeVisible();
});

test('welcome page renders onboarding', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
  await expect(page.locator('.welcome-app')).toBeVisible();
  await expect(page.locator('.slide[data-slide="0"]')).toBeVisible();
});
