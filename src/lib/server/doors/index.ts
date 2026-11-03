// Picks the door backend from DOOR_PROVIDER (default: inner-range, the original behaviour).
// Each provider is imported lazily, so an Inner Range deployment never loads the Bosch UDP code.
import { env } from '$env/dynamic/private';
import type { DoorProvider, ProviderKind } from './types';

export type * from './types';

let provider: Promise<DoorProvider> | null = null;

export function selectedProviderKind(): ProviderKind {
	const kind = (env.DOOR_PROVIDER || 'inner-range').trim().toLowerCase();
	if (kind !== 'inner-range' && kind !== 'bosch') {
		throw new Error(`Unknown DOOR_PROVIDER "${env.DOOR_PROVIDER}" (use inner-range or bosch)`);
	}
	return kind;
}

async function create(): Promise<DoorProvider> {
	if (selectedProviderKind() === 'bosch') {
		const { createBoschProvider } = await import('./bosch');
		return createBoschProvider();
	}
	const { createInnerRangeProvider } = await import('./inner-range');
	return createInnerRangeProvider();
}

/** The configured provider, created once per server process. */
export function getDoorProvider(): Promise<DoorProvider> {
	if (!provider) {
		provider = create().catch((e) => {
			provider = null; // let a fixed config be picked up without a restart
			throw e;
		});
	}
	return provider;
}
