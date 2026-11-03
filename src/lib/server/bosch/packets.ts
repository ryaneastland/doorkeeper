// Bosch / myAlarm iFob — packet construction.
//
// Layers, outermost first (see README for byte maps):
//   wire      = [9-byte clear header] + AES-CBC( plaintext )          (m2/g.A)
//   plaintext = [00, len, opcode, subcmd, seq, 00] + payload
//   payload   = [01] + opcode-29 frame                                (o3/g.k)
//   op29      = [seq, innerLen+8, 01, 1D, P0,P1,P2,P3] + inner + cksum
//   inner     = command bytes + cksum                                 (o3/g.d / a)
//
// Opcodes / sub-functions marked "VERIFY" are my best reading of the decompiled
// switch statements and MUST be confirmed against a live capture before being
// trusted on a real panel. The crypto and framing are high-confidence.

import {
	aesEncrypt,
	deriveIv,
	encodeDigits4,
	int32BE,
	LOGIN_SERIAL_LE,
	makeNonce,
	withChecksum
} from './crypto.ts';

export const OUTER_OPCODE_COMMAND = 8; // commands wrapped by k() go out as opcode 8
export const OUTER_OPCODE_LOGIN = 12; // login handshake
export const OUTER_OPCODE_STATUS = 13; // panel status / capabilities (z())
export const OUTER_OPCODE_REKEY = 5; // post-connect rekey -> delivers command key D
export const OP29 = 0x1d; // 29 — the inner "command frame" opcode

/** Rekey request payload (op5). Confirmed from capture: 3 bytes [01,01,01]. */
export const REKEY_PAYLOAD = Buffer.from([1, 1, 1]);

/**
 * Encode an optional user keypad PIN (USER_PASS_CODE / field F) into the 4
 * header bytes of an opcode-29 frame. Pairs of digits -> (second<<4)+first;
 * a lone trailing digit -> 0xA0+digit; missing bytes -> 0xAA. (from o3.g.k)
 */
export function encodePin4(pin?: string): Buffer {
	const out = Buffer.from([0xaa, 0xaa, 0xaa, 0xaa]);
	if (!pin) return out;
	const d = [...pin.replace(/\D/g, '')].map((c) => c.charCodeAt(0) - 0x30);
	for (let byteIdx = 0; byteIdx < 4; byteIdx++) {
		const first = d[byteIdx * 2];
		const second = d[byteIdx * 2 + 1];
		if (first === undefined) break;
		out[byteIdx] = second === undefined ? (0xa0 + first) & 0xff : ((second << 4) + first) & 0xff;
	}
	return out;
}

/**
 * o3.g.k — wrap an already-checksummed inner command in an opcode-29 frame.
 * The length byte counts [inner]+8; a trailing 0x00 is appended after the inner
 * before the frame checksum (confirmed from live capture).
 */
export function wrapOp29(seq: number, inner: Buffer, pin?: string): Buffer {
	const p = encodePin4(pin);
	const header = Buffer.from([
		seq & 0xff,
		(inner.length + 8) & 0xff,
		0x01,
		OP29,
		p[0],
		p[1],
		p[2],
		p[3]
	]);
	const body = withChecksum(Buffer.concat([header, inner, Buffer.from([0x00])])); // l()
	return Buffer.concat([Buffer.from([0x01]), body]);
}

/**
 * o3.g.d — area operation command (arm/disarm).
 * bytes: [seq, 6, 1, 14, func, area, mode] + checksum, then wrapped in op29.
 *
 * VERIFY: from g.I(), func 5 = ARM (i8==1), func 16 = DISARM (i8==2); mode=16.
 */
export function buildAreaOp(
	seq: number,
	area: number,
	func: number,
	mode = 16,
	pin?: string
): Buffer {
	const inner = withChecksum(
		Buffer.from([seq & 0xff, 6, 1, 14, func & 0xff, area & 0xff, mode & 0xff])
	);
	return wrapOp29(seq, inner, pin);
}

// Area operation function bytes (confirmed live via state read):
//   g.b(func3,mode0)=DISARM, g.a(func4,mode16)=ARM_ALL_ON,
//   g.I(func5,mode16)=ARM_PART_1, g.I(func16,mode16)=ARM_PART_2.
export const AREA_FUNC_DISARM = 3;
export const AREA_DISARM_MODE = 0;
export const AREA_FUNC_ARM_ALL = 4;
export const AREA_FUNC_ARM_PART1 = 5;
export const AREA_FUNC_ARM_PART2 = 16;
export const AREA_ARM_MODE = 16;

/**
 * o3.g.a — control an output or door.
 * inner: [seq, 8, 1, 5, devIndex, idxHi, idxLo, state, 1] + checksum.
 * `state` turns it on/off (door open = on). (from g.m())
 * VERIFY: devIndex mapping and state values.
 */
export function buildControl(
	seq: number,
	devIndex: number,
	targetIndex: number,
	state: number,
	pin?: string
): Buffer {
	const inner = withChecksum(
		Buffer.from([
			seq & 0xff,
			8,
			1,
			5,
			devIndex & 0xff,
			(targetIndex >>> 8) & 0xff,
			targetIndex & 0xff,
			state & 0xff,
			1
		])
	);
	return wrapOp29(seq, inner, pin);
}

/** Device-info trailer for the login packet: "u\0 v\0 codename\0". */
function loginDeviceInfo(): { u: string; v: string; codename: string } {
	// The panel appears to only use the declared lengths; exact text is cosmetic.
	return { u: 'Android SDK: 34 (14)', v: 'DoorKeeper Bridge', codename: 'REL' };
}

/**
 * Login inner payload (m2.g.y step 1): 16-byte header + device info strings.
 * header = {1,1, serial[3..0], appcode[3..0], lenU_hi,lenU, lenV_hi,lenV, lenCN_hi,lenCN}
 */
export function buildLoginPayload(serialNumber: string, appCode: string): Buffer {
	const s = encodeDigits4(serialNumber);
	const a = encodeDigits4(appCode);
	const { u, v, codename } = loginDeviceInfo();
	const bu = Buffer.from(u, 'utf8');
	const bv = Buffer.from(v, 'utf8');
	const bc = Buffer.from(codename, 'utf8');
	const header = Buffer.from([
		1,
		1,
		s[3],
		s[2],
		s[1],
		s[0],
		a[3],
		a[2],
		a[1],
		a[0],
		(bu.length >>> 8) & 0xff,
		bu.length & 0xff,
		(bv.length >>> 8) & 0xff,
		bv.length & 0xff,
		(bc.length >>> 8) & 0xff,
		bc.length & 0xff
	]);
	return Buffer.concat([header, bu, Buffer.from([0]), bv, Buffer.from([0]), bc, Buffer.from([0])]);
}

/**
 * Login stage-2 confirm payload (m2.g.y step 2): sends the session key back to
 * the panel with a checksum to bind/register the session. 23 bytes:
 *   [3, 1, serial[3..0], keyChecksum, <16-byte session key>]
 * Still an opcode-12 frame, so encrypted with the bootstrap key.
 */
export function buildLoginConfirmPayload(serialNumber: string, sessionKey: Buffer): Buffer {
	const s = encodeDigits4(serialNumber);
	let sum = 0;
	for (const b of sessionKey) sum = (sum + b) % 256;
	return Buffer.concat([Buffer.from([3, 1, s[3], s[2], s[1], s[0], sum & 0xff]), sessionKey]);
}

export interface FrameOptions {
	opcode: number;
	subcmd: number;
	seq: number;
	payload?: Buffer;
	key: Buffer;
	/** Serial for the clear header. Omit for login (uses BADDF00D). */
	serialNumber?: string;
	/** f2114g capability/feature byte (0..31). 31 before handshake. */
	feature?: number;
	/** f4312n device slot used in the flags byte for most opcodes. */
	deviceSlot?: number;
}

/**
 * m2.g.A — assemble the full wire packet.
 * Returns { wire, nonce } so callers can verify replies.
 */
export function buildFrame(opts: FrameOptions): { wire: Buffer; nonce: number } {
	const { opcode, subcmd, seq, payload, key } = opts;
	const feature = (opts.feature ?? 31) & 0x1f;
	const isLogin = opcode === OUTER_OPCODE_LOGIN;

	const nonce = makeNonce();
	const i16 = nonce >>> 24;

	const serial4 = isLogin ? LOGIN_SERIAL_LE : encodeDigits4(opts.serialNumber ?? '0');
	const xoredSerial = (int32BE(serial4) ^ nonce) | 0;

	// opcodes 14,20,5,21 force slot 0; otherwise use the device slot.
	const slot = [14, 20, 5, 21].includes(opcode) ? 0 : (opts.deviceSlot ?? 0);
	const flags = (((slot << 5) | feature) ^ i16) & 0xff;

	const clear = Buffer.from([
		nonce & 0xff,
		(nonce >>> 8) & 0xff,
		(nonce >>> 16) & 0xff,
		i16 & 0xff,
		xoredSerial & 0xff,
		(xoredSerial >>> 8) & 0xff,
		(xoredSerial >>> 16) & 0xff,
		(xoredSerial >>> 24) & 0xff,
		flags
	]);

	const payloadLen = payload ? payload.length : 0;
	const limit = 15 + payloadLen;
	// NOTE: the app writes the high length byte as (limit<<8)&0xFF, which is
	// always 0. Replicated exactly for wire-compatibility.
	const plainHeader = Buffer.from([
		(limit << 8) & 0xff,
		limit & 0xff,
		opcode & 0xff,
		subcmd & 0xff,
		seq & 0xff,
		0x00
	]);
	const plaintext = payload ? Buffer.concat([plainHeader, payload]) : plainHeader;

	const iv = deriveIv(nonce);
	const ciphertext = aesEncrypt(plaintext, key, iv);
	return { wire: Buffer.concat([clear, ciphertext]), nonce };
}
