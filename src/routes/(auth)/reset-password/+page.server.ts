import { redirect, fail, isRedirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { AuthApiError } from '@supabase/supabase-js';
import { failWithAuthError } from '$lib/utils/authErrorHandler';

export const actions = {
	default: async ({ locals: { supabase }, request, url }) => {
		const requestData = await request.formData();
		const email = String(requestData.get('email')).trim();

		// Validate email input
		if (!email) {
			return fail(400, {
				resetPassword: {
					error: 'Please enter your email address',
					values: { email }
				}
			});
		}

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			return fail(400, {
				resetPassword: {
					error: 'Please enter a valid email address',
					values: { email }
				}
			});
		}

		try {
			// Use corporate-safe password reset (sends token in email, not magic link)
			const { error } = await supabase.auth.resetPasswordForEmail(email);

			if (error) {
				return failWithAuthError(
					error, 
					'resetPassword', 
					'Failed to send reset email. Please try again.',
					{ email }
				);
			}

			// Success - redirect to confirmation page
			redirect(303, '/email-confirm');
		} catch (error) {
			// redirect() works by throwing; let the success redirect through
			if (isRedirect(error)) throw error;
			return failWithAuthError(
				error, 
				'resetPassword', 
				'Server error. Please check your connection and try again.',
				{ email },
				500
			);
		}
	}
} satisfies Actions;
