# DoorKeeper — Bosch / myAlarm integration

DoorKeeper supports two door backends ("providers"), picked with `DOOR_PROVIDER`:

| `DOOR_PROVIDER`         | Panel                         | Hosting                              |
| ----------------------- | ----------------------------- | ------------------------------------ |
| `inner-range` (default) | Inner Range Inception (REST)  | Serverless (Netlify) — as before     |
| `bosch`                 | Bosch Solution via myAlarm    | One persistent Node process          |

This document covers the **Bosch** provider: a from-scratch client that speaks the
**myAlarm iFob** panel protocol, reverse-engineered from the Android app
(`au.com.myalarm.ifob_control`). Everything else (Supabase auth, admin, entry
logging, geofence) is shared with the Inner Range setup.

> Only operate panels you are authorised to control. The server holds the keys
> that can disarm the alarm — keep it locked down.

---

## Architecture

```
Browser ──HTTPS──▶ SvelteKit (adapter-node, one persistent process)
                     │  Supabase: auth, profiles/roles, entry_logs, invite_logs
                     │
                     └─ doors provider "bosch" ─ bosch/manager (ONE shared connection) ──UDP:9050──▶ relay ──▶ panel
```

- **adapter-node** (not Netlify) — the panel protocol is **UDP**, so a persistent
  server process is required; serverless can't hold UDP sockets. `svelte.config.js`
  picks adapter-node automatically when `DOOR_PROVIDER=bosch`, and refuses to build
  Bosch for serverless.
- **Single shared connection** (`src/lib/server/bosch/manager.ts`): the panel/relay
  allows **only one session per device**. Every request goes through
  `bosch.run(fn)`, which serializes commands with a promise-chain mutex and reuses
  one connection (reconnects after 45s idle or on error). Verified: 5 concurrent
  users → 1 connection.

## The protocol (summary)

Full detail in the reverse-engineering notes; the essentials:

- **Transport:** UDP, panel port **9050**. Reached via the cloud relay
  `ap.myalarms1.com` (AU) / `eu.myalarms1.com` (EU) or a direct panel IP.
- **Crypto:** AES-128-CBC. IV = a fixed base XOR a per-packet random nonce.
  Wire packet = `[9-byte clear header][AES ciphertext]`; TX uses PKCS#7, RX
  NoPadding; each inner frame carries a sum-mod-256 checksum.
- **Keys:** login (opcode 12) uses an app-wide **hardcoded bootstrap key**; the
  panel then returns a 16-byte **session key C**. After connect, an **op5 rekey**
  returns a **command key D** used for all op8 commands.
- **Registration is one-time:** the **Panel App Code is single-use** — completing
  login consumes it and the panel issues a new one. So we **register once**, save
  key **C** (`.bosch-session.json`), and every later session just **reconnects**
  with C (op13 connect → op5 rekey → D). No app-code burn after the first.
- **Flags byte:** low 5 bits = device ID, high 3 bits = slot (0 for connect/rekey,
  1 for commands).

### Commands (all confirmed live)

| Action | Encoding |
|--------|----------|
| Disarm area | `d()` func **3**, mode 0 |
| Arm all-on | `d()` func **4**, mode 16 (panel refuses if a zone isn't ready) |
| Arm part 1 / 2 | func **5** / func **16**, mode 16 |
| Unlock door | `d()` func **14**, mode 0 |
| Lock door | `d()` func **15**, mode 0 |
| Operate door (pulse) | `d()` func **13**, mode 0 (confirmed by app capture; panel auto-relocks ~8s) |

### Status reads

- **Area armed state:** query `e(3, areaN)` → reply byte6 = areaN (echoed), byte18 =
  state code (2=DISARMED, 3=ARMED_ALL_ON, 4/5=ARMED_PART_1/2, 6=ARMED, 1=OFF_LINE,
  0=NOT_USED). Byte8 is *not* the area index — it follows the state (01 disarmed,
  03 armed), which once made disarm target "area 3".
- **Refusals:** missing areas and rejected commands reply with type `0x82`, sometimes
  with text (e.g. "User Not Assigned to Area"). The client reports these as failures.
- **Door lock state:** query `e(22, doorN)` → reply byte8 bitfield; **bit 0x02 set
  = unlocked** (0x05=locked, 0x07=unlocked). Real doors report raw 5/7; empty
  indices report raw 4.

## Key files

- `src/lib/server/doors/` — the provider interface (`types.ts`), `DOORS` parsing
  (`config.ts`), provider selection (`index.ts`), and the two providers
  (`inner-range.ts`, `bosch.ts`: disarm-all → operate, arm, live status).
- `src/lib/server/bosch/` — the protocol client (`crypto`, `packets`, `client`,
  `session-store`) and `manager.ts` (single shared connection + mutex).
- `src/routes/control/` — the door page (geofence, async status, Arm, per-door open);
  status, Arm and re-lock polling only appear for providers that support them.
- `supabase/schema.sql` — DB schema (profiles / entry_logs / invite_logs + trigger; RLS off).
- `scripts/` — CLI tools (all read `.env`; never hard-code credentials, the repo is
  public): `bosch-register.ts`, `bosch-status.ts`, `bosch-dump.ts`, `decode-capture.ts`.

## Setup

1. **`.env`** — copy `.env.example`, set `DOOR_PROVIDER=bosch` and the `BOSCH_*`,
   `PUBLIC_SUPABASE_*`, `PRIVATE_SUPABASE_SERVICE_KEY` and `PUBLIC_SITE_*` vars. The
   geofence is on unless `PUBLIC_GEOFENCE_DISABLED=true` (local development only).
   > The Supabase **secret** key is a `PRIVATE_` var (server-only) — never `PUBLIC_`,
   > or it leaks to every browser.
2. **Run `supabase/schema.sql`** in the Supabase SQL editor, then make yourself admin:
   `update public.profiles set site_admin = true where email = 'you@...';`
3. **Register the site once** (burns one app code) to create `.bosch-session.json`
   with key C: stop the server, then `npm run bosch:register -- --yes`. Keep that file
   safe — it controls the panel, and losing it means re-registering with a new code.
   `npm run bosch:status` is a read-only check that it works.
4. **Configure doors** with `DOORS` in `.env` — a JSON array, one entry per door:
   `DOORS=[{"id":"front","name":"Front Door","target":1,"icon":"door"}]`. `id` is
   what's stored in `entry_logs`; `target` is the panel's door number; `icon` is
   `door` or `roller`.
5. `npm install && npm run dev`. Production: `npm run build && node build`
   (one process only — never scale it out).

## Gotchas

- **One session per device** — never run a second client (e.g. a CLI test) against
  the same device while the server is connected; they fight and cause reconnects/slowness.
- **App code is single-use** — each full login rotates it. Don't re-login; reconnect
  with the saved key C.
- **Panel structure is cached** (area names) so status reads stay ~0.7s; the control
  page loads instantly and fetches status async.
- **Door auto-enumeration** (DETY type 34/6) doesn't respond on this protocol, so
  doors are config-driven via `DOORS` (like the original's hardcoded GUIDs).
