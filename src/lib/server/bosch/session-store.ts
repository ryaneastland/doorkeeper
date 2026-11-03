// Persist the negotiated Bosch session so we register ONCE and reuse it.
//
// The Panel App Code is a one-time registration code: completing the login
// handshake (stage 2) consumes it and the panel issues a new one. So we must
// register a single time, save the resulting 16-byte session key, and reuse it
// for all future status/commands WITHOUT logging in again.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SavedSession {
	serialNumber: string;
	deviceId: number;
	/** 16-byte session key (C), hex. Reused for all subsequent commands. */
	sessionKeyHex: string;
	/** feature byte negotiated at login. */
	feature: number;
	savedAt: string;
}

const FILE = resolve(process.cwd(), '.bosch-session.json');

export function loadSession(): SavedSession | null {
	try {
		if (!existsSync(FILE)) return null;
		return JSON.parse(readFileSync(FILE, 'utf8')) as SavedSession;
	} catch {
		return null;
	}
}

export function saveSession(s: SavedSession): void {
	writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
}

export function clearSession(): void {
	try {
		if (existsSync(FILE)) writeFileSync(FILE, '', 'utf8');
	} catch {
		/* ignore */
	}
}

export function sessionFilePath(): string {
	return FILE;
}
