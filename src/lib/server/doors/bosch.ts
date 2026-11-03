// Bosch Solution panels via the myAlarm cloud relay (UDP 9050). Holds ONE long-lived session to
// the panel (see $lib/server/bosch/manager), so it needs a persistent Node server (adapter-node);
// it cannot run on serverless hosts. See docs/BOSCH-INTEGRATION.md.
import { env } from '$env/dynamic/private';
import { bosch } from '$lib/server/bosch/manager';
import { parseDoors } from './config';
import type { ArmResult, Door, DoorProvider, OpenResult, SiteStatus } from './types';

/** Area states that need no disarm before a door can open. */
const DISARMED_STATES = ['DISARMED', 'NOT_USED', 'OFF_LINE'];
/** Area states that can't be armed. */
const UNARMABLE_STATES = ['NOT_USED', 'OFF_LINE'];

const doorNumber = (door: Door) => Number(door.target);

/** Disarm ALL armed areas, then pulse the door (the panel re-locks it by itself, ~8 s). */
async function openDoor(door: Door): Promise<OpenResult> {
	try {
		return await bosch.run<OpenResult>(async (client) => {
			// If we can't read the areas, don't open the door: unlocking into an armed site trips
			// the alarm.
			const states = await client.getAreaStates(16);
			if (!states.length) {
				return { ok: false, error: 'could not read area states from the panel' };
			}
			const armed = states.filter((s) => !DISARMED_STATES.includes(s.state));
			let disarmedCount = 0;
			for (const a of armed) {
				const d = await client.disarmArea(a.index);
				if (!d.ok) {
					return { ok: false, error: `disarm of area ${a.index} failed: ${d.error}` };
				}
				disarmedCount++;
			}
			if (armed.length) {
				// a reply only means the panel heard us, so confirm it actually disarmed
				const after = await client.getAreaStates(16);
				const still = after.filter(
					(s) => armed.some((a) => a.index === s.index) && !DISARMED_STATES.includes(s.state)
				);
				if (!after.length || still.length) {
					return {
						ok: false,
						error: still.length
							? `area ${still.map((s) => s.index).join(', ')} still armed after disarm`
							: 'could not confirm disarm',
						disarmedCount
					};
				}
			}
			console.log(
				`[bosch] open ${door.name}: disarmed ${disarmedCount} area(s) ` +
					`[${armed.map((a) => `${a.index}:${a.state}`).join(', ')}]`
			);

			const op = await client.operateDoor(doorNumber(door));
			if (!op.ok) {
				return { ok: false, error: `operate failed: ${op.error}`, disarmedCount };
			}
			// confirm via the lock state (capture: unlocked ~1 s after the pulse, re-locked by ~9 s)
			const doorState = await client.getDoorState(doorNumber(door));
			const unlocked = doorState ? !doorState.locked : false;
			return {
				ok: unlocked,
				error: unlocked
					? undefined
					: doorState
						? 'panel still reports door locked'
						: 'could not read door state',
				disarmedCount
			};
		});
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

/** Arm all usable areas (all-on). The panel refuses if a zone isn't ready. */
async function armSite(): Promise<ArmResult> {
	try {
		return await bosch.run(async (client) => {
			const states = await client.getAreaStates(16);
			const results: { area: number; ok: boolean; error?: string }[] = [];
			for (const s of states) {
				if (UNARMABLE_STATES.includes(s.state)) continue;
				const r = await client.armArea(s.index);
				results.push({ area: s.index, ok: r.ok, error: r.error });
			}
			const failed = results.filter((r) => !r.ok);
			if (!results.length) return { ok: false, error: 'no areas to arm' };
			return failed.length
				? { ok: false, error: failed.map((r) => `area ${r.area}: ${r.error}`).join('; ') }
				: { ok: true };
		});
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

// Panel structure (area names) doesn't change — cache it so status reads stay small.
let areaNameCache: string[] | null = null;

/** Read live area and door state (also warms the shared connection when the page opens). */
async function readStatus(doors: Door[]): Promise<SiteStatus> {
	try {
		return await bosch.run(async (client) => {
			if (!areaNameCache) {
				const names = (await client.enumerate(3, 16)).map((a) => a.name);
				// don't cache a failed read, or the page would show no areas until restart
				if (!names.length) throw new Error('could not read area names from the panel');
				areaNameCache = names;
			}
			const states = await client.getAreaStates(areaNameCache.length);
			// a partial read is a failed read: report it rather than showing "?"
			if (states.length < areaNameCache.length) {
				throw new Error('could not read area states from the panel');
			}
			const doorStates: SiteStatus['doors'] = [];
			for (const d of doors) {
				const ds = await client.getDoorState(doorNumber(d));
				doorStates.push({ id: d.id, name: d.name, locked: ds?.locked ?? null });
			}
			return {
				connected: true,
				areas: areaNameCache.map((name, i) => ({ name, state: states[i].state })),
				doors: doorStates
			};
		});
	} catch (e) {
		return { connected: false, areas: [], doors: [], error: (e as Error).message };
	}
}

export function createBoschProvider(): DoorProvider {
	// One long-lived panel session + an in-memory queue: serverless instances would each open
	// their own session and knock each other off the panel.
	if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
		throw new Error(
			'DOOR_PROVIDER=bosch needs a persistent Node server (adapter-node), not serverless hosting'
		);
	}
	if (!env.DOORS) {
		throw new Error(
			'DOOR_PROVIDER=bosch needs DOORS set, e.g. [{"id":"front","name":"Front Door","target":1}]'
		);
	}
	const doors = parseDoors(env.DOORS, (t) => Number.isInteger(t) && (t as number) >= 1);

	return {
		kind: 'bosch',
		capabilities: { status: true, arm: true, autoRelock: true },
		doors,
		open: openDoor,
		arm: armSite,
		status: () => readStatus(doors)
	};
}
