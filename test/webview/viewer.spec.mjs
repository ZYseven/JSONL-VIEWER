import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/webview/harness.html');
});

test('renders the root and lazily expands a nested object', async ({ page }) => {
  await expect(page.locator('.row')).toHaveCount(4);
  await expect(page.locator('.closing:not([hidden])').first()).toHaveText('}');
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.getByText('"B"', { exact: true })).toBeVisible();
});

test('collapses the rendered JSON structure without leaving orphaned brackets', async ({ page }) => {
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await page.locator('#collapse-all').click();
  await expect(page.locator('.toggle.expanded')).toHaveCount(0);
  await expect(page.locator('.closing:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.node[data-id="$"] > .row > .preview')).toHaveText('{3}');
});

test('search expands the matching path without duplicate nodes', async ({ page }) => {
  await page.getByPlaceholder('Search keys and values').fill('B');
  await expect(page.locator('#search-count')).toHaveText('1/1');
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.locator('.row.current')).toHaveCount(1);
  await expect(page.getByText('"B"', { exact: true })).toHaveCount(1);
});

test('keeps the toolbar and tree inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.locator('.toolbar')).toHaveCSS('flex-wrap', 'nowrap');
  const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth }));
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
});
