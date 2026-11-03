import { redirect, fail, isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { AuthApiError } from '@supabase/supabase-js';
import { failWithAuthError } from '$lib/utils/authErrorHandler';

export const load = (async ({ locals: { getSession } }) => {
	const session = await getSession();
	if (!session) {
		redirect(302, '/login');
	}
	return {};
}) satisfies PageServerLoad;

function validatePassword(password: string): { isValid: boolean; errors: string[] } {
	const errors: string[] = [];

	// Check minimum length
	if (password.length < 8) {
		errors.push('Password must be at least 8 characters long');
	}

	// Check for at least one uppercase letter
	if (!/[A-Z]/.test(password)) {
		errors.push('Password must contain at least one uppercase letter');
	}

	// Check for at least one lowercase letter
	if (!/[a-z]/.test(password)) {
		errors.push('Password must contain at least one lowercase letter');
	}

	// Check for at least one number
	if (!/\d/.test(password)) {
		errors.push('Password must contain at least one number');
	}

	// Check for at least one special character
	if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
		errors.push('Password must contain at least one special character');
	}

	return {
		isValid: errors.length === 0,
		errors
	};
}

export const actions = {
	default: async ({ locals: { supabase }, request }) => {
		const requestData = await request.formData();

		const password = String(requestData.get('password')).trim();
		const confirmPassword = String(requestData.get('confirm-password')).trim();

		// Check if passwords are provided
		if (!password) {
			return fail(400, {
				updatePassword: {
					error: 'Please enter a password',
					values: { password: '', confirmPassword: '' }
				}
			});
		}

		if (!confirmPassword) {
			return fail(400, {
				updatePassword: {
					error: 'Please confirm your password',
					values: { password: '', confirmPassword: '' }
				}
			});
		}

		// Check if passwords match
		if (password !== confirmPassword) {
			return fail(400, {
				updatePassword: {
					error: 'Passwords do not match',
					values: { password: '', confirmPassword: '' }
				}
			});
		}

		// Validate password strength
		const validation = validatePassword(password);
		if (!validation.isValid) {
			return fail(400, {
				updatePassword: {
					error: validation.errors.join('. '),
					values: { password: '', confirmPassword: '' }
				}
			});
		}

		try {
			const { error } = await supabase.auth.updateUser({ password });

			if (error) {
				return failWithAuthError(
					error, 
					'updatePassword', 
					'Failed to update password. Please try again.',
					{ password: '', confirmPassword: '' }
				);
			}

			// Success - redirect to control panel
			redirect(303, '/control');
		} catch (error) {
			// redirect() works by throwing; let the success redirect through
			if (isRedirect(error)) throw error;
			return failWithAuthError(
				error, 
				'updatePassword', 
				'Server error. Please try again.',
				{ password: '', confirmPassword: '' },
				500
			);
		}
	}
} satisfies Actions;
