import { env } from '$env/dynamic/private';

// Read at runtime (not $env/static) so builds for other door providers don't need these set.

let token: string | null = null;
let lastRequestTime: number | null = null;

/** Inception API root, e.g. https://skytunnel.com.au/inception/<serial>/api/v1 */
function apiRoot(): string {
	const base = env.PRIVATE_INCEPTION_BASE_URL;
	if (!base) {
		throw new Error('PRIVATE_INCEPTION_BASE_URL is not set');
	}
	return `${base.replace(/\/+$/, '')}/api/v1`;
}

async function authenticate() {
	// Same base URL as door control, so login and control can't point at different sites.
	const response = await fetch(`${apiRoot()}/authentication/login`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			Username: env.PRIVATE_INCEPTION_USERNAME,
			Password: env.PRIVATE_INCEPTION_PASSWORD
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('Failed to authenticate:', response.status, response.statusText, errorText);
		throw new Error('Failed to authenticate');
	}

	const data = await response.json();
	token = data.UserID;
	lastRequestTime = Date.now();

	return token;
}

function getToken(): string | null {
	if (token && lastRequestTime && Date.now() - lastRequestTime <= 10 * 60 * 1000) {
		return token;
	}
	return null;
}

export { apiRoot, authenticate, getToken };
