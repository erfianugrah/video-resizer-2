// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				'@': path.resolve(__dirname, './src'),
			},
		},
	},
	output: 'static',
	build: {
		// Output to dist/ for the Worker's ASSETS binding
		format: 'directory',
	},
	// No base path — the Worker rewrites /admin/dashboard/* to / for ASSETS
});
