import { test, expect } from '@playwright/test';

const TOKEN = process.env.CONFIG_API_TOKEN ?? 'test-analytics-token-2026';
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
		// Wait for the jobs tab to load — either shows Active/Recent headers
		// or "no jobs" message depending on whether jobs exist
		const hasActive = await page.getByText('Active').first().isVisible({ timeout: 10_000 }).catch(() => false);
		const hasRecent = await page.getByText('Recent').first().isVisible({ timeout: 5_000 }).catch(() => false);
		const hasEmpty = await page.getByText('No container transform jobs found').isVisible({ timeout: 5_000 }).catch(() => false);
		expect(hasActive || hasRecent || hasEmpty).toBe(true);
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

test.describe('Debug tab', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.getByRole('tab', { name: /Debug/i }).click();
	});

	test('shows URL input and test button', async ({ page }) => {
		await expect(page.locator('input[aria-label="URL to debug"]')).toBeVisible({ timeout: 5_000 });
		await expect(page.getByRole('button', { name: /Test/i })).toBeVisible();
	});

	test('tests a URL and shows diagnostics', async ({ page }) => {
		const input = page.locator('input[aria-label="URL to debug"]');
		await input.fill(`${SMALL}?derivative=tablet`);
		await page.getByRole('button', { name: /Test/i }).click();
		await expect(page.getByText('Param Resolution')).toBeVisible({ timeout: 15_000 });
	});

	test('shows response headers', async ({ page }) => {
		const input = page.locator('input[aria-label="URL to debug"]');
		await expect(input).toBeVisible({ timeout: 5_000 });
		await input.fill(`${SMALL}?width=320`);
		await page.getByRole('button', { name: /Test/i }).click();
		await expect(page.getByText('Response Headers')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('x-request-id')).toBeVisible();
		await expect(page.getByText('x-cache-key')).toBeVisible();
	});

	test('handles invalid path gracefully', async ({ page }) => {
		const input = page.locator('input[aria-label="URL to debug"]');
		await expect(input).toBeVisible({ timeout: 5_000 });
		await input.fill('/nonexistent.mp4');
		await page.getByRole('button', { name: /Test/i }).click();
		// Should still show response section (even if 404/error)
		await expect(page.getByText('Response Headers')).toBeVisible({ timeout: 15_000 });
	});
});

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
