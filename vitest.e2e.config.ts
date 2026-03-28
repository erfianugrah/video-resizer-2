import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/e2e/**/*.spec.ts'],
		testTimeout: 60_000,
		hookTimeout: 30_000,
	},
});
