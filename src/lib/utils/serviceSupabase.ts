// src/lib/utils/serviceSupabase.ts
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
// Server-only: a PUBLIC_ var would be inlined into client bundles and leak full DB access.
import { PRIVATE_SUPABASE_SERVICE_KEY } from '$env/static/private';

// Create service role client for admin operations (bypasses RLS)
export const serviceSupabase = createClient(PUBLIC_SUPABASE_URL, PRIVATE_SUPABASE_SERVICE_KEY, {
	auth: {
		autoRefreshToken: false,
		persistSession: false
	}
});
