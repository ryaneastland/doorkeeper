import { fail, redirect, isRedirect, type ActionFailure } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { Actions } from './$types';
import { AuthApiError } from '@supabase/supabase-js';
import { failWithAuthError } from '$lib/utils/authErrorHandler';

export const load = (async () => {
	return {};
}) satisfies PageServerLoad;

export const actions = {
	// Password-based login (existing)
	login: async ({ request, locals: { supabase } }) => {
		const result = await getEmailandPassword(request);
		if (isTypeAuthRequestData(result)) {
			const { email, password } = result;
			try {
				const { data, error } = await supabase.auth.signInWithPassword({ email, password });
				if (error) {
					throw error;
				}

				// Ensure session is established before redirect
				if (data.session) {
					throw redirect(303, '/control');
				} else {
					throw new Error('No session created');
				}
			} catch (error) {
				// redirect() works by throwing; let the success redirect through
				if (isRedirect(error)) throw error;
				return failWithAuthError(
					error,
					'signinWithPassword',
					'Login failed. Please check your credentials or try again later.',
					{ email }
				);
			}
		}
	},

	// Test action to verify routing works
	test: async ({ request }) => {
		console.log('TEST ACTION CALLED!');
		return fail(400, {
			sendOtp: {
				error: 'Test action working!',
				values: { email: 'test' }
			}
		});
	},

	// Corporate-email friendly OTP - sends numeric code only
	sendOtp: async ({ request, locals: { supabase }, url }) => {
		console.log('sendOtp action called'); // Debug log

		const data = await request.formData();
		const email = String(data.get('email')).trim();
		console.log('Email received:', email); // Debug log

		if (!email) {
			console.log('No email provided'); // Debug log
			return fail(400, {
				sendOtp: {
					error: 'Please enter your email address',
					values: { email }
				}
			});
		}

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			console.log('Invalid email format'); // Debug log
			return fail(400, {
				sendOtp: {
					error: 'Please enter a valid email address',
					values: { email }
				}
			});
		}

		try {
			// Send OTP using Supabase's built-in system
			const { error: emailError } = await supabase.auth.signInWithOtp({
				email,
				options: {
					shouldCreateUser: false
				}
			});

			if (emailError) {
				console.log('Email error:', emailError); // Debug log
				return failWithAuthError(
					emailError,
					'sendOtp',
					'Failed to send login code. Please try again.',
					{ email }
				);
			}

			console.log('OTP sent successfully'); // Debug log
		} catch (error) {
			console.error('Unexpected error in sendOtp:', error); // Debug log
			return failWithAuthError(
				error,
				'sendOtp',
				'Server error. Please check your connection and try again.',
				{ email: '' },
				500
			);
		}

		// Success - redirect to dedicated OTP verification page (outside try/catch)
		throw redirect(303, `/verify-otp?email=${encodeURIComponent(email)}`);
	}
} satisfies Actions;

type AuthRequestData = {
	email: string;
	password: string;
};

async function getEmailandPassword(
	request: Request
): Promise<ActionFailure<{ error: string }> | AuthRequestData> {
	const data = await request.formData();
	const email = data.get('email') as string;
	const password = data.get('password') as string;
	if (!email) {
		return fail(400, {
			error: 'Please enter your email'
		});
	}
	if (!password) {
		return fail(400, {
			error: 'Please enter a password',
			values: {
				email
			}
		});
	}
	return { email, password };
}

function isTypeAuthRequestData<T>(data: T): data is T & AuthRequestData {
	return (
		typeof data == 'object' &&
		data != null &&
		'email' in data &&
		'password' in data &&
		typeof data.email == 'string' &&
		typeof data.password == 'string'
	);
}
