// One-time site registration: logs in with BOSCH_APPCODE and saves the session key to
// .bosch-session.json, which the server then reuses for every connection.
//
//   node --env-file=.env scripts/bosch-register.ts --yes
//
// ⚠ The app code is SINGLE-USE: a successful login consumes it (get a fresh one from the panel or
// myAlarm app to register again). Stop the DoorKeeper server first — the panel allows one session
// per device. An existing session file is backed up, not overwritten.
import { copyFileSync, existsSync } from 'node:fs';
import { saveSession, sessionFilePath } from '../src/lib/server/bosch/session-store.ts';
import { boschClient } from './bosch-env.ts';

if (!process.argv.includes('--yes')) {
	console.error(
		'This consumes the one-time BOSCH_APPCODE and replaces the saved session.\n' +
			'Stop the DoorKeeper server, then re-run with --yes to continue.'
	);
	process.exit(1);
}
if (!process.env.BOSCH_APPCODE) {
	console.error('BOSCH_APPCODE is not set');
	process.exit(1);
}

const file = sessionFilePath();
if (existsSync(file)) {
	const backup = `${file}.${Date.now()}.bak`;
	copyFileSync(file, backup);
	console.log(`existing session backed up to ${backup}`);
}

const client = boschClient();
const result = await client.login();
client.close();

if (!result.ok || !client.sessionKeyHex) {
	console.error(`registration failed: ${result.error ?? 'no session key'}`);
	process.exit(1);
}

saveSession({
	serialNumber: process.env.BOSCH_SERIAL ?? '',
	deviceId: Number(process.env.BOSCH_DEVICEID),
	sessionKeyHex: client.sessionKeyHex,
	feature: client.featureByte,
	savedAt: new Date().toISOString()
});
console.log(`registered — session saved to ${file}. The app code is now used up.`);
