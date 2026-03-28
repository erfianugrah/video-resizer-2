import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'test/e2e-browser',
	timeout: 60_000,
	retries: 0,
	use: {
		baseURL: 'https://videos.erfi.io',
		headless: true,
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' },
		},
	],
});
