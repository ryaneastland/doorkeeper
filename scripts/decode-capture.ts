// Decode a captured myAlarm/Bosch relay session (udp 9050) using our crypto.
//   node scripts/decode-capture.ts <relay_all.txt>
// File format per line: <frame>\t<src_ip>\t<hexpayload>
import { readFileSync } from 'node:fs';
import {
	BOOTSTRAP_KEY,
	deriveIv,
	aesDecryptNoPad,
	int32BE,
	MAGIC_DEFAULT_SERIAL
} from '../src/lib/server/bosch/crypto.ts';

const RELAY = '52.64.17.54'; // panel side; anything else is app/host (TX)
const path = process.argv[2];
const seedC = process.argv[3]; // known C for reconnect captures (no op12 login)
const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());

const keys: { name: string; key: Buffer }[] = [{ name: 'BOOT', key: BOOTSTRAP_KEY }];
if (seedC) keys.push({ name: 'C', key: Buffer.from(seedC, 'hex') });

function ascii(b: Buffer): string {
	return [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
}

// The correct key yields valid PKCS7 padding (last byte N, last N bytes all == N).
function validPkcs7(pt: Buffer): boolean {
	const pad = pt[pt.length - 1];
	if (pad < 1 || pad > 16 || pad > pt.length) return false;
	for (let i = pt.length - pad; i < pt.length; i++) if (pt[i] !== pad) return false;
	return pt.length >= 6 && pt[5] === 0x00;
}
function unpad(pt: Buffer): Buffer {
	return pt.subarray(0, pt.length - pt[pt.length - 1]);
}

for (const line of lines) {
	const [frame, src, hex] = line.split('\t');
	if (!hex) continue;
	const pay = Buffer.from(hex, 'hex');
	if (pay.length < 9 + 16) continue;
	const dir = src === RELAY ? 'RX<-panel' : 'TX->panel';
	const nonce = pay.readUInt32LE(0) | 0;
	const ser = Buffer.from(pay.subarray(4, 8));
	for (let i = 0; i < 4; i++) ser[i] = (ser[i] ^ (nonce >>> ((i % 4) * 8))) & 0xff;
	const iv = deriveIv(nonce);
	const ct = pay.subarray(9);
	if (ct.length % 16 !== 0) continue;

	// TX (app->panel) is PKCS7; RX (panel->app) is NoPadding. Pick the matching key.
	const isTX = src !== RELAY;
	let pt: Buffer | null = null;
	let used = '?';
	for (const k of keys) {
		try {
			const t = aesDecryptNoPad(ct, k.key, iv);
			const ok = isTX ? validPkcs7(t) : [5, 8, 12, 13].includes(t[2]) && t[3] < 16;
			if (ok) {
				pt = isTX ? unpad(t) : t;
				used = k.name;
				break;
			}
		} catch {
			/* skip */
		}
	}
	if (!pt) {
		console.log(`#${String(frame).padStart(3)} ${dir} <no key matched>`);
		continue;
	}
	const op = pt[2];
	const sub = pt[3];
	const seq = pt[4];
	const body = pt.subarray(6);

	// harvest keys from valid decodes
	if (dir.startsWith('RX') && op === 12 && pt.length >= 29 && !keys.find((x) => x.name === 'C')) {
		keys.push({ name: 'C', key: Buffer.from(pt.subarray(13, 29)) });
		console.log(`      >>> key C = ${pt.subarray(13, 29).toString('hex')}`);
	}
	if (op === 5 && dir.startsWith('RX') && body.length >= 20) {
		const d = Buffer.from(body.subarray(4, 20));
		if (!keys.find((x) => x.key.equals(d))) {
			keys.push({ name: 'D' + (keys.filter((k) => k.name.startsWith('D')).length || ''), key: d });
			console.log(`      >>> key D = ${d.toString('hex')}`);
		}
	}
	console.log(`#${String(frame).padStart(3)} ${dir} [${used}] op=${op} sub=${sub} seq=${seq}`);
	console.log(`      body=${body.toString('hex')}  "${ascii(body)}"`);
}
