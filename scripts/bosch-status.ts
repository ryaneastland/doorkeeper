// Read-only check using the saved session: reconnects (no app-code burn) and prints area and
// door state. Changes nothing on the panel.
//
//   node --env-file=.env scripts/bosch-status.ts [--verbose]
//
// Stop the DoorKeeper server first — the panel allows one session per device, so this would
// knock the server's session off (it reconnects on its next request).
import { loadSession } from '../src/lib/server/bosch/session-store.ts';
import { boschClient } from './bosch-env.ts';

const saved = loadSession();
if (!saved?.sessionKeyHex) {
	console.error('no saved session — run scripts/bosch-register.ts first');
	process.exit(1);
}

const client = boschClient();
client.restore(saved.sessionKeyHex, saved.feature);
try {
	const conn = await client.connect();
	console.log('connect:', conn.ok ? 'ok' : `FAILED (${conn.error})`);
	if (!conn.ok) process.exit(1);

	const names = await client.enumerate(3, 16);
	const states = await client.getAreaStates(names.length);
	for (const [i, a] of names.entries()) {
		console.log(`area ${i + 1} ${a.name}: ${states[i]?.state ?? 'unreadable'}`);
	}

	const doors = process.env.DOORS ? (JSON.parse(process.env.DOORS) as { name: string; target: number }[]) : [];
	for (const d of doors) {
		const ds = await client.getDoorState(Number(d.target));
		console.log(`door ${d.target} ${d.name}: ${ds ? (ds.locked ? 'locked' : 'unlocked') : 'unreadable'}`);
	}
} finally {
	client.close();
}
