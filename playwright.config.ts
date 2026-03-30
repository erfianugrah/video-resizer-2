/**
 * Playwright browser tests run against the deployed site.
 *
 * wrangler dev --remote doesn't support the ASSETS binding (static dashboard
 * files), so a local dev server can't serve the dashboard. Deploy first:
 *   npm run deploy && CONFIG_API_TOKEN=xxx npm run test:browser
 *
 * Override the target with TEST_BASE_URL if needed.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'test/e2e-browser',
	timeout: 60_000,
	retries: 1,
	use: {
		baseURL: process.env.TEST_BASE_URL ?? 'https://videos.erfi.io',
		headless: true,
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' },
		},
	],
});
