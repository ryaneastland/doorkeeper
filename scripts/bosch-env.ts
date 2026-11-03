// Shared setup for the Bosch CLI scripts. Credentials come from the environment — never hard-code
// a serial, PIN or app code here; this repo is public. Run scripts with your .env loaded:
//   node --env-file=.env scripts/<script>.ts
import { BoschClient } from '../src/lib/server/bosch/client.ts';

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is not set (run with: node --env-file=.env scripts/<script>.ts)`);
		process.exit(1);
	}
	return value;
}

export function boschClient(verbose = process.argv.includes('--verbose')): BoschClient {
	return new BoschClient({
		endpoint: {
			host: process.env.BOSCH_HOST || 'ap.myalarms1.com',
			port: Number(process.env.BOSCH_PORT || 9050),
			timeoutMs: 6000
		},
		credentials: {
			serialNumber: required('BOSCH_SERIAL'),
			appCode: process.env.BOSCH_APPCODE ?? '',
			deviceId: Number(required('BOSCH_DEVICEID')),
			userPin: process.env.BOSCH_USERPIN || undefined
		},
		log: verbose ? (dir, msg) => console.log(`[${dir}] ${msg}`) : undefined
	});
}
