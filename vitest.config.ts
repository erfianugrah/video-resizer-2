import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		exclude: ['test/e2e/**', 'test/e2e-browser/**', 'node_modules/**', 'dashboard/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
