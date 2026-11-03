import type { Door, DoorIcon } from './types';

/**
 * Parses the DOORS env var: a JSON array, one entry per door, e.g.
 *   DOORS=[{"id":"front","name":"Front Door","target":1,"icon":"door"}]
 * `target` is whatever the provider needs (Inception GUID, Bosch door number); `icon` is optional.
 * Throws with the offending entry so a typo fails loudly at startup instead of hiding a door.
 */
export function parseDoors(raw: string, validateTarget: (target: unknown) => boolean): Door[] {
	let list: unknown;
	try {
		list = JSON.parse(raw);
	} catch (e) {
		throw new Error(`Invalid DOORS: not valid JSON (${(e as Error).message})`);
	}
	if (!Array.isArray(list)) {
		throw new Error('Invalid DOORS: must be a JSON array');
	}

	const seen = new Set<string>();
	return list.map((entry, i) => {
		const d = (entry ?? {}) as Record<string, unknown>;
		if (typeof d.id !== 'string' || !d.id || typeof d.name !== 'string' || !d.name) {
			throw new Error(`Invalid DOORS: entry ${i} needs a string id and name`);
		}
		if (!validateTarget(d.target)) {
			throw new Error(`Invalid DOORS: entry ${i} (${d.id}) has an invalid target`);
		}
		if (seen.has(d.id)) {
			throw new Error(`Invalid DOORS: duplicate id ${d.id}`);
		}
		seen.add(d.id);
		const icon: DoorIcon = d.icon === 'roller' ? 'roller' : 'door';
		return { id: d.id, name: d.name, target: d.target as string | number, icon };
	});
}
