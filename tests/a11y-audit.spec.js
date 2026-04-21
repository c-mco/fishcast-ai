/**
 * Accessibility audit — runs axe-core against the fully-loaded app.
 */
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');

const BASE = 'http://127.0.0.1:8080';

async function waitForApp(page) {
  await page.waitForFunction(
    () => document.getElementById('loading')?.style.display === 'none',
    { timeout: 30000 }
  );
}

async function axe(page, selector) {
  let builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']);
  if (selector) builder = builder.include(selector);
  return builder.analyze();
}

// ── axe-core scans ───────────────────────────────────────────────────────────

test('axe: loading screen has no violations', async ({ page }) => {
  await page.goto(BASE);
  const results = await axe(page, '#loading');
  if (results.violations.length) {
    console.log('LOADING SCREEN VIOLATIONS:');
    results.violations.forEach(v => {
      console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
      v.nodes.forEach(n => console.log('    node:', n.html));
    });
  }
  expect(results.violations).toEqual([]);
});

test('axe: full page after load — WCAG 2.1 AA', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const results = await axe(page);
  if (results.violations.length) {
    console.log('\nFULL PAGE VIOLATIONS:');
    results.violations.forEach(v => {
      console.log(`\n  [${v.impact}] ${v.id}`);
      console.log(`  Description: ${v.description}`);
      console.log(`  Help: ${v.helpUrl}`);
      v.nodes.forEach(n => console.log(`  Node: ${n.html.substring(0, 120)}`));
    });
  }
  expect(results.violations).toEqual([]);
});

test('axe: sidebar after load', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const results = await axe(page, '.sidebar');
  if (results.violations.length) {
    console.log('\nSIDEBAR VIOLATIONS:');
    results.violations.forEach(v => {
      console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
      v.nodes.forEach(n => console.log('    node:', n.html.substring(0, 120)));
    });
  }
  expect(results.violations).toEqual([]);
});

// ── Keyboard navigation ───────────────────────────────────────────────────────

test('Tab reaches every spot-item in the list', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const count = await page.locator('.spot-item').count();
  await page.keyboard.press('Tab');
  let found = 0;
  for (let i = 0; i < 50; i++) {
    const focused = await page.evaluate(() => document.activeElement?.className || '');
    if (focused.includes('spot-item')) found++;
    await page.keyboard.press('Tab');
  }
  expect(found).toBeGreaterThanOrEqual(count);
});

test('Enter on a focused spot-item opens its popup', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const firstSpot = page.locator('.spot-item').first();
  await firstSpot.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.leaflet-popup')).toBeVisible({ timeout: 5000 });
});

test('focus is visible on spot-items', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const firstSpot = page.locator('.spot-item').first();
  await firstSpot.focus();
  const outline = await firstSpot.evaluate(el => getComputedStyle(el).outline);
  expect(outline).not.toMatch(/^0px\s+none|^none/i);
});

// ── Reduced motion ────────────────────────────────────────────────────────────

test('spinner animation is suppressed with prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(BASE);
  const animName = await page.locator('.spinner').evaluate(
    el => getComputedStyle(el).animationName
  );
  expect(animName).toBe('none');
});

// ── ARIA & semantics ──────────────────────────────────────────────────────────

test('landmark regions: <main> exists', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const main = await page.locator('main, [role="main"]').count();
  expect(main).toBeGreaterThan(0);
});

test('loading region has role=status or aria-live', async ({ page }) => {
  await page.goto(BASE);
  const role = await page.locator('#loading').getAttribute('role');
  const live = await page.locator('#loading').getAttribute('aria-live');
  expect(role === 'status' || role === 'alert' || live !== null).toBeTruthy();
});

test('progress bar has role=progressbar with aria-valuenow/max', async ({ page }) => {
  await page.goto(BASE);
  const fill = page.locator('[role="progressbar"]');
  await expect(fill).toBeAttached();
  const valueMax = await fill.getAttribute('aria-valuemax');
  expect(valueMax).toBe('100');
});

test('spot-items have role=button or are <button> elements', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const count = await page.locator('.spot-item').count();
  let roleCount = 0;
  for (let i = 0; i < count; i++) {
    const el   = page.locator('.spot-item').nth(i);
    const tag  = await el.evaluate(e => e.tagName.toLowerCase());
    const role = await el.getAttribute('role');
    if (tag === 'button' || role === 'button') roleCount++;
  }
  expect(roleCount).toBe(count);
});

test('decorative emoji in section titles have aria-hidden', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const titles = await page.locator('.section-title').all();
  for (const t of titles) {
    const html = await t.innerHTML();
    if (/[\u{1F300}-\u{1FFFF}]/u.test(html)) {
      expect(html).toContain('aria-hidden');
    }
  }
});

test('map container has an accessible label', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const mapEl = page.locator('#map');
  const label = await mapEl.getAttribute('aria-label');
  const labelledBy = await mapEl.getAttribute('aria-labelledby');
  expect(label !== null || labelledBy !== null).toBeTruthy();
});

test('score circle has aria-label', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const label = await page.locator('#score-circle').getAttribute('aria-label');
  expect(label).not.toBeNull();
});

test('source badges have title or aria-label', async ({ page }) => {
  await page.goto(BASE);
  await waitForApp(page);
  const badges = page.locator('.src');
  const count = await badges.count();
  for (let i = 0; i < count; i++) {
    const title = await badges.nth(i).getAttribute('title');
    const ariaLabel = await badges.nth(i).getAttribute('aria-label');
    expect(title !== null || ariaLabel !== null).toBeTruthy();
  }
});


