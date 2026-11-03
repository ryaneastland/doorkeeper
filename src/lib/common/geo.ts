// Geo helpers with no browser or server dependencies, so the client and the `control` action
// can run the identical proximity maths. The client copy is UX only — the server copy is the
// one that gates the door.

// Read at runtime ($env/dynamic) so these stay optional: a missing var falls back to a default
// instead of failing the build.
import { env } from '$env/dynamic/public';

/** Falls back when the variable is unset, empty or non-numeric, so a bad value can't widen the fence. */
function metresFromEnv(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How far from the site a reported position may be and still open a door. */
export const SITE_MAX_DISTANCE_METRES = metresFromEnv(env.PUBLIC_SITE_RADIUS_METRES, 300);

/** Reject positions vaguer than this — a 5 km accuracy radius proves nothing. */
export const MAX_LOCATION_ACCURACY_METRES = metresFromEnv(env.PUBLIC_SITE_MAX_ACCURACY_METRES, 100);

/** Shown in location messages and the page heading. */
export const SITE_NAME = env.PUBLIC_SITE_NAME || 'Moorooduc Fire Station';

/**
 * Turns the proximity check off entirely — for local development only. It must be switched off
 * explicitly: unset or unrecognised values keep the geofence on.
 */
export const GEOFENCE_DISABLED = env.PUBLIC_GEOFENCE_DISABLED === 'true';

/** ~200 km/h. Faster than any road approach to the station. */
export const MAX_PLAUSIBLE_SPEED_MPS = 55;

/** Ignore jumps smaller than this when speed-checking, so GPS jitter is not treated as travel. */
export const MIN_JUMP_DISTANCE_METRES = 500;

export interface Coordinates {
	latitude: number;
	longitude: number;
}

/** Great-circle distance between two points, in metres. */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371e3; // Earth's radius in meters
	const φ1 = (lat1 * Math.PI) / 180; // φ, λ in radians
	const φ2 = (lat2 * Math.PI) / 180;
	const Δφ = ((lat2 - lat1) * Math.PI) / 180;
	const Δλ = ((lon2 - lon1) * Math.PI) / 180;

	const a =
		Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
		Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

	return R * c;
}
