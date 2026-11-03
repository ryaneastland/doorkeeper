# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DoorKeeper is a SvelteKit 2 / Svelte 4 app that gives brigade members a simple door-opening UI over an alarm/access panel. The panel backend is a pluggable **door provider** (`DOOR_PROVIDER`): `inner-range` (default — the Inner Range Inception / SkyCommand REST API, deploys serverless to Netlify) or `bosch` (Bosch Solution panels via the myAlarm UDP protocol, needs one persistent Node server — see `docs/BOSCH-INTEGRATION.md`). Supabase provides auth (email/password + OTP, PKCE flow for SSR) and stores profiles and audit logs.

## Commands

```bash
npm run dev          # vite dev --open --port 5174
npm run build        # vite build -> build/
npm run preview
npm run check        # svelte-kit sync && svelte-check (the only "test" available)
npm run check:watch
npm run lint         # prettier --check . && eslint .
npm run format       # prettier --write .
```

There is **no test framework** in this project. `npm run check` is the closest thing to a test suite — it currently passes with 0 errors and 5 warnings, so treat any new error as a regression.

See `AGENTS.md` for the code style contract (tabs, single quotes, no trailing commas, 100 cols, import ordering, `satisfies` on load/actions, component script section order). Don't duplicate that guidance here.

## Environment Variables

```bash
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
PRIVATE_SUPABASE_SERVICE_KEY    # service role key — server-only ($env/static/private)
PUBLIC_SITE_NAME                # shown in the heading and location messages (default Moorooduc Fire Station)
PUBLIC_SITE_LATITUDE            # site coords for the proximity check
PUBLIC_SITE_LONGITUDE
PUBLIC_SITE_RADIUS_METRES       # geofence radius, defaults to 300 if unset-but-invalid
PUBLIC_SITE_MAX_ACCURACY_METRES # reject vaguer fixes than this, defaults to 100
PUBLIC_GEOFENCE_DISABLED        # 'true' skips the proximity check — local dev only

DOOR_PROVIDER                   # inner-range (default) | bosch
ADAPTER                         # optional build override: netlify | node (default follows DOOR_PROVIDER)
DOORS                           # JSON door list; optional for inner-range, required for bosch

PRIVATE_INCEPTION_USERNAME      # inner-range
PRIVATE_INCEPTION_PASSWORD
PRIVATE_INCEPTION_BASE_URL      # e.g. https://skytunnel.com.au/inception/<serial>

BOSCH_HOST BOSCH_PORT BOSCH_SERIAL BOSCH_APPCODE BOSCH_DEVICEID BOSCH_USERPIN   # bosch
```

`.env.example` lists them all with comments. The site, geo and provider vars are read via `$env/dynamic/*`, so they are optional at build time; a Bosch build does not need the Inception vars and vice versa.

⚠️ The Supabase service role key must stay `PRIVATE_`: a `PUBLIC_` var is inlined into client bundles. Never hard-code panel credentials (serial, PIN, app code) anywhere — the repo is public; scripts read them from `.env`.

## Architecture

### Three Supabase clients — pick deliberately

This is the single most important thing to understand before editing server code. The codebase has three distinct clients and they are **not** interchangeable:

1. **`locals.supabase`** — created per-request in `src/hooks.server.ts` via `createServerClient` with cookie get/set/remove. This is the only client bound to the caller's session. Use it for anything acting *as the user* (sign in, sign up, OTP, password reset). `locals.getSession()` is the convenience wrapper.
2. **`$lib/supabaseClient`** — a module-level anon client with **no session attached**. Used today for `entry_logs` / `invite_logs` inserts and `profiles` reads/writes. Anything written through it runs as anon and depends entirely on permissive RLS — this is why admin checks and audit inserts work without a user JWT.
3. **`serviceSupabase` (`$lib/utils/serviceSupabase.ts`)** and the ad-hoc `createClient(url, PRIVATE_SUPABASE_SERVICE_KEY)` calls in the admin routes — service role, bypasses RLS. Needed for `auth.admin.*` operations (invite, listUsers, deleteUser) and the `otp_codes` table.

Client-side, `src/routes/+layout.ts` builds a `createBrowserClient` with hand-rolled `document.cookie` handling and exposes it as `data.supabase`.

### Auth flows (there are several, overlapping)

- **Password login** — `(auth)/login` `login` action → `signInWithPassword` → redirect `/control`.
- **OTP code login** — `(auth)/login` `sendOtp` action → `signInWithOtp({ shouldCreateUser: false })` → redirect to `/verify-otp?email=…`. Built because corporate mail scanners (Mimecast) consume magic-link tokens; see `CORPORATE_EMAIL_SETUP.md`.
- **PKCE email callback** — `GET /api/auth/callback` exchanges `?code` for a session (`exchangeCodeForSession`) and redirects to `?next`. Failures land on `/auth-code-error`.
- **Legacy password-reset token check** — `POST /api/auth/callback` calls `verifyOtp` and then **sets a `session` cookie by hand**, which fights `@supabase/ssr`'s cookie management. This is a known defect (Task 1 in `IMPROVEMENT_TASKS.md`), not a pattern to copy.
- **Custom OTP table** — `$lib/utils/customOtp.ts` + the `otp_codes` table (`supabase_otp_table.sql`) implement a self-managed 6-digit code path. It is currently **not wired into the login route**; check before assuming it runs.

`hooks.server.ts` sets `secure: false` on session cookies with a "set to true in production" comment — still unresolved.

### Authorisation

- Session guard: every protected `+page.server.ts` `load` calls `locals.getSession()` and redirects to `/login` (or `/`) when null. There is no global guard in hooks — a new protected route must add its own check.
- Admin guard: `(admin)/admin/+layout.server.ts` reads `profiles.site_admin` and `error(403, …)` if false. `src/routes/+layout.server.ts` separately fetches the same flag so the navbar can show admin links.

### Door control path

`control/+page.server.ts` is the core of the app. It never talks to a panel directly: it calls the **door provider** from `getDoorProvider()` in `$lib/server/doors` (selected by `DOOR_PROVIDER`, created once per process, lazily imported so a serverless Inner Range build never loads the Bosch UDP code). The `DoorProvider` interface (`doors/types.ts`) is `doors`, `open(door)`, optional `status()` / `arm()`, and `capabilities` (`status`, `arm`, `autoRelock`) that the page uses to decide whether to show the panel status line, the Arm button and re-lock polling.

1. `load` returns the provider's door list (`id`, `name`, `icon`) and capabilities.
2. The `control` action looks the door up **server-side by id** (the client's door name/target is never trusted), runs `checkReportedLocation()`, calls `provider.open(door)`, and writes `entry_logs` for both outcomes via the anon client. `arm` exists only for providers with `arm()`. `GET /control/status` returns live state for providers with `status()`.
3. **inner-range** (`doors/inner-range.ts`): `inceptionAuthService.authenticate()` POSTs the Inception credentials to `{PRIVATE_INCEPTION_BASE_URL}/api/v1/authentication/login` and caches the returned `UserID` with a 10-minute TTL; the token goes in `Cookie: LoginSessId=<token>` on `POST {base}/api/v1/control/door/{guid}/activity` with `{ Type: 'ControlDoor', DoorControlType: 'Open' }`. Doors come from `DOORS`, else default to the three `DOOR_GUIDS` in `src/lib/common/constants.ts`.
4. **bosch** (`doors/bosch.ts`): disarms every armed area (verifying it took), pulses the door, and confirms the lock state, all through the single shared panel session in `$lib/server/bosch/manager.ts`. It refuses to start on serverless hosts. Protocol details and gotchas: `docs/BOSCH-INTEGRATION.md`.

`svelte.config.js` picks the adapter from `DOOR_PROVIDER` (`adapter-netlify` for inner-range, `adapter-node` for bosch; `ADAPTER` overrides, and Bosch on Netlify is a build error).

The geofence is enforced in **both** places, and the shared maths lives in `$lib/common/geo.ts`: `calculateDistance`, plus `SITE_MAX_DISTANCE_METRES` and `MAX_LOCATION_ACCURACY_METRES`, which are read from `PUBLIC_SITE_RADIUS_METRES` / `PUBLIC_SITE_MAX_ACCURACY_METRES` so the fence can be tuned per environment without a code change (falling back to 300 m / 100 m on a missing or invalid value). Note the dev `.env` typically points the site coords at a developer's own location (or sets `PUBLIC_GEOFENCE_DISABLED=true`), so **the denial path never fires locally** — change a coord to test it.

- `control/+page.svelte` checks proximity on mount to decide whether to render the door buttons, and sends a fresh fix (`latitude`, `longitude`, `accuracy`) with every open request. This half is UX.
- `checkReportedLocation()` in `control/+page.server.ts` re-runs the check on those reported values and `fail(403)`s before touching the door provider. It also rejects vague fixes (`accuracy` > 100 m) and implausible jumps between a user's consecutive reports, tracked in a module-level `Map` (best-effort — empty on cold start, not shared across serverless instances). Denied attempts are written to `entry_logs` with `status: false`.

⚠️ The browser still supplies the coordinates, so a caller who spoofs their position passes both checks. This raises the cost of a bypass and creates an audit trail; it is **not** proof of presence. Don't describe it as a hard access control — the real boundary is who holds a Supabase account. A network- or hardware-based proximity factor isn't available at this site.

### Supabase tables in use

`profiles` (`id`, `email`, `site_admin`), `entry_logs`, `invite_logs` (`invited_address`, `invited_by`), `otp_codes`. Only `otp_codes` has committed DDL (`supabase_otp_table.sql`); the rest live only in the hosted project.

`src/app.d.ts` imports `Database` from `./DatabaseDefinitions`, **but that file does not exist**, so `SupabaseClient<Database>` gives no real table typing. Creating `src/DatabaseDefinitions.ts` (Supabase-generated types) would light up type checking across every query.

### Misc

- Version display: `svelte.config.js` and `vite.config.ts` both read `package.json` at build time — `version.name` for SvelteKit and a `PKG` define for the app. Bump `package.json` `version` when you want the UI's version string to change.
- `src/service-worker/index.js` exists but is *not* at `src/service-worker.ts`, so SvelteKit does not auto-register it.
- Reference docs in the repo: `IMPROVEMENT_TASKS.md` (known defects with file:line), `CORPORATE_EMAIL_SETUP.md`, `EMAIL_TEMPLATES.md` (Supabase dashboard email templates that must match `/api/auth/callback`).
