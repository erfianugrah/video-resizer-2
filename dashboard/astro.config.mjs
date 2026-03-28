// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
	},
	output: 'static',
	build: {
		// Output to dist/ for the Worker's ASSETS binding
		format: 'directory',
	},
	// No base path — the Worker rewrites /admin/dashboard/* to / for ASSETS
});
