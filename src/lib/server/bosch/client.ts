// Bosch / myAlarm iFob — UDP client.
//
// Opens a UDP socket to a panel (direct IP or cloud relay), performs the login
// handshake to obtain a session key, then sends encrypted commands.
//
// SAFETY: this talks to a real alarm panel. Use `dryRun` to inspect the exact
// bytes first, and confirm the VERIFY-marked opcodes against a live capture
// before trusting arm/disarm/door on a production site. Only operate panels you
// are authorised to control.

import { createSocket, type Socket } from 'node:dgram';
import {
	aesDecryptNoPad,
	BOOTSTRAP_KEY,
	deriveIv,
	encodeDigits4,
	int32BE,
	withChecksum,
	MAGIC_DEFAULT_SERIAL
} from './crypto.ts';
import {
	AREA_FUNC_ARM_ALL,
	AREA_FUNC_ARM_PART1,
	AREA_FUNC_ARM_PART2,
	AREA_FUNC_DISARM,
	AREA_ARM_MODE,
	AREA_DISARM_MODE,
	buildAreaOp,
	buildControl,
	buildFrame,
	wrapOp29,
	buildLoginPayload,
	buildLoginConfirmPayload,
	OUTER_OPCODE_COMMAND,
	OUTER_OPCODE_LOGIN,
	OUTER_OPCODE_STATUS,
	OUTER_OPCODE_REKEY,
	REKEY_PAYLOAD
} from './packets.ts';
import type { CommandResult, PanelEndpoint, SiteCredentials } from './types.ts';

export interface BoschClientOptions {
	endpoint: PanelEndpoint;
	credentials: SiteCredentials;
	/** When true, never transmit: build packets and return their hex. */
	dryRun?: boolean;
	/** Optional logger for raw tx/rx hex. */
	log?: (dir: 'tx' | 'rx' | 'info', msg: string) => void;
}

export class BoschClient {
	private readonly ep: Required<PanelEndpoint>;
	private readonly creds: SiteCredentials;
	private readonly dryRun: boolean;
	private readonly log: (dir: 'tx' | 'rx' | 'info', msg: string) => void;

	private seq = 0;
	/** Set when the panel stopped answering; the session should be re-established. */
	private timedOut = false;
	private sessionKey: Buffer | null = null; // C, negotiated at login
	private commandKey: Buffer | null = null; // D, delivered by the op5 rekey after connect
	private feature = 31; // f2114g, set from the login reply (capture: 4)
	private deviceSlot = 0; // f4312n: 0 during connect/rekey, 1 after rekey (panel-assigned)

	constructor(opts: BoschClientOptions) {
		this.ep = {
			host: opts.endpoint.host,
			port: opts.endpoint.port ?? 9050,
			localPort: opts.endpoint.localPort ?? 0,
			timeoutMs: opts.endpoint.timeoutMs ?? 5000
		};
		this.creds = opts.credentials;
		this.dryRun = opts.dryRun ?? false;
		this.log = opts.log ?? (() => {});
	}

	/** Rolling 1-byte sequence (m2.g.w): 1..255, never 0. */
	private nextSeq(): number {
		this.seq = (this.seq + 1) & 0xff;
		if (this.seq === 0) this.seq = 1;
		return this.seq;
	}

	private sock: Socket | null = null;
	private pending: {
		resolve: (b: Buffer) => void;
		reject: (e: Error) => void;
		accept?: (b: Buffer) => boolean;
	} | null = null;

	/** Open (once) the persistent socket the whole session shares, like the app. */
	private ensureSocket(): Promise<void> {
		if (this.sock) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const sock = createSocket({ type: 'udp4', reuseAddr: true });
			sock.on('error', (e) => {
				const p = this.pending;
				this.pending = null;
				if (p) p.reject(e);
			});
			sock.on('message', (msg) => {
				this.log('rx', msg.toString('hex'));
				const p = this.pending;
				const buf = Buffer.from(msg);
				// The panel re-sends replies and pushes unsolicited events; ignore
				// anything that isn't the reply we're waiting for, so a stray packet
				// can't shift every later reply by one.
				if (!p || (p.accept && !p.accept(buf))) {
					this.log('info', 'ignored unmatched datagram');
					return;
				}
				this.pending = null;
				p.resolve(buf);
			});
			const ready = () => {
				this.sock = sock;
				resolve();
			};
			if (this.ep.localPort) sock.bind(this.ep.localPort, ready);
			else sock.bind(ready);
			sock.on('error', reject);
		});
	}

	/**
	 * Send one datagram on the shared socket and wait for the reply (the next one
	 * `accept` passes). With `resendMs`, re-send the identical datagram (same seq)
	 * every resendMs until a reply arrives, like the app: UDP drops the odd packet,
	 * and the panel answers a repeated seq with the same reply instead of re-running it.
	 */
	private async sendAndReceive(
		wire: Buffer,
		accept?: (b: Buffer) => boolean,
		resendMs?: number
	): Promise<Buffer> {
		this.log('tx', wire.toString('hex'));
		if (this.dryRun) throw new Error('dryRun: not transmitted');
		await this.ensureSocket();
		return new Promise<Buffer>((resolve, reject) => {
			let resend: ReturnType<typeof setInterval> | undefined;
			const done = () => {
				clearTimeout(timer);
				if (resend) clearInterval(resend);
			};
			// Always settle on timeout (even if close() already cleared `pending`), so
			// a dead request can never hang the serialized queue in the manager.
			const timer = setTimeout(() => {
				done();
				this.pending = null;
				this.timedOut = true;
				reject(new Error('panel timeout')); // no-op if already resolved
			}, this.ep.timeoutMs);
			this.pending = {
				accept,
				resolve: (b) => {
					done();
					resolve(b);
				},
				reject: (e) => {
					done();
					reject(e);
				}
			};
			const send = () =>
				this.sock?.send(wire, this.ep.port, this.ep.host, (e) => {
					if (e && this.pending) {
						this.pending = null;
						done();
						reject(e);
					}
				});
			send();
			if (resendMs) {
				resend = setInterval(() => {
					if (!this.pending) return;
					this.log('info', 'no reply yet, re-sending');
					send();
				}, resendMs);
			}
		});
	}

	/** Close the shared socket when done. */
	close(): void {
		try {
			this.sock?.close();
		} catch {
			/* ignore */
		}
		this.sock = null;
		this.pending = null;
	}

	/**
	 * Decrypt a reply. `key` is the bootstrap key for the login reply, else the
	 * session key. Returns the decrypted plaintext body (m2.g.g).
	 */
	private decryptReply(wire: Buffer, key: Buffer): Buffer {
		if (wire.length < 9 + 16) throw new Error('reply too short');
		const nonce = wire.readUInt32LE(0) | 0;
		const iv = deriveIv(nonce);
		const ciphertext = wire.subarray(9);
		return aesDecryptNoPad(ciphertext, key, iv);
	}

	/** Which key the panel used to encrypt a reply (BADDF00D serial => bootstrap). */
	private replyUsesBootstrap(wire: Buffer): boolean {
		const serial = Buffer.from(wire.subarray(4, 8));
		const nonce = wire.readUInt32LE(0) | 0;
		for (let i = 0; i < 4; i++) serial[i] = (serial[i] ^ (nonce >>> ((i % 4) * 8))) & 0xff;
		return int32BE(serial) === int32BE(MAGIC_DEFAULT_SERIAL);
	}

	/**
	 * Decrypt a reply, trying each known key (bootstrap, C, D) and picking the one
	 * whose plaintext is structured (byte[5]==0, plausible opcode). Panel replies
	 * are NoPadding, so we validate by structure rather than padding.
	 */
	private decryptAuto(wire: Buffer): Buffer {
		const candidates = [BOOTSTRAP_KEY, this.commandKey, this.sessionKey].filter(
			(k): k is Buffer => !!k
		);
		for (const key of candidates) {
			try {
				const pt = this.decryptReply(wire, key);
				// connect/login replies have byte5==0; op8 replies echo opcode in [2].
				if (pt.length >= 6 && [5, 8, 12, 13].includes(pt[2]) && pt[3] < 16) return pt;
			} catch {
				/* try next */
			}
		}
		// fall back to bootstrap/session so callers still get bytes
		return this.decryptReply(wire, this.sessionKey ?? BOOTSTRAP_KEY);
	}

	/**
	 * Full two-stage login handshake (m2.g.y), both encrypted with the bootstrap key:
	 *   Stage 1: send device info -> panel returns the 16-byte session key.
	 *   Stage 2: send the session key back + its checksum -> panel binds/registers
	 *            the session. This is the step that "locks it in".
	 *
	 * Session key is at decrypted plaintext bytes [13..29); feature byte at [12].
	 */
	async login(): Promise<CommandResult> {
		// --- Stage 1: request session key ---
		const seq1 = this.nextSeq();
		const payload1 = buildLoginPayload(this.creds.serialNumber, this.creds.appCode);
		this.feature = 31;
		const { wire: wire1 } = buildFrame({
			opcode: OUTER_OPCODE_LOGIN,
			subcmd: 1,
			seq: seq1,
			payload: payload1,
			key: BOOTSTRAP_KEY,
			feature: this.feature
		});
		if (this.dryRun) {
			this.log('info', `login stage1 (dryRun): ${wire1.toString('hex')}`);
			return { ok: false, error: 'dryRun' };
		}
		try {
			const reply1 = await this.sendAndReceive(wire1);
			const plain1 = this.decryptReply(reply1, BOOTSTRAP_KEY);
			if (plain1.length < 29) {
				return { ok: false, error: 'stage1 reply too short for session key', reply: plain1 };
			}
			this.sessionKey = Buffer.from(plain1.subarray(13, 29));
			this.feature = plain1[12] & 0x1f;
			this.log(
				'info',
				`stage1 ok, session key ${this.sessionKey.toString('hex')}, feature ${this.feature}`
			);

			// --- Stage 2: confirm/bind the session key ---
			const seq2 = this.nextSeq();
			const payload2 = buildLoginConfirmPayload(this.creds.serialNumber, this.sessionKey);
			const { wire: wire2 } = buildFrame({
				opcode: OUTER_OPCODE_LOGIN,
				subcmd: 1,
				seq: seq2,
				payload: payload2,
				key: BOOTSTRAP_KEY,
				feature: this.feature
			});
			const reply2 = await this.sendAndReceive(wire2);
			const plain2 = this.decryptAuto(reply2);
			// Success per decompile: opcode 12 echoed and status byte at [6] == 4.
			const confirmed = plain2.length > 6 && plain2[2] === 12 && plain2[6] === 4;
			this.log('info', `stage2 reply ${plain2.toString('hex')}`);
			return {
				ok: confirmed,
				reply: plain2,
				error: confirmed ? undefined : 'stage2 not confirmed by panel'
			};
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	/**
	 * Establish a command session: op13 (status/connect) then the op5 rekey that
	 * delivers command key D. Must be called after login(); commands need D.
	 */
	async connect(): Promise<CommandResult> {
		if (!this.sessionKey) {
			const li = await this.login();
			if (!li.ok) return { ok: false, error: `login failed: ${li.error}` };
		}
		// op13 status/connect (key C)
		const statusRes = await this.getStatus();
		if (!statusRes.ok && !this.dryRun) {
			return { ok: false, error: `connect/status failed: ${statusRes.error}` };
		}
		// op5 rekey (key C) -> reply body[4..20) is command key D
		const seq = this.nextSeq();
		const { wire } = buildFrame({
			opcode: OUTER_OPCODE_REKEY,
			subcmd: 1,
			seq,
			payload: REKEY_PAYLOAD,
			key: this.sessionKey!,
			serialNumber: this.creds.serialNumber,
			feature: this.feature,
			deviceSlot: this.deviceSlot
		});
		if (this.dryRun) {
			this.log('info', `rekey (dryRun): ${wire.toString('hex')}`);
			return { ok: false, error: 'dryRun' };
		}
		try {
			const reply = await this.sendAndReceive(wire);
			const plain = this.decryptAuto(reply);
			const body = plain.subarray(6);
			if (plain[2] === OUTER_OPCODE_REKEY && body.length >= 20) {
				this.commandKey = Buffer.from(body.subarray(4, 20));
				// panel assigns the command-phase slot (f4312n) here; capture shows 1.
				this.deviceSlot = body[2] || 1;
				this.log(
					'info',
					`command key D = ${this.commandKey.toString('hex')}, slot = ${this.deviceSlot}`
				);
				return { ok: true, reply: plain };
			}
			return { ok: false, error: 'rekey reply missing command key', reply: plain };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	/**
	 * Build and send one op8 command. `build` receives the sequence number, which is
	 * used for both the inner command and the outer frame (as the app does), and
	 * the reply is matched on it.
	 */
	private async op(build: (seq: number) => Buffer): Promise<CommandResult> {
		if (!this.commandKey && !this.dryRun) {
			const c = await this.connect();
			if (!c.ok) return { ok: false, error: `connect failed: ${c.error}` };
		}
		const seq = this.nextSeq();
		return this.command(build(seq), seq);
	}

	private async command(payload: Buffer, seq: number): Promise<CommandResult> {
		const { wire } = buildFrame({
			opcode: OUTER_OPCODE_COMMAND,
			subcmd: 1,
			seq,
			payload,
			key: this.commandKey ?? this.sessionKey ?? BOOTSTRAP_KEY,
			serialNumber: this.creds.serialNumber,
			feature: this.feature,
			deviceSlot: this.deviceSlot
		});
		if (this.dryRun) {
			this.log('info', `command (dryRun): ${wire.toString('hex')}`);
			return { ok: false, error: 'dryRun' };
		}
		try {
			const isOurReply = (b: Buffer) => {
				try {
					const pt = this.decryptAuto(b);
					// op8 reply; outer seq at [4], inner seq at [7]
					return pt[2] === OUTER_OPCODE_COMMAND && (pt[4] === seq || pt[7] === seq);
				} catch {
					return false;
				}
			};
			const reply = await this.sendAndReceive(wire, isOurReply, 1500);
			const plain = this.decryptAuto(reply);
			// Reply type 0x82 is the panel refusing the command (capture: area query
			// for a missing area, or disarm of an area the user isn't assigned to,
			// which carries text like "User Not Assigned to Area").
			const body = plain.subarray(6);
			if (body[4] === 0x82) {
				const text = body
					.subarray(5)
					.toString('latin1')
					.match(/[ -~]{4,}/)?.[0];
				return {
					ok: false,
					error: text ? `panel refused: ${text}` : 'panel refused command',
					reply: plain
				};
			}
			return { ok: true, reply: plain };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	/**
	 * Read-only op8 probe: replicates the app's first post-connect query
	 * (capture #9: e() func 15, args 12/1). Confirms the command channel works
	 * without changing panel state. Returns ok if the panel ack's (op=8 reply).
	 */
	async probe(): Promise<CommandResult> {
		return this.op((seq) =>
			wrapOp29(seq, withChecksum(Buffer.from([seq & 0xff, 6, 1, 15, 12, 1, 0])), this.creds.userPin)
		);
	}

	/**
	 * Send a raw op8 command. `inner` is the inner command bytes; inner[0] is
	 * overwritten with the current sequence number. Returns the decoded reply.
	 */
	async rawCommand(inner: number[]): Promise<CommandResult> {
		return this.op((seq) => {
			const b = Buffer.from(inner);
			b[0] = seq & 0xff;
			return wrapOp29(seq, withChecksum(b), this.creds.userPin);
		});
	}

	/**
	 * Read area arm states. Query inner [seq,6,1,15,3,n,0]; reply body[5]=3,
	 * body[6]=area n (echoed), body[18]=state (m2.a enum): 2=disarmed, 3=armed_all_on.
	 * NOTE: body[8] is NOT the area index — it tracks the state (01 disarmed, 03
	 * armed), which is how disarm ended up targeting "area 3" when armed.
	 */
	async getAreaStates(count = 8): Promise<{ index: number; state: string }[]> {
		const names = [
			'NOT_USED',
			'OFF_LINE',
			'DISARMED',
			'ARMED_ALL_ON',
			'ARMED_PART_1',
			'ARMED_PART_2',
			'ARMED'
		];
		const out: { index: number; state: string }[] = [];
		for (let n = 1; n <= count; n++) {
			const r = await this.rawCommand([0, 6, 1, 15, 3, n, 0]); // e(3, n): area n
			if (!r.ok || !r.reply) break;
			const body = r.reply.subarray(6);
			if (body.length < 19 || body[4] !== 0x8f || body[5] !== 3 || body[6] !== n) break;
			const code = body[18];
			out.push({ index: n, state: names[code] ?? `code_${code}` });
		}
		return out;
	}

	/**
	 * Read door/output lock state via the subtype-22 query (e(22,n)). Reply byte8
	 * is the output state bitfield; bit 0x02 set = unlocked, clear = locked.
	 * Confirmed: live read = locked (0x05), capture toggled to 0x07 on unlock.
	 */
	async getDoorState(index = 1): Promise<{ locked: boolean; raw: number } | null> {
		const r = await this.rawCommand([0, 6, 1, 15, 22, index, 0]);
		const body = r.reply?.subarray(6);
		if (!body || body.length < 9 || body[4] !== 0x8f) return null;
		const raw = body[8];
		return { locked: (raw & 0x02) === 0, raw };
	}

	/**
	 * Enumerate named items of a kind (subtype 3 = areas, 2 = zones/outputs),
	 * returning {index, name, type}. Reply: [seq,len,01,91,subtype,00,idx,type,00,<name\0>].
	 */
	async enumerate(
		subtype: number,
		max = 16
	): Promise<{ index: number; name: string; type: number }[]> {
		const out: { index: number; name: string; type: number }[] = [];
		const bus = subtype === 3 ? 2 : 9; // bus byte seen in capture
		for (let idx = 0; idx < max; idx++) {
			const r = await this.rawCommand([0, 12, 1, 17, subtype, 0, idx, 0, 0, 0, bus, 0, 1]);
			if (!r.ok || !r.reply) break;
			// reply body: [01][seq][len][01][91][subtype][00][idx][type][00][name\0]
			const body = r.reply.subarray(6);
			if (body.length < 11) break;
			const type = body[8];
			const nameBytes = body.subarray(10);
			const end = nameBytes.indexOf(0);
			const name = nameBytes
				.subarray(0, end < 0 ? nameBytes.length : end)
				.toString('utf8')
				.trim();
			if (!name) break;
			out.push({ index: idx, name, type });
		}
		return out;
	}

	/** Arm an area, all-on (g.a func4). Blocked by the panel if a zone isn't ready. */
	armArea(area: number): Promise<CommandResult> {
		return this.op((seq) =>
			buildAreaOp(seq, area, AREA_FUNC_ARM_ALL, AREA_ARM_MODE, this.creds.userPin)
		);
	}

	/** Arm an area, part 1 (g.I,1 func5). */
	armPart1(area: number): Promise<CommandResult> {
		return this.op((seq) =>
			buildAreaOp(seq, area, AREA_FUNC_ARM_PART1, AREA_ARM_MODE, this.creds.userPin)
		);
	}

	/** Arm an area, part 2 (g.I,2 func16). */
	armPart2(area: number): Promise<CommandResult> {
		return this.op((seq) =>
			buildAreaOp(seq, area, AREA_FUNC_ARM_PART2, AREA_ARM_MODE, this.creds.userPin)
		);
	}

	/** Disarm an area (g.b func3, mode0). Confirmed live. */
	disarmArea(area: number): Promise<CommandResult> {
		return this.op((seq) =>
			buildAreaOp(seq, area, AREA_FUNC_DISARM, AREA_DISARM_MODE, this.creds.userPin)
		);
	}

	/** Unlock a door (d() func14). Confirmed live: door lock bit -> unlocked. */
	unlockDoor(door = 1): Promise<CommandResult> {
		return this.op((seq) => buildAreaOp(seq, door, 14, 0, this.creds.userPin));
	}

	/** Lock a door (d() func15). Confirmed live. */
	lockDoor(door = 1): Promise<CommandResult> {
		return this.op((seq) => buildAreaOp(seq, door, 15, 0, this.creds.userPin));
	}

	/**
	 * Operate (momentary pulse) a door (d() func13, mode0). Confirmed from an app
	 * capture: door reads unlocked (0x07) ~1s later and the panel re-locks it itself.
	 */
	operateDoor(door = 1): Promise<CommandResult> {
		return this.op((seq) => buildAreaOp(seq, door, 13, 0, this.creds.userPin));
	}

	/** Operate/toggle an output (g.m output types). */
	controlOutput(devIndex: number, target: number, state: number): Promise<CommandResult> {
		return this.op((seq) => buildControl(seq, devIndex, target, state, this.creds.userPin));
	}

	/**
	 * Read-only panel status (opcode 13 / m2.g.z). Uses the session key; does NOT
	 * change panel state. Safe way to confirm the session channel works.
	 */
	async getStatus(): Promise<CommandResult> {
		if (!this.sessionKey && !this.dryRun) {
			const li = await this.login();
			if (!li.ok) return { ok: false, error: `login failed: ${li.error}` };
		}
		const seq = this.nextSeq();
		const { wire } = buildFrame({
			opcode: OUTER_OPCODE_STATUS,
			subcmd: 1,
			seq,
			key: this.sessionKey ?? BOOTSTRAP_KEY,
			serialNumber: this.creds.serialNumber,
			feature: this.feature,
			deviceSlot: this.deviceSlot
		});
		if (this.dryRun) {
			this.log('info', `status (dryRun): ${wire.toString('hex')}`);
			return { ok: false, error: 'dryRun' };
		}
		try {
			const reply = await this.sendAndReceive(wire);
			const plain = this.decryptAuto(reply);
			return { ok: plain.length > 0, reply: plain };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	/**
	 * True once any request went unanswered (even if the caller swallowed the
	 * error, e.g. getAreaStates). A session the panel has dropped — say because
	 * the app took it over — never recovers, so the owner should reconnect.
	 */
	get needsReconnect(): boolean {
		return this.timedOut;
	}

	/** The feature byte negotiated at login (persist it with the session key). */
	get featureByte(): number {
		return this.feature;
	}

	/** The negotiated session key as hex, once logged in. */
	get sessionKeyHex(): string | null {
		return this.sessionKey ? this.sessionKey.toString('hex') : null;
	}

	/**
	 * Restore a previously-saved session key so commands run WITHOUT re-logging-in
	 * (which would consume another one-time app code). Use after registering once.
	 */
	restore(sessionKeyHex: string, feature: number): void {
		this.sessionKey = Buffer.from(sessionKeyHex, 'hex');
		this.feature = feature & 0x1f;
	}

	/** Build (but never send) the login + a sample command, as hex, for inspection. */
	dump(): { login: string; disarmArea1: string } {
		const loginSeq = this.nextSeq();
		const login = buildFrame({
			opcode: OUTER_OPCODE_LOGIN,
			subcmd: 1,
			seq: loginSeq,
			payload: buildLoginPayload(this.creds.serialNumber, this.creds.appCode),
			key: BOOTSTRAP_KEY,
			feature: 31
		}).wire;
		const cmdSeq = this.nextSeq();
		const disarm = buildFrame({
			opcode: OUTER_OPCODE_COMMAND,
			subcmd: 1,
			seq: cmdSeq,
			payload: buildAreaOp(cmdSeq, 1, AREA_FUNC_DISARM, AREA_DISARM_MODE, this.creds.userPin),
			key: this.sessionKey ?? BOOTSTRAP_KEY,
			serialNumber: this.creds.serialNumber,
			feature: this.feature,
			deviceSlot: this.deviceSlot
		}).wire;
		return { login: login.toString('hex'), disarmArea1: disarm.toString('hex') };
	}
}

export { encodeDigits4 };
