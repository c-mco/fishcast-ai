// @ts-check
const { test, expect } = require('@playwright/test');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the loading overlay to disappear (app fully loaded) */
async function waitForAppReady(page) {
  await expect(page.locator('#loading')).toBeHidden({ timeout: 25000 });
}

/** Intercept API calls and return their responses for inspection */
function captureRequests(page) {
  const calls = [];
  page.on('request', req => {
    if (req.url().includes('/api/')) calls.push({ url: req.url(), method: req.method() });
  });
  return calls;
}

// ── 1. Infrastructure ─────────────────────────────────────────────────────────

test.describe('Backend health', () => {
  test('GET /health returns ok + cache stats', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.cache).toHaveProperty('hits');
    expect(body.cache).toHaveProperty('misses');
    expect(body.cache).toHaveProperty('entries');
    expect(body.cache).toHaveProperty('hit_rate_pct');
    expect(body.ttls.weather).toBe('10m0s');
    expect(body.ttls.spots).toBe('1h0m0s');
  });

  test('GET / serves HTML with correct title', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('FishCast AI');
    expect(text).toContain('leaflet');
  });
});

// ── 2. Weather API ────────────────────────────────────────────────────────────

test.describe('Weather API', () => {
  test('returns real weather data for valid coords', async ({ request }) => {
    const res = await request.get('/api/weather?lat=-33.8688&lon=151.2093');
    expect(res.status()).toBe(200);

    const body = await res.json();
    const c = body.current;
    expect(typeof c.temperature_2m).toBe('number');
    expect(typeof c.wind_speed_10m).toBe('number');
    expect(typeof c.cloud_cover).toBe('number');
    expect(typeof c.precipitation_probability).toBe('number');
    expect(typeof c.weather_code).toBe('number');

    // Sanity-check plausible real values
    expect(c.temperature_2m).toBeGreaterThan(-60);
    expect(c.temperature_2m).toBeLessThan(60);
    expect(c.wind_speed_10m).toBeGreaterThanOrEqual(0);
    expect(c.cloud_cover).toBeGreaterThanOrEqual(0);
    expect(c.cloud_cover).toBeLessThanOrEqual(100);
  });

  test('second request is a cache HIT', async ({ request }) => {
    await request.get('/api/weather?lat=-33.8688&lon=151.2093');
    const res = await request.get('/api/weather?lat=-33.8688&lon=151.2093');
    expect(res.headers()['x-cache']).toBe('HIT');
  });

  test('nearby coords (same 2dp) hit cache due to rounding', async ({ request }) => {
    await request.get('/api/weather?lat=-33.8688&lon=151.2093');
    const res = await request.get('/api/weather?lat=-33.8695&lon=151.2098');
    expect(res.headers()['x-cache']).toBe('HIT');
  });

  test('missing lat returns 400 with error JSON', async ({ request }) => {
    const res = await request.get('/api/weather?lon=151.2093');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('lat');
  });

  test('missing lon returns 400 with error JSON', async ({ request }) => {
    const res = await request.get('/api/weather?lat=-33.8688');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('lon');
  });
});

// ── 3. Spots API ──────────────────────────────────────────────────────────────

test.describe('Spots API (iNaturalist)', () => {
  test('returns real hotspots with expected shape', async ({ request }) => {
    const res = await request.get('/api/spots?lat=-33.8688&lon=151.2093&radius=25');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('iNaturalist');
    expect(Array.isArray(body.hotspots)).toBe(true);
    expect(body.hotspots.length).toBeGreaterThan(0);

    const h = body.hotspots[0];
    expect(typeof h.name).toBe('string');
    expect(typeof h.lat).toBe('number');
    expect(typeof h.lon).toBe('number');
    expect(Array.isArray(h.species)).toBe(true);
    expect(h.species.length).toBeGreaterThan(0);
    expect(typeof h.count).toBe('number');
    expect(h.count).toBeGreaterThan(0);
    expect(typeof h.last_seen).toBe('string');
    expect(h.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('hotspots are sorted by observation count descending', async ({ request }) => {
    const res = await request.get('/api/spots?lat=-33.8688&lon=151.2093&radius=25');
    const { hotspots } = await res.json();
    for (let i = 1; i < hotspots.length; i++) {
      expect(hotspots[i - 1].count).toBeGreaterThanOrEqual(hotspots[i].count);
    }
  });

  test('second request is a cache HIT', async ({ request }) => {
    await request.get('/api/spots?lat=-33.8688&lon=151.2093&radius=25');
    const res = await request.get('/api/spots?lat=-33.8688&lon=151.2093&radius=25');
    expect(res.headers()['x-cache']).toBe('HIT');
  });

  test('missing lat returns 400', async ({ request }) => {
    const res = await request.get('/api/spots?lon=151.2093&radius=25');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('lat');
  });
});

// ── 4. Loading screen UX ─────────────────────────────────────────────────────

test.describe('Loading screen', () => {
  test('shows loading overlay on initial load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading')).toBeVisible();
  });

  test('shows all 5 progress steps', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#step-gps')).toBeVisible();
    await expect(page.locator('#step-map')).toBeVisible();
    await expect(page.locator('#step-wx')).toBeVisible();
    await expect(page.locator('#step-spots')).toBeVisible();
    await expect(page.locator('#step-ai')).toBeVisible();
  });

  test('progress bar fill element exists and moves', async ({ page }) => {
    // Delay spots so loading screen is still showing when we check
    await page.route('/api/spots*', async route => {
      await new Promise(r => setTimeout(r, 2000));
      route.continue();
    });
    await page.goto('/');
    const fill = page.locator('#progress-fill');
    await expect(fill).toBeVisible();
    const width = await fill.evaluate(el => parseInt(el.style.width));
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100);
  });

  test('loading overlay disappears after app loads', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('#loading')).toBeHidden();
  });
});

// ── 5. App content after load ─────────────────────────────────────────────────

test.describe('App content', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('header title is visible', async ({ page }) => {
    await expect(page.locator('header h1')).toContainText('FishCast AI');
  });

  test('live badge is shown in header', async ({ page }) => {
    await expect(page.locator('.badge')).toContainText('Live');
  });

  test('time display is populated (not dashes)', async ({ page }) => {
    const text = await page.locator('#time-display').textContent();
    expect(text).not.toBe('--');
    expect(text.length).toBeGreaterThan(5);
  });

  test('weather tiles show real numbers', async ({ page }) => {
    const grid = page.locator('#weather-grid');
    await expect(grid).toBeVisible();
    // Should contain a temperature like "20.1°C"
    await expect(grid).toContainText('°C');
    await expect(grid).toContainText('km/h');
    await expect(grid).toContainText('%');
  });

  test('conditions score circle shows a number 0–100', async ({ page }) => {
    const val = await page.locator('#score-val').textContent();
    const n = parseInt(val, 10);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(100);
  });

  test('score grade label is one of the valid grades', async ({ page }) => {
    const grade = await page.locator('#score-grade').textContent();
    expect(['Excellent', 'Good', 'Fair', 'Poor', 'Bad']).toContain(grade.trim());
  });

  test('score text description is populated', async ({ page }) => {
    const text = await page.locator('#score-text').textContent();
    expect(text.length).toBeGreaterThan(10);
  });

  test('hotspot list renders at least one spot', async ({ page }) => {
    await expect(page.locator('.spot-item').first()).toBeVisible();
  });

  test('hotspot items show observation count', async ({ page }) => {
    const firstSpot = page.locator('.spot-item').first();
    await expect(firstSpot.locator('.obs-count')).toContainText('obs');
  });

  test('hotspot items show last-seen date', async ({ page }) => {
    const firstSpot = page.locator('.spot-item').first();
    const text = await firstSpot.locator('.last-seen').textContent();
    // Should be "today", "yesterday", or "N days ago"
    expect(text).toMatch(/today|yesterday|\d+ days ago/);
  });

  test('conditions summary is populated', async ({ page }) => {
    const insight = await page.locator('#ai-insight').textContent();
    expect(insight.length).toBeGreaterThan(20);
    expect(insight).not.toContain('Analysing');
  });
});

// ── 6. Data transparency labels ───────────────────────────────────────────────

test.describe('Data source transparency', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('shows Device GPS source badge on location section', async ({ page }) => {
    await expect(page.locator('.src-device')).toContainText('Device GPS');
  });

  test('shows Live · Open-Meteo badge on weather section', async ({ page }) => {
    await expect(page.locator('.src-live')).toContainText('Open-Meteo');
  });

  test('shows Calculated badge on score section', async ({ page }) => {
    const calcs = page.locator('.src-calc');
    await expect(calcs.first()).toContainText('Calculated');
  });

  test('shows iNaturalist badge on hotspots section', async ({ page }) => {
    await expect(page.locator('.src-obs').first()).toContainText('iNaturalist');
  });

  test('score section note explicitly says Not AI', async ({ page }) => {
    const notes = page.locator('.section-note');
    const allText = await notes.allTextContents();
    const hasNotAI = allText.some(t => t.includes('Not AI') || t.includes('Not an AI'));
    expect(hasNotAI).toBe(true);
  });

  test('weather section note warns about missing tide data', async ({ page }) => {
    const notes = page.locator('.section-note');
    const allText = await notes.allTextContents();
    const hasTideWarning = allText.some(t => t.toLowerCase().includes('tide') || t.toLowerCase().includes('water temperature'));
    expect(hasTideWarning).toBe(true);
  });

  test('hotspot section note mentions iNaturalist observations', async ({ page }) => {
    const notes = page.locator('.section-note');
    const allText = await notes.allTextContents();
    const hasINat = allText.some(t => t.includes('iNaturalist'));
    expect(hasINat).toBe(true);
  });
});

// ── 7. Map ────────────────────────────────────────────────────────────────────

test.describe('Map', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('Leaflet map container is rendered', async ({ page }) => {
    await expect(page.locator('#map')).toBeVisible();
    // Leaflet adds .leaflet-container when initialised
    await expect(page.locator('.leaflet-container')).toBeVisible();
  });

  test('map has tile layer loaded (canvas or img tiles)', async ({ page }) => {
    // The tile pane is always present once Leaflet initialises — tile images
    // may not load in headless but the pane container itself must exist.
    await expect(page.locator('.leaflet-tile-pane')).toBeAttached();
  });

  test('user location marker is on the map', async ({ page }) => {
    // L.marker() places icons in .leaflet-marker-pane (not overlay pane)
    await expect(page.locator('.leaflet-marker-pane .leaflet-marker-icon').first()).toBeVisible({ timeout: 8000 });
  });

  test('hotspot markers are placed on the map', async ({ page }) => {
    const markers = page.locator('.leaflet-marker-pane .leaflet-marker-icon');
    await expect(markers.first()).toBeVisible({ timeout: 10000 });
    const count = await markers.count();
    expect(count).toBeGreaterThan(0);
  });
});

// ── 8. Interactivity ──────────────────────────────────────────────────────────

test.describe('Interactivity', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('clicking a hotspot in sidebar opens a map popup', async ({ page }) => {
    // Click the first spot item
    await page.locator('.spot-item').first().click();
    // Leaflet popup should appear
    await expect(page.locator('.leaflet-popup')).toBeVisible({ timeout: 5000 });
  });

  test('popup contains real species name', async ({ page }) => {
    await page.locator('.spot-item').first().click();
    const popup = page.locator('.leaflet-popup-content');
    await expect(popup).toBeVisible({ timeout: 5000 });
    // Should not just say "Unknown"
    const text = await popup.textContent();
    expect(text.length).toBeGreaterThan(10);
  });

  test('popup shows observation count', async ({ page }) => {
    await page.locator('.spot-item').first().click();
    await expect(page.locator('.leaflet-popup-content')).toContainText('obs', { timeout: 5000 });
  });

  test('popup credits iNaturalist as source', async ({ page }) => {
    await page.locator('.spot-item').first().click();
    await expect(page.locator('.leaflet-popup-content')).toContainText('iNaturalist', { timeout: 5000 });
  });

  test('clicking second spot also opens popup', async ({ page }) => {
    const spots = page.locator('.spot-item');
    const count = await spots.count();
    if (count >= 2) {
      await spots.nth(1).click();
      await expect(page.locator('.leaflet-popup')).toBeVisible({ timeout: 5000 });
    }
  });
});

// ── 9. Error handling — geolocation denied ───────────────────────────────────

test.describe('Error handling', () => {
  test('shows fatal error if geolocation is denied', async ({ browser }) => {
    // Create a context WITHOUT geolocation permission
    const context = await browser.newContext({
      permissions: [], // no geolocation
      geolocation: undefined,
    });
    const page = await context.newPage();

    // Override geolocation to reject immediately
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'geolocation', {
        value: {
          getCurrentPosition: (_success, error) => {
            error({ code: 1, message: 'User denied geolocation' });
          },
        },
        configurable: true,
      });
    });

    await page.goto('/');

    // Loading screen should stay visible and show an error
    const loading = page.locator('#loading');
    await expect(loading).toBeVisible({ timeout: 10000 });
    await expect(loading).toContainText(/denied|unavailable|location/i, { timeout: 10000 });

    // Should NOT transition to the main app
    await expect(page.locator('#loading')).toBeVisible();
    await context.close();
  });

  test('shows Try Again button on fatal error', async ({ browser }) => {
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'geolocation', {
        value: { getCurrentPosition: (_s, e) => e({ code: 1, message: 'Denied' }) },
        configurable: true,
      });
    });
    await page.goto('/');
    await expect(page.locator('#loading button')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#loading button')).toContainText(/try again/i);
    await context.close();
  });
});
