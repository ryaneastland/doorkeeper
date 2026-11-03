// Inner Range Inception (SkyCommand) over its cloud REST API. Stateless apart from a cached
// login token, so it runs fine on serverless hosts (Netlify) — the original DoorKeeper setup.
import { env } from '$env/dynamic/private';
import { DOOR_GUIDS } from '$lib/common/constants';
import { apiRoot, authenticate, getToken } from '$lib/services/inceptionAuthService';
import { parseDoors } from './config';
import type { Door, DoorProvider, OpenResult } from './types';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The original hard-coded doors, used when DOORS isn't set so existing deployments don't change. */
const DEFAULT_DOORS: Door[] = [
	{
		id: DOOR_GUIDS.BA_FILLING_ROOM,
		name: 'BA Filling Room',
		target: DOOR_GUIDS.BA_FILLING_ROOM,
		icon: 'door'
	},
	{
		id: DOOR_GUIDS.PPC_ROLLER_DOOR,
		name: 'PPC Roller Door',
		target: DOOR_GUIDS.PPC_ROLLER_DOOR,
		icon: 'roller'
	},
	{
		id: DOOR_GUIDS.MEETING_ROOM_DOOR,
		name: 'Meeting Room',
		target: DOOR_GUIDS.MEETING_ROOM_DOOR,
		icon: 'door'
	}
];

async function controlDoor(guid: string, token: string) {
	const response = await fetch(`${apiRoot()}/control/door/${guid}/activity`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Cookie: `LoginSessId=${token}`
		},
		body: JSON.stringify({ Type: 'ControlDoor', DoorControlType: 'Open', Entity: guid })
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('Failed to control the door:', response.status, response.statusText, errorText);
		throw new Error(`Failed to control the door: ${response.statusText}`);
	}

	return response.json();
}

export function createInnerRangeProvider(): DoorProvider {
	const doors = env.DOORS
		? parseDoors(env.DOORS, (t) => typeof t === 'string' && GUID.test(t))
		: DEFAULT_DOORS;

	return {
		kind: 'inner-range',
		capabilities: { status: false, arm: false, autoRelock: false },
		doors,
		async open(door: Door): Promise<OpenResult> {
			try {
				const token = getToken() ?? (await authenticate());
				if (!token) {
					return { ok: false, error: 'Failed to obtain authentication token' };
				}
				await controlDoor(String(door.target), token);
				return { ok: true };
			} catch (error) {
				console.error('Error in controlDoor:', error);
				return { ok: false, error: (error as Error).message };
			}
		}
	};
}
