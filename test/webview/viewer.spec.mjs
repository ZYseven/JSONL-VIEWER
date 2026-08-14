import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/webview/harness.html');
});

test('renders the root and lazily expands a nested object', async ({ page }) => {
  await expect(page.locator('.row')).toHaveCount(4);
  await expect(page.locator('.closing:not([hidden])').first().locator('.closing-body')).toHaveText('}');
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.getByText('"B"', { exact: true })).toBeVisible();
});

test('collapses the rendered JSON structure without leaving orphaned brackets', async ({ page }) => {
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await page.locator('#collapse-all').click();
  await expect(page.locator('.toggle.expanded')).toHaveCount(0);
  await expect(page.locator('.closing:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.node[data-id="$"] > .row > .preview')).toHaveText('{4}');
});

test('search expands the matching path without duplicate nodes', async ({ page }) => {
  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-panel')).toBeVisible();
  await page.getByPlaceholder('Search keys and values').fill('B');
  await expect(page.locator('#search-count')).toHaveText('1/1');
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.locator('.row.current')).toHaveCount(1);
  await expect(page.getByText('"B"', { exact: true })).toHaveCount(1);
});

test('keeps controls floating and the tree inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.locator('.toolbar')).toHaveCSS('position', 'fixed');
  const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth }));
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
  await expect(page.locator('.toolbar')).toHaveCSS('right', '24px');
});

test('uses the VS Code editor font, gutter, and depth-aware brackets', async ({ page }) => {
  await expect(page.locator('body')).toHaveCSS('font-family', /Consolas|monospace/i);
  await expect(page.locator('.row').first()).toHaveCSS('padding-left', '68px');
  await expect(page.locator('.row').first().locator('.line')).toHaveText('1');
  const rootBracket = page.locator('.node[data-id="$"] > .row > .preview');
  await expect(rootBracket).toHaveClass(/bracket/);
  await expect(rootBracket).toHaveClass(/depth-0/);
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await expect(page.locator('.node[data-id="$/scores#0"] > .row > .preview')).toHaveClass(/depth-1/);
  await expect(page.locator('.node[data-id="$/scores#0"] > .closing > .closing-body')).toHaveClass(/depth-1/);
});

test('keeps the line-number gutter left of the disclosure control', async ({ page }) => {
  const geometry = await page.locator('.node[data-id="$"] > .row').evaluate((row) => {
    const line = row.querySelector('.line').getBoundingClientRect();
    const toggle = row.querySelector('.toggle').getBoundingClientRect();
    return { lineRight: line.right, toggleLeft: toggle.left };
  });
  expect(geometry.lineRight).toBeLessThanOrEqual(geometry.toggleLeft);
});

test('renumbers visible rows after expand and collapse', async ({ page }) => {
  const visibleNumbers = () => page.locator('.row:visible > .line, .closing:visible > .line').allTextContents();
  await expect.poll(visibleNumbers).toEqual(['1', '2', '3', '4', '5']);

  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await expect.poll(visibleNumbers).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);

  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await expect.poll(visibleNumbers).toEqual(['1', '2', '3', '4', '5']);

  await page.locator('#collapse-all').click();
  await expect.poll(visibleNumbers).toEqual(['1']);
});

test('loads the next page to the last visible item expansion depth', async ({ page }) => {
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await page.locator('.node[data-id="$"] > .children > .children-more').click();

  await expect(page.locator('.node[data-id="$/more#0"] > .row > .toggle')).toHaveClass(/expanded/);
  await expect(page.locator('.node[data-id="$/more#0/deep#0"] > .row > .toggle')).not.toHaveClass(/expanded/);
  await expect(page.locator('.node[data-id="$/more#0/deep#0/value#0"]')).toHaveCount(0);
});

test('loads streamed JSONL records top-to-bottom without inheriting deep expansion', async ({ page }) => {
  await page.goto('/test/webview/harness.html?jsonl');
  await page.locator('.node[data-id="record:1"] > .row > .toggle').click();
  await page.locator('.node[data-id="$jsonl"] > .children > .children-more').click();

  await expect(page.locator('.node[data-id="record:2"] > .row > .toggle')).not.toHaveClass(/expanded/);
});

test('uses a square editor-line-height disclosure target', async ({ page }) => {
  const toggle = page.locator('.node[data-id="$"] > .row > .toggle');
  const size = await toggle.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height };
  });
  expect(size.width).toBe(size.height);
  expect(Number.parseFloat(size.width)).toBeGreaterThan(18);
});

test('cycles the fourth bracket level back to the first VS Code bracket color', async ({ page }) => {
  await page.locator('.node[data-id="$/scores#0"] > .row > .toggle').click();
  await page.locator('.node[data-id="$/scores#0/A#0"] > .row > .toggle').click();
  const fourthLevel = page.locator('.node[data-id="$/scores#0/A#0/deep#0"] > .row > .preview');
  await expect(fourthLevel).toHaveClass(/depth-0/);
  await expect(fourthLevel).toHaveCSS('color', 'rgb(255, 215, 0)');
});

test('shows copy affordance only on the hovered token', async ({ page }) => {
  const key = page.getByText('"sample_id"', { exact: true });
  await expect(key).toHaveCSS('cursor', 'pointer');
  await key.hover();
  await expect(key).toHaveCSS('background-color', 'rgb(42, 45, 46)');
  await expect(key.locator('xpath=ancestor::div[contains(@class,"row")]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('keeps search hidden until Ctrl+F and closes it with Escape', async ({ page }) => {
  await expect(page.locator('#search-panel')).toBeHidden();
  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-panel')).toBeHidden();
});
