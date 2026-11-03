// Bosch / myAlarm iFob panel — types & configuration.
//
// Reverse-engineered from the `au.com.myalarm.ifob_control` Android app (v2.315).
// See README.md in this folder for the protocol writeup and the list of
// fields that still need live verification against a real panel.

/** The four details a site is given at provisioning. */
export interface SiteCredentials {
	/** Panel serial number, e.g. "123456". Padded to 8 digits internally. */
	serialNumber: string;
	/** Panel app code, e.g. "000000". Authenticates the login handshake. */
	appCode: string;
	/** Device ID / slot on the panel, e.g. 3. */
	deviceId: number;
	/** Friendly label only. */
	deviceName?: string;
	/**
	 * Optional user keypad PIN (USER_PASS_CODE). Only required by sites that have
	 * "always require PIN" enabled; mixed into command headers when present.
	 */
	userPin?: string;
}

/** Where to reach the panel. */
export interface PanelEndpoint {
	/**
	 * Host: a direct panel IP (LAN or port-forwarded), or a cloud relay:
	 *   AU: ap.myalarms1.com (fallback ap.myalarms2.com / 52.64.17.54)
	 *   EU: eu.myalarms1.com (fallback eu.myalarms2.com / 52.57.152.40)
	 */
	host: string;
	/** Panel UDP port. Default 9050. */
	port?: number;
	/** Local UDP port to bind. Default 0 (ephemeral). App uses 9050/9052. */
	localPort?: number;
	/** Per-request timeout in ms. Default 5000. */
	timeoutMs?: number;
}

export type Region = 'AU_PROD' | 'EU_PROD' | 'TEST';

export const RELAYS: Record<Region, { primary: string; secondary: string; fallbackIp: string }> = {
	AU_PROD: {
		primary: 'ap.myalarms1.com',
		secondary: 'ap.myalarms2.com',
		fallbackIp: '52.64.17.54'
	},
	EU_PROD: {
		primary: 'eu.myalarms1.com',
		secondary: 'eu.myalarms2.com',
		fallbackIp: '52.57.152.40'
	},
	TEST: { primary: 'ap.myalarms1.com', secondary: 'ap.myalarms2.com', fallbackIp: '52.64.17.54' }
};

/** Result of a command round-trip. */
export interface CommandResult {
	ok: boolean;
	/** Decrypted reply plaintext (after the 6-byte clear prefix), if any. */
	reply?: Buffer;
	error?: string;
}
