// The contract every door backend implements. The control page and its actions only talk to
// this interface, so a site can switch backends with DOOR_PROVIDER and no code changes.

/** Which icon the control page shows for a door. */
export type DoorIcon = 'door' | 'roller';

export interface Door {
	/** Stable id: posted by the page and stored in entry_logs.door_id. */
	id: string;
	/** Label on the button and in entry_logs.door_name. */
	name: string;
	/** Backend-specific address: an Inception door GUID, or a Bosch panel door number. */
	target: string | number;
	icon: DoorIcon;
}

export interface OpenResult {
	ok: boolean;
	error?: string;
	/** Areas the backend disarmed on the way in (Bosch only). */
	disarmedCount?: number;
}

export interface ArmResult {
	ok: boolean;
	error?: string;
}

export interface SiteStatus {
	connected: boolean;
	areas: { name: string; state: string }[];
	doors: { id: string; name: string; locked: boolean | null }[];
	error?: string;
}

export interface ProviderCapabilities {
	/** Can read live area/door state (drives the status line and lock badges). */
	status: boolean;
	/** Can arm the site (drives the Arm button). */
	arm: boolean;
	/** Re-locks doors by itself after an open, so the page should poll for it. */
	autoRelock: boolean;
}

export interface DoorProvider {
	readonly kind: ProviderKind;
	readonly capabilities: ProviderCapabilities;
	readonly doors: Door[];
	open(door: Door): Promise<OpenResult>;
	status?(): Promise<SiteStatus>;
	arm?(): Promise<ArmResult>;
}

export type ProviderKind = 'inner-range' | 'bosch';
