import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import netlifyAdapter from '@sveltejs/adapter-netlify';
import nodeAdapter from '@sveltejs/adapter-node';
import { loadEnv } from 'vite';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const file = fileURLToPath(new URL('package.json', import.meta.url));
const json = readFileSync(file, 'utf8');
const pkg = JSON.parse(json);

// Pick the deployment target from the door provider (.env or the host's environment):
//  - inner-range (default): stateless REST calls, so it deploys serverless to Netlify as before.
//  - bosch: holds one long-lived UDP session to the panel, so it needs a persistent Node server.
// ADAPTER=node|netlify overrides the choice.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');
const provider = (env.DOOR_PROVIDER || 'inner-range').trim().toLowerCase();
const target = (env.ADAPTER || (provider === 'bosch' ? 'node' : 'netlify')).trim().toLowerCase();
if (provider === 'bosch' && target !== 'node') {
	throw new Error('DOOR_PROVIDER=bosch requires ADAPTER=node (it cannot run serverless)');
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: [vitePreprocess({})],

	kit: {
		// See https://kit.svelte.dev/docs/adapters for more information about adapters.
		adapter: target === 'node' ? nodeAdapter() : netlifyAdapter(),
		version: {
			name: pkg.version
		}
	}
};

export default config;
