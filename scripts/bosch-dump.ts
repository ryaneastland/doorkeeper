// Inspect exactly what the Bosch client would send — no transmission.
//
//   node --env-file=.env scripts/bosch-dump.ts
//   node --env-file=.env scripts/bosch-dump.ts ap.myalarms1.com   # also live-login
//
// Credentials come from BOSCH_SERIAL / BOSCH_APPCODE / BOSCH_DEVICEID (never hard-code them: this
// repo is public). Node 24 runs .ts directly (type stripping). Passing a host switches from a
// dry-run byte dump to an actual login attempt, which CONSUMES the one-time app code.

import { BoschClient } from '../src/lib/server/bosch/client.ts';

const serialNumber = process.env.BOSCH_SERIAL;
const appCode = process.env.BOSCH_APPCODE;
const deviceId = Number(process.env.BOSCH_DEVICEID);
const host = process.argv[2];
if (!serialNumber || !appCode || !deviceId) {
	console.error('set BOSCH_SERIAL, BOSCH_APPCODE and BOSCH_DEVICEID (node --env-file=.env ...)');
	process.exit(1);
}

const client = new BoschClient({
	endpoint: { host: host ?? '0.0.0.0' },
	credentials: { serialNumber, appCode, deviceId },
	dryRun: !host,
	log: (dir, msg) => console.log(`[${dir}] ${msg}`)
});

const dumped = client.dump();
console.log('\n--- packet bytes (hex) ---');
console.log('login       :', dumped.login);
console.log('disarm area1:', dumped.disarmArea1);

if (host) {
	console.log(`\n--- attempting live login to ${host}:9050 ---`);
	client
		.login()
		.then((r) => console.log('login result:', r.ok, r.error ?? '', r.reply?.toString('hex') ?? ''))
		.catch((e) => console.error('login error:', e));
}
