import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import type { Actions, PageServerLoad } from './$types';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { PRIVATE_SUPABASE_SERVICE_KEY } from '$env/static/private';
import { supabase } from '$lib/supabaseClient';

const supabaseUrl = PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = PRIVATE_SUPABASE_SERVICE_KEY;

export const load = (async ({ locals: { getSession } }) => {
	const session = await getSession();
	if (!session) {
		redirect(303, '/');
	}
	return {};
}) satisfies PageServerLoad;

export const actions: Actions = {
	default: async ({ request, locals: { getSession } }: RequestEvent) => {
		try {
			const formData = await request.formData();
			const email = formData.get('email') as string;
			const validEmail = /^[\w-.+]+@([\w-]+\.)+[\w-]{2,8}$/.test(email);
			const session = await getSession();

			if (!session) {
				throw redirect(302, '/login');
			}

			if (!validEmail) {
				return fail(400, { errors: { email: 'Please enter a valid email address' }, email });
			}

			if (!supabaseUrl || !supabaseServiceRoleKey) {
				console.error('Supabase URL or Service Role Key not set');
				return fail(500, {
					success: false,
					message: 'Server configuration error. Please contact support.'
				});
			}

			// Create a separate client with the service role key
			const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

			try {
				const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
				if (inviteError) {
					console.error('Error sending invite:', inviteError);
					return fail(400, {
						success: false,
						email,
						message: `There was an issue sending the invite. Please try again.`
					});
				}
			} catch (error) {
				console.error('Error during invite process:', error);
				return fail(500, {
					success: false,
					message: 'An unexpected error occurred during the invite process. Please try again later.'
				});
			}

			try {
				const { error: logError } = await supabase.from('invite_logs').insert({
					invited_address: email,
					invited_by: session.user.id
				});

				if (logError) {
					console.error('Error inserting entry log:', logError);
					return {
						success: true,
						message: `Invite sent successfully to ${email}, but failed to log the invite. Please contact support.`
					};
				}
			} catch (error) {
				console.error('Error during log entry process:', error);
				return {
					success: true,
					message: `Invite sent successfully to ${email}, but an unexpected error occurred while logging the invite. Please contact support.`
				};
			}

			return {
				success: true,
				message: 'Invite sent successfully to ' + email + '.'
			};
		} catch (error) {
			console.error('Unexpected error:', error);
			return fail(500, {
				success: false,
				message: 'An unexpected error occurred. Please try again later.'
			});
		}
	}
};
