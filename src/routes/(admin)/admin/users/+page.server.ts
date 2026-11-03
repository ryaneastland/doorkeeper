import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import type { Actions, PageServerLoad } from './$types';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { PRIVATE_SUPABASE_SERVICE_KEY } from '$env/static/private';
import { supabase } from '$lib/supabaseClient';

export const load = (async ({ locals: { getSession } }) => {
	const session = await getSession();
	if (!session) {
		throw redirect(303, '/');
	}

	if (!PUBLIC_SUPABASE_URL || !PRIVATE_SUPABASE_SERVICE_KEY) {
		return { users: [], error: 'Supabase configuration missing' };
	}

	const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, PRIVATE_SUPABASE_SERVICE_KEY);

	// Fetch profiles from public schema
	const { data: profiles, error: profilesError } = await supabase
		.from('profiles')
		.select('*')
		.order('email');

	if (profilesError) {
		console.error('Error fetching profiles:', profilesError);
		return { users: [], error: 'Failed to fetch user profiles' };
	}

	// Fetch auth users to get metadata like last_sign_in_at
	const {
		data: { users: authUsers },
		error: authError
	} = await supabaseAdmin.auth.admin.listUsers();

	if (authError) {
		console.error('Error fetching auth users:', authError);
		// Still return profiles even if auth users fail, just without metadata
		return { users: profiles.map((p) => ({ ...p, auth: null })) };
	}

	// Merge profile data with auth metadata
	const mergedUsers = profiles.map((profile) => {
		const authUser = authUsers.find((u) => u.id === profile.id);
		return {
			...profile,
			last_sign_in_at: authUser?.last_sign_in_at,
			created_at: authUser?.created_at,
			invited_at: authUser?.invited_at,
			status: authUser?.last_sign_in_at ? 'joined' : authUser?.invited_at ? 'invited' : 'active'
		};
	});

	return {
		users: mergedUsers
	};
}) satisfies PageServerLoad;

export const actions: Actions = {
	toggleAdmin: async ({ request, locals: { getSession } }) => {
		const session = await getSession();
		if (!session) throw redirect(302, '/login');

		const data = await request.formData();
		const userId = data.get('userId') as string;
		const isAdmin = data.get('isAdmin') === 'true';

		const { error } = await supabase
			.from('profiles')
			.update({ site_admin: !isAdmin })
			.eq('id', userId);

		if (error) {
			console.error('Error toggling admin status:', error);
			return fail(400, { message: 'Failed to update admin status' });
		}

		return { success: true };
	},

	deleteUser: async ({ request, locals: { getSession } }) => {
		const session = await getSession();
		if (!session) throw redirect(302, '/login');

		const data = await request.formData();
		const userId = data.get('userId') as string;

		if (userId === session.user.id) {
			return fail(400, { message: 'You cannot delete yourself' });
		}

		const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, PRIVATE_SUPABASE_SERVICE_KEY);

		// Delete from auth.users (cascade should handle profiles if configured,
		// but we'll do both to be safe or if no cascade exists)
		const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);

		if (authError) {
			console.error('Error deleting auth user:', authError);
			return fail(400, { message: 'Failed to delete user from authentication' });
		}

		// Profile deletion usually happens via cascade, but verifying/doing it manually if needed
		const { error: profileError } = await supabase.from('profiles').delete().eq('id', userId);

		if (profileError) {
			console.error('Error deleting profile:', profileError);
		}

		return { success: true };
	}
} satisfies Actions;
