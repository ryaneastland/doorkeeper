import { fail, redirect } from '@sveltejs/kit';
import type { Session } from '@supabase/supabase-js';
import {
	GEOFENCE_DISABLED,
	MAX_LOCATION_ACCURACY_METRES,
	MAX_PLAUSIBLE_SPEED_MPS,
	MIN_JUMP_DISTANCE_METRES,
	SITE_MAX_DISTANCE_METRES,
	SITE_NAME,
	calculateDistance
} from '$lib/common/geo';
import { getDoorProvider } from '$lib/server/doors';
import { supabase } from '$lib/supabaseClient';
import { PUBLIC_SITE_LATITUDE, PUBLIC_SITE_LONGITUDE } from '$env/static/public';
import type { Actions, PageServerLoad } from './$types';

export const load = (async ({ locals: { getSession } }) => {
	const session = await getSession();
	if (!session) {
		redirect(302, '/login');
	}

	const provider = await getDoorProvider();
	return {
		doors: provider.doors.map(({ id, name, icon }) => ({ id, name, icon, locked: null })),
		capabilities: provider.capabilities
	};
}) satisfies PageServerLoad;

const siteLocation = {
	latitude: Number(PUBLIC_SITE_LATITUDE),
	longitude: Number(PUBLIC_SITE_LONGITUDE)
};

interface PositionReport {
	latitude: number;
	longitude: number;
	at: number;
}

/**
 * The last position each user claimed, kept for the implausible-travel check. Module-level, so it
 * is best-effort only: it is empty after a cold start and is not shared between concurrent
 * serverless instances. Treat a pass here as "not obviously forged", never as proof of presence.
 */
const lastReportedPosition = new Map<string, PositionReport>();

type LocationCheck = { ok: true } | { ok: false; reason: string };

/**
 * Re-runs the proximity check server-side on the coordinates the browser reported. The browser is
 * still the source of those numbers and can lie about them, so this raises the cost of a bypass
 * from "POST to the endpoint" to "deliberately spoof a plausible position" — it is not proof the
 * caller is on site.
 */
function checkReportedLocation(userId: string, formData: FormData): LocationCheck {
	if (GEOFENCE_DISABLED) {
		return { ok: true };
	}

	const latitude = Number(formData.get('latitude'));
	const longitude = Number(formData.get('longitude'));
	const accuracy = Number(formData.get('accuracy'));

	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		return {
			ok: false,
			reason: 'Your location could not be confirmed. Allow location access and try again.'
		};
	}

	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
		return { ok: false, reason: 'The location your device reported is not a valid position.' };
	}

	if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_LOCATION_ACCURACY_METRES) {
		return {
			ok: false,
			reason: `Your location is not accurate enough to confirm you are at ${SITE_NAME}. Move outside and try again.`
		};
	}

	// Record every report, including ones that go on to fail the fence, so that claiming to be
	// far away and then claiming to be on site moments later is visible as a jump.
	const now = Date.now();
	const previous = lastReportedPosition.get(userId);
	lastReportedPosition.set(userId, { latitude, longitude, at: now });

	if (previous) {
		const jump = calculateDistance(previous.latitude, previous.longitude, latitude, longitude);
		const elapsedSeconds = Math.max((now - previous.at) / 1000, 1);
		if (jump > MIN_JUMP_DISTANCE_METRES && jump / elapsedSeconds > MAX_PLAUSIBLE_SPEED_MPS) {
			console.warn(
				`Implausible location change for user ${userId}: ${Math.round(jump)} m in ${Math.round(elapsedSeconds)} s`
			);
			return { ok: false, reason: 'Your reported location changed too quickly to be trusted.' };
		}
	}

	const distance = calculateDistance(
		latitude,
		longitude,
		siteLocation.latitude,
		siteLocation.longitude
	);

	if (distance > SITE_MAX_DISTANCE_METRES) {
		return { ok: false, reason: `You are not within range of ${SITE_NAME}.` };
	}

	return { ok: true };
}

async function logEntry(session: Session, doorId: string, doorName: string, status: boolean) {
	const { error } = await supabase.from('entry_logs').insert({
		user: session.user.id,
		user_email: session.user.email,
		door_name: doorName,
		door_id: doorId,
		status
	});

	if (error) {
		console.error('Error inserting entry log:', error);
	}

	return !error;
}

export const actions = {
	control: async ({ request, locals: { getSession } }) => {
		const session = await getSession();
		if (!session) {
			redirect(302, '/login');
		}

		const formData = await request.formData();
		const provider = await getDoorProvider();
		// Look the door up server-side: never trust a door name or target posted by the client.
		const door = provider.doors.find((d) => d.id === formData.get('doorId'));
		if (!door) {
			return fail(400, { success: false, error: 'Unknown door' });
		}

		const locationCheck = checkReportedLocation(session.user.id, formData);
		if (!locationCheck.ok) {
			console.warn(`Door open denied for ${session.user.email}: ${locationCheck.reason}`);
			await logEntry(session, door.id, door.name, false);
			return fail(403, { success: false, error: locationCheck.reason });
		}

		const result = await provider.open(door);

		if (!result.ok) {
			console.error(`Failed to open ${door.name}:`, result.error);
			await logEntry(session, door.id, door.name, false);
			return fail(502, { success: false, error: result.error ?? 'Failed to open the door' });
		}

		if (!(await logEntry(session, door.id, door.name, true))) {
			return fail(500, { success: false, error: 'Door opened, but the entry could not be logged' });
		}

		return { success: true, disarmedCount: result.disarmedCount ?? 0 };
	},

	arm: async ({ locals: { getSession } }) => {
		const session = await getSession();
		if (!session) {
			redirect(302, '/login');
		}

		const provider = await getDoorProvider();
		if (!provider.arm) {
			return fail(404, { success: false, error: 'This site does not support arming' });
		}

		const result = await provider.arm();
		await logEntry(session, 'arm', 'ARM SITE', result.ok);

		return result.ok
			? { success: true }
			: fail(502, { success: false, error: result.error ?? 'Arm failed (a zone may be open)' });
	}
} satisfies Actions;
