import { json, redirect } from '@sveltejs/kit';
import { getDoorProvider } from '$lib/server/doors';
import type { RequestHandler } from './$types';

/** Live panel state, fetched by the control page after it renders (status-capable providers). */
export const GET: RequestHandler = async ({ locals: { getSession } }) => {
	const session = await getSession();
	if (!session) {
		redirect(302, '/login');
	}

	const provider = await getDoorProvider();
	if (!provider.status) {
		return json(
			{ connected: false, areas: [], doors: [], error: 'not supported' },
			{ status: 404 }
		);
	}

	return json(await provider.status());
};
