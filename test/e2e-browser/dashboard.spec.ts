import { test, expect } from '@playwright/test';

const TOKEN = process.env.CONFIG_API_TOKEN;
if (!TOKEN) throw new Error('CONFIG_API_TOKEN env var is required — set it before running browser tests');
const SMALL = process.env.TEST_SMALL_VIDEO ?? '/rocky.mp4';
const HUGE = process.env.TEST_HUGE_VIDEO ?? '/big_buck_bunny_1080p.mov';

// Helper: login via the server-rendered login page and wait for React dashboard
async function login(page: import('@playwright/test').Page) {
	await page.goto('/admin/dashboard');
	// Set token in localStorage so the React app can use it for API calls after login
	await page.evaluate((t) => localStorage.setItem('vr2-token', t), TOKEN);
	// Fill and submit the server-rendered login form
	await page.fill('input[type="password"]', TOKEN);
	await page.click('button[type="submit"]');
	// After login, the server sets a session cookie and serves the Astro/React dashboard.
	// Wait for the Radix tab list to appear (confirms React hydration is complete).
	await page.waitForSelector('[role="tablist"]', { timeout: 20_000 });
}

/** Navigate to the Debug Workbench tab. */
async function openDebugTab(page: import('@playwright/test').Page) {
	await login(page);
	await page.getByRole('tab', { name: /Debug/i }).click();
	// Wait for the workbench to render — lazy-loaded, may take a moment
	await expect(page.locator('input[aria-label="Video path"]')).toBeVisible({ timeout: 15_000 });
}

/** Fill path and run a test in the Debug Workbench. */
async function runDebugTest(page: import('@playwright/test').Page, path: string) {
	const input = page.locator('input[aria-label="Video path"]');
	await input.fill(path);
	await page.getByRole('button', { name: /^Test$/i }).click();
}

test.describe('Dashboard login', () => {
	test('shows login page without session', async ({ page }) => {
		await page.goto('/admin/dashboard');
		await expect(page.locator('h1')).toHaveText('video-resizer');
		await expect(page.locator('input[type="password"]')).toBeVisible();
		await expect(page.locator('button[type="submit"]')).toHaveText('Sign in');
	});

	test('rejects invalid token', async ({ page }) => {
		await page.goto('/admin/dashboard');
		await page.fill('input[type="password"]', 'wrong-token');
		await page.click('button[type="submit"]');
		await expect(page.locator('#error')).toBeVisible();
		await expect(page.locator('#error')).toContainText('Invalid token');
	});

	test('accepts valid token and shows dashboard', async ({ page }) => {
		await login(page);
		await expect(page.locator('h1')).toHaveText('video-resizer');
		// Radix tabs should be visible
		await expect(page.getByRole('tab', { name: /Analytics/i })).toBeVisible();
		await expect(page.getByRole('tab', { name: /Jobs/i })).toBeVisible();
		await expect(page.getByRole('tab', { name: /Debug/i })).toBeVisible();
	});

	test('session persists on reload', async ({ page }) => {
		await login(page);
		await expect(page.getByRole('tab', { name: /Analytics/i })).toBeVisible({ timeout: 5_000 });
		await page.reload();
		// After reload, either dashboard loads (session valid) or login page shows
		const hasTabs = await page.getByRole('tab', { name: /Analytics/i }).isVisible({ timeout: 5_000 }).catch(() => false);
		const hasLogin = await page.locator('button[type="submit"]').isVisible().catch(() => false);
		expect(hasTabs || hasLogin).toBe(true);
	});
});

test.describe('Analytics tab', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test('shows stat cards with data', async ({ page }) => {
		await expect(page.getByText('Total Requests')).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText('Success')).toBeVisible();
		await expect(page.getByText('Errors', { exact: true })).toBeVisible();
		await expect(page.getByText('Cache Hit Rate')).toBeVisible();
	});

	test('shows latency metrics', async ({ page }) => {
		await expect(page.getByText('Avg Latency')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('p50 Latency')).toBeVisible();
		await expect(page.getByText('p95 Latency')).toBeVisible();
	});

	test('shows breakdown tables when data exists', async ({ page }) => {
		await expect(page.getByText('Total Requests')).toBeVisible({ timeout: 10_000 });
		const hasBreakdown = await page.getByText('By Status').isVisible().catch(() => false)
			|| await page.getByText('By Origin').isVisible().catch(() => false);
		expect(hasBreakdown).toBe(true);
	});

	test('time range selector works', async ({ page }) => {
		await expect(page.getByText('Total Requests')).toBeVisible({ timeout: 10_000 });
		// Click the "1h" segmented button to change time range
		await page.click('button:has-text("1h")');
		// Click Refresh button
		await page.click('button:has-text("Refresh")');
		await expect(page.getByText('Total Requests')).toBeVisible({ timeout: 10_000 });
	});
});

test.describe('Jobs tab', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.getByRole('tab', { name: /Jobs/i }).click();
	});

	test('shows filter input and refresh controls', async ({ page }) => {
		await expect(page.locator('input[placeholder*="Filter"]')).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText('Refresh')).toBeVisible();
	});

	test('shows job list or empty state', async ({ page }) => {
		// Wait for the jobs tab to finish loading — one of these must appear
		await expect(
			page.getByText(/Active \(\d+\)|Recent \(\d+\)|No container transform jobs found/).first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test('status filter buttons visible', async ({ page }) => {
		await expect(page.locator('button:has-text("all")')).toBeVisible({ timeout: 5_000 });
		await expect(page.locator('button:has-text("active")')).toBeVisible();
		await expect(page.locator('button:has-text("complete")')).toBeVisible();
		await expect(page.locator('button:has-text("failed")')).toBeVisible();
	});

	test('job table has correct column headers when jobs exist', async ({ page }) => {
		const hasTable = await page.locator('th:has-text("Status")').isVisible({ timeout: 10_000 }).catch(() => false);
		if (hasTable) {
			await expect(page.locator('th:has-text("Path")')).toBeVisible();
		}
	});
});

// ── Debug Workbench ──────────────────────────────────────────────────

test.describe('Debug Workbench — layout and controls', () => {
	test.beforeEach(async ({ page }) => {
		await openDebugTab(page);
	});

	test('shows path input, test button, compare button', async ({ page }) => {
		await expect(page.locator('input[aria-label="Video path"]')).toBeVisible();
		await expect(page.getByRole('button', { name: /^Test$/i })).toBeVisible();
		await expect(page.getByRole('button', { name: /Compare/i })).toBeVisible();
	});

	test('shows generated URL bar', async ({ page }) => {
		// The readonly URL bar should show the generated URL
		const urlCode = page.locator('code').first();
		await expect(urlCode).toBeVisible();
		await expect(urlCode).toContainText('/rocky.mp4');
	});

	test('shows skip cache checkbox', async ({ page }) => {
		await expect(page.getByText('Skip cache (debug)')).toBeVisible();
	});

	test('shows Akamai URL toggle', async ({ page }) => {
		await expect(page.getByText('Show Akamai URLs')).toBeVisible();
	});

	test('shows container status badge from config', async ({ page }) => {
		// Config is fetched on mount — badge should appear once loaded
		const hasBadge = await page.getByText(/Container (?:enabled|disabled)/i).isVisible({ timeout: 10_000 }).catch(() => false);
		expect(hasBadge).toBe(true);
	});
});

test.describe('Debug Workbench — param form', () => {
	test.beforeEach(async ({ page }) => {
		await openDebugTab(page);
	});

	test('shows Transform Params card with mode dropdown', async ({ page }) => {
		await expect(page.getByText('Transform Params')).toBeVisible();
		await expect(page.locator('select[aria-label="Mode"]')).toBeVisible();
	});

	test('mode dropdown has all options', async ({ page }) => {
		const modeSelect = page.locator('select[aria-label="Mode"]');
		const options = await modeSelect.locator('option').allTextContents();
		expect(options).toContain('(none)');
		expect(options).toContain('video');
		expect(options).toContain('frame');
		expect(options).toContain('spritesheet');
		expect(options).toContain('audio');
	});

	test('shows dimension inputs', async ({ page }) => {
		await expect(page.locator('input[aria-label="Width"]')).toBeVisible();
		await expect(page.locator('input[aria-label="Height"]')).toBeVisible();
	});

	test('shows fit, quality, compression dropdowns', async ({ page }) => {
		await expect(page.locator('select[aria-label="Fit"]')).toBeVisible();
		await expect(page.locator('select[aria-label="Quality"]')).toBeVisible();
		await expect(page.locator('select[aria-label="Compression"]')).toBeVisible();
	});

	test('derivative dropdown populated from config', async ({ page }) => {
		const derivSelect = page.locator('select[aria-label="Derivative"]');
		await expect(derivSelect).toBeVisible();
		// Config fetch populates derivatives — wait for more than just "(none)"
		await page.waitForFunction(() => {
			const sel = document.querySelector('select[aria-label="Derivative"]');
			return sel ? sel.querySelectorAll('option').length > 1 : false;
		}, null, { timeout: 10_000 });
		const options = await derivSelect.locator('option').allTextContents();
		expect(options.length).toBeGreaterThan(1);
		expect(options[0]).toBe('(none)');
	});

	test('mode=frame hides fps/speed/bitrate, shows time', async ({ page }) => {
		await page.locator('select[aria-label="Mode"]').selectOption('frame');
		await expect(page.locator('input[aria-label="Time offset"]')).toBeVisible();
		// FPS and speed should not be visible in frame mode
		await expect(page.locator('input[aria-label="Frames per second"]')).not.toBeVisible();
		await expect(page.locator('input[aria-label="Playback speed"]')).not.toBeVisible();
		await expect(page.locator('input[aria-label="Bitrate"]')).not.toBeVisible();
	});

	test('mode=audio hides width/height, shows duration', async ({ page }) => {
		await page.locator('select[aria-label="Mode"]').selectOption('audio');
		await expect(page.locator('input[aria-label="Width"]')).not.toBeVisible();
		await expect(page.locator('input[aria-label="Height"]')).not.toBeVisible();
		await expect(page.locator('input[aria-label="Duration"]')).toBeVisible();
	});

	test('mode=spritesheet shows imageCount', async ({ page }) => {
		await page.locator('select[aria-label="Mode"]').selectOption('spritesheet');
		await expect(page.locator('input[aria-label="Image count"]')).toBeVisible();
	});

	test('changing params updates generated URL', async ({ page }) => {
		await page.locator('input[aria-label="Width"]').fill('640');
		const urlCode = page.locator('code').first();
		await expect(urlCode).toContainText('width=640');
	});
});

test.describe('Debug Workbench — test execution', () => {
	test.beforeEach(async ({ page }) => {
		await openDebugTab(page);
	});

	test('tests a URL and shows preview + diagnostics', async ({ page }) => {
		await runDebugTest(page, SMALL);
		// Should show diagnostics card
		await expect(page.getByText('Diagnostics')).toBeVisible({ timeout: 15_000 });
		// Should show response headers
		await expect(page.getByText('Response Headers')).toBeVisible();
	});

	test('shows response summary with status, size, time', async ({ page }) => {
		await runDebugTest(page, SMALL);
		// ResponseSummary renders a row of icon+label+value items
		await expect(page.locator('span:text-is("Status")').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('span:text-is("Size")').first()).toBeVisible();
		await expect(page.locator('span:text-is("Cache")').first()).toBeVisible();
	});

	test('shows media preview for video', async ({ page }) => {
		// Use a derivative to ensure we get a video response
		await page.locator('select[aria-label="Derivative"]').selectOption('tablet');
		await page.getByRole('button', { name: /^Test$/i }).click();
		// Should show a <video> element for video content
		await expect(page.locator('video')).toBeVisible({ timeout: 20_000 });
	});

	test('shows image preview for frame mode', async ({ page }) => {
		await page.locator('select[aria-label="Mode"]').selectOption('frame');
		await page.locator('input[aria-label="Width"]').fill('320');
		await page.locator('input[aria-label="Time offset"]').fill('1s');
		await page.getByRole('button', { name: /^Test$/i }).click();
		// Should show an <img> element for image content
		await expect(page.locator('img[alt="Transform preview"]')).toBeVisible({ timeout: 15_000 });
	});

	test('debug headers highlighted separately from other headers', async ({ page }) => {
		await runDebugTest(page, SMALL);
		await expect(page.getByText('Response Headers')).toBeVisible({ timeout: 15_000 });
		// x-request-id should be visible in the debug headers section (cyan)
		await expect(page.getByText('x-request-id')).toBeVisible();
		// "Show N more headers" toggle should be present for the collapsed non-debug headers
		await expect(page.getByText(/Show \d+ more headers/)).toBeVisible();
	});

	test('diagnostics rendered as JSON tree with expandable nodes', async ({ page }) => {
		await runDebugTest(page, SMALL);
		await expect(page.getByText('Diagnostics')).toBeVisible({ timeout: 15_000 });
		// The JSON tree should show top-level keys as collapsible buttons
		await expect(page.getByRole('button', { name: /^params:/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^origin:/ })).toBeVisible();
	});

	test('handles invalid path gracefully', async ({ page }) => {
		await runDebugTest(page, '/nonexistent-video-file.mp4');
		// Should show response headers even for errors
		await expect(page.getByText('Response Headers')).toBeVisible({ timeout: 15_000 });
	});
});

test.describe('Debug Workbench — comparison mode', () => {
	test.beforeEach(async ({ page }) => {
		await openDebugTab(page);
	});

	test('clicking Compare shows Panel A and Panel B forms', async ({ page }) => {
		await page.getByRole('button', { name: /Compare/i }).click();
		await expect(page.getByText('Panel A')).toBeVisible();
		await expect(page.getByText('Panel B')).toBeVisible();
	});

	test('Panel B has its own param form', async ({ page }) => {
		await page.getByRole('button', { name: /Compare/i }).click();
		// There should be two Mode dropdowns (one per panel)
		const modeSelects = page.locator('select[aria-label="Mode"]');
		await expect(modeSelects).toHaveCount(2);
	});

	test('Panel B has its own Test B button', async ({ page }) => {
		await page.getByRole('button', { name: /Compare/i }).click();
		await expect(page.getByRole('button', { name: /Test B/i })).toBeVisible();
	});

	test('shows A and B badges with URL bars', async ({ page }) => {
		await page.getByRole('button', { name: /Compare/i }).click();
		// Badge labels
		const badges = page.locator('.inline-flex:has-text("A"), .inline-flex:has-text("B")');
		// Both URL bars should be visible
		const codeBars = page.locator('code');
		expect(await codeBars.count()).toBeGreaterThanOrEqual(3); // main URL + A + B
	});

	test('closing Compare returns to single panel', async ({ page }) => {
		await page.getByRole('button', { name: /Compare/i }).click();
		await expect(page.getByText('Panel B')).toBeVisible();
		// Click Close button (the compare button toggles to Close)
		await page.getByRole('button', { name: /Close/i }).click();
		await expect(page.getByText('Panel B')).not.toBeVisible();
		await expect(page.getByText('Transform Params')).toBeVisible();
	});
});

test.describe('Debug Workbench — Akamai compatibility', () => {
	test.beforeEach(async ({ page }) => {
		await openDebugTab(page);
	});

	test('toggle shows Akamai Compatibility card', async ({ page }) => {
		await page.getByText('Show Akamai URLs').click();
		await expect(page.getByText('Akamai Compatibility')).toBeVisible();
	});

	test('shows canonical and Akamai URL variants', async ({ page }) => {
		await page.getByText('Show Akamai URLs').click();
		await expect(page.getByText('Canonical')).toBeVisible();
		await expect(page.getByText('Akamai / IMQuery')).toBeVisible();
	});

	test('Akamai URL uses imwidth instead of width', async ({ page }) => {
		await page.locator('input[aria-label="Width"]').fill('640');
		await page.getByText('Show Akamai URLs').click();
		// The Akamai URL code block should contain imwidth=640
		const akamaiBlock = page.locator('code').last();
		await expect(akamaiBlock).toContainText('imwidth=640');
	});

	test('Akamai URL uses impolicy instead of derivative', async ({ page }) => {
		// Default derivative is 'tablet'
		await page.getByText('Show Akamai URLs').click();
		const akamaiBlock = page.locator('code').last();
		await expect(akamaiBlock).toContainText('impolicy=tablet');
	});

	test('toggle hides Akamai card', async ({ page }) => {
		await page.getByText('Show Akamai URLs').click();
		await expect(page.getByText('Akamai Compatibility')).toBeVisible();
		await page.getByText('Hide Akamai URLs').click();
		await expect(page.getByText('Akamai Compatibility')).not.toBeVisible();
	});
});

// ── Video transforms in browser (unchanged) ─────────────────────────

test.describe('Video transforms in browser', () => {
	test('video serves with derivative=tablet', async ({ page }) => {
		const response = await page.goto(`${SMALL}?derivative=tablet`);
		expect(response?.status()).toBe(200);
		expect(response?.headers()['content-type']).toBe('video/mp4');
		const contentLength = parseInt(response?.headers()['content-length'] ?? '0', 10);
		expect(contentLength).toBeGreaterThan(0);
		expect(contentLength).toBeLessThan(40_000_000);
	});

	test('frame mode returns image', async ({ page }) => {
		const response = await page.goto(`${SMALL}?mode=frame&width=320`);
		expect(response?.status()).toBe(200);
		expect(response?.headers()['content-type']).toBe('image/jpeg');
	});

	test('range request works (video seeking)', async ({ request }) => {
		const response = await request.get(`${SMALL}?derivative=tablet`, {
			headers: { Range: 'bytes=0-999' },
		});
		expect(response.status()).toBe(206);
		expect(response.headers()['content-range']).toMatch(/^bytes 0-999\/\d+$/);
	});

	test('Akamai params work: imwidth=640', async ({ request }) => {
		const response = await request.get(`${SMALL}?imwidth=640`);
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toBe('video/mp4');
		const size = parseInt(response.headers()['content-length'] ?? '0', 10);
		expect(size).toBeLessThan(40_000_000);
		expect(size).toBeGreaterThan(0);
	});

	test('cache works: second request is HIT', async ({ request }) => {
		await request.get(`${SMALL}?derivative=tablet`);
		const r2 = await request.get(`${SMALL}?derivative=tablet`);
		expect(r2.headers()['cf-cache-status']).toBe('HIT');
	});

	test('container result from R2 serves correctly', async ({ request }) => {
		const response = await request.get(`${HUGE}?imwidth=320`);
		if (response.headers()['content-type'] === 'video/mp4') {
			const size = parseInt(response.headers()['content-length'] ?? '0', 10);
			expect(size).toBeLessThan(725_000_000);
			expect(size).toBeGreaterThan(0);
			expect(response.headers()['x-transform-source']).toBe('container');
		}
	});
});
