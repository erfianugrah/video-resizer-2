import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'test/e2e-browser',
	timeout: 60_000,
	retries: 0,
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
