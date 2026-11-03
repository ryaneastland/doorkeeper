# Bosch / myAlarm iFob panel client

Server-only TypeScript client for Bosch panels that speak the **myAlarm iFob**
protocol, reverse-engineered from the `au.com.myalarm.ifob_control` Android app
(v2.315). This replaces DoorKeeper's Inner Range cloud REST layer.

> **Authorisation:** this controls real alarm panels (arm / disarm / door
> release). Only use it against panels you are authorised to operate. The
> process that runs this holds disarm capability — treat it like a key.

## Why a Node server (not Netlify)

The protocol is **binary UDP**, not HTTP. Serverless functions can't hold UDP
sockets, so the Bosch build runs on a persistent Node host (`adapter-node`) that
can reach the panel — either directly (LAN / port-forward) or via the cloud
relay `ap.myalarms1.com:9050` (AU) / `eu.myalarms1.com:9050` (EU).

## Credentials (what a site is given)

| Field               | Example  | Role                                                  |
| ------------------- | -------- | ----------------------------------------------------- |
| Panel Serial Number | `123456` | Identifies the panel; encoded into every header       |
| Panel App Code      | `000000` | Authenticates the login handshake                     |
| Device ID           | `3`      | The app-user slot on the panel                        |
| Device Name         | `test`   | Label only                                            |
| User PIN (optional) | –        | Needed only if the site enforces "always require PIN" |

There is **no pre-shared key** to obtain — the session key is negotiated at
login using an app-wide bootstrap key baked into the app (reproduced in
`crypto.ts`).

## Protocol summary

```
wire      = [9-byte clear header] + AES-128-CBC( plaintext )
clear     = nonce(4, LE) + (serial32BE XOR nonce)(4) + flags(1)
plaintext = [00, len, opcode, subcmd, seq, 00] + payload      (PKCS#7 padded)
payload   = [01] + op29frame                                  (commands only)
op29frame = [seq, innerLen+8, 01, 1D, pin0..pin3] + inner + cksum
inner     = <command bytes> + cksum
```

- **IV** = fixed base XOR per-packet nonce (`deriveIv`).
- **Key**: login → bootstrap key; commands → negotiated session key.
- **Checksum** = sum of bytes mod 256 (`withChecksum`).
- **Sequence** = rolling 1..255 byte, never 0.
- Login is addressed with the magic serial `BADDF00D`; the reply carries the
  16-byte session key.

Command opcodes (see `packets.ts`):

| Action        | Outer op | Inner                                           |
| ------------- | -------- | ----------------------------------------------- |
| Arm area      | 8        | `[seq,6,1,14, 5, area, 16]`                     |
| Disarm area   | 8        | `[seq,6,1,14, 16, area, 16]`                    |
| Door / output | 8        | `[seq,8,1,5, devIndex, idxHi, idxLo, state, 1]` |
| Status        | 13       | –                                               |

## ⚠️ Needs live verification

The crypto and framing are high-confidence. These are my best reading of
obfuscated code and **must be confirmed against one real packet capture**
(e.g. `adb` + tcpdump on a phone running the app) before production use:

1. Arm vs disarm **function bytes** (`AREA_FUNC_ARM=5`, `AREA_FUNC_DISARM=16`).
2. Door/output **devIndex** mapping and `state` values.
3. Login **session-key offset** and the confirm round-trip.
4. The plaintext **length high byte** (app writes `(len<<8)&0xFF` = 0; replicated).
5. Whether the **device slot** belongs in the flags byte for your panel.

Use `dryRun: true` (or `npm run bosch:dump`) to print exact bytes and diff them
against a capture first.

## Usage

```ts
import { BoschClient } from '$lib/server/bosch';

const client = new BoschClient({
	endpoint: { host: 'ap.myalarms1.com' }, // or the panel's IP
	credentials: { serialNumber: '123456', appCode: '000000', deviceId: 1 },
	log: (dir, msg) => console.log(dir, msg)
});

await client.login();
await client.disarmArea(1);
await client.openDoor(/* devIndex */ 1, /* door# */ 1);
```
