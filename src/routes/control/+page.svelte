<script lang="ts">
	import { deserialize } from '$app/forms';
	import { onDestroy, onMount } from 'svelte';
	import { DoorOpen, Warehouse } from 'lucide-svelte';
	import { toast } from '@zerodevx/svelte-toast';
	import {
		GEOFENCE_DISABLED,
		MAX_LOCATION_ACCURACY_METRES,
		SITE_MAX_DISTANCE_METRES,
		SITE_NAME,
		calculateDistance
	} from '$lib/common/geo';
	import { getUserLocation, type UserPosition } from '$lib/services/locationService';
	import Notification from '$lib/components/Notification.svelte';
	import { PUBLIC_SITE_LATITUDE, PUBLIC_SITE_LONGITUDE } from '$env/static/public';

	export let data;

	const icons = { door: DoorOpen, roller: Warehouse };
	const { capabilities } = data;

	// --- location (UX only: the control action repeats this check and is what gates the door) ---

	let isLocationValid = false;
	let userLocation: UserPosition | null = null;
	let userLocationError = '';

	const targetLocation = {
		latitude: Number(PUBLIC_SITE_LATITUDE), // Set in environment variable so location stays secret
		longitude: Number(PUBLIC_SITE_LONGITUDE)
	};

	async function checkLocation() {
		if (GEOFENCE_DISABLED) {
			isLocationValid = true;
			return;
		}
		try {
			userLocation = await getUserLocation();
			if (!userLocation) {
				userLocationError = 'Could not determine your location.';
				return;
			}

			const distance = calculateDistance(
				userLocation.latitude,
				userLocation.longitude,
				targetLocation.latitude,
				targetLocation.longitude
			);

			isLocationValid =
				distance <= SITE_MAX_DISTANCE_METRES &&
				userLocation.accuracy <= MAX_LOCATION_ACCURACY_METRES;

			if (!isLocationValid) {
				userLocationError =
					userLocation.accuracy > MAX_LOCATION_ACCURACY_METRES
						? `Your location is not accurate enough to confirm you are at ${SITE_NAME}.`
						: `You are not within range of ${SITE_NAME}.`;
			}
		} catch (error) {
			console.error('Error checking location proximity:', error);
			userLocationError = 'Could not determine your location.';
		}
	}

	// --- live panel status (providers with capabilities.status, e.g. Bosch) ---

	let areas: { name: string; state: string }[] = [];
	let doors = data.doors;
	let statusLoading = capabilities.status;
	let statusError: string | null = null;

	// While the panel can't be read, keep retrying in the background so the page recovers by
	// itself (the server reconnects on the next request).
	const ERROR_RETRY_MS = 10_000;
	let errorRetry: ReturnType<typeof setTimeout> | undefined;

	async function refreshStatus() {
		if (!capabilities.status) return;
		clearTimeout(errorRetry);
		statusLoading = true;
		try {
			const res = await fetch('/control/status');
			const s = await res.json();
			if (s.connected) {
				areas = s.areas ?? [];
				if (s.doors?.length) {
					// keep config fields (icon) and overlay the live lock state
					doors = doors.map((d) => ({
						...d,
						locked: s.doors.find((x: { id: string }) => x.id === d.id)?.locked ?? null
					}));
				}
				statusError = null;
			} else {
				statusError = s.error ?? 'panel offline';
			}
		} catch (e) {
			statusError = (e as Error).message;
		} finally {
			statusLoading = false;
			if (statusError) errorRetry = setTimeout(refreshStatus, ERROR_RETRY_MS);
		}
	}

	// After an open, a provider that re-locks by itself (~8 s for Bosch) is polled until every
	// door reads locked again, or we give up.
	let relockPoll: ReturnType<typeof setTimeout> | undefined;
	function watchForRelock(tries = 10) {
		clearTimeout(relockPoll);
		relockPoll = setTimeout(async () => {
			await refreshStatus();
			if (tries > 1 && doors.some((d) => d.locked === false)) watchForRelock(tries - 1);
		}, 2500);
	}

	function onVisible() {
		if (document.visibilityState === 'visible' && isLocationValid && !busy) refreshStatus();
	}

	onMount(async () => {
		await checkLocation();
		if (isLocationValid) refreshStatus();
	});

	onDestroy(() => {
		clearTimeout(errorRetry);
		clearTimeout(relockPoll);
	});

	// --- actions ---

	function notify(ok: boolean, msg: string) {
		toast.push(
			msg,
			ok
				? { duration: 4500, classes: ['success'] }
				: {
						duration: 6000,
						classes: ['error'],
						theme: {
							'--toastBackground': '#dc2626',
							'--toastColor': '#fff',
							'--toastBarBackground': '#7f1d1d'
						}
					}
		);
	}

	/** POST a form action and return whether it succeeded, with the server's error if not. */
	async function postAction(action: string, body: FormData): Promise<{ ok: boolean; error?: string }> {
		const res = await fetch(action, { method: 'POST', body });
		const result = deserialize<{ success?: boolean }, { error?: string }>(await res.text());
		if (result.type === 'success') return { ok: !!result.data?.success };
		if (result.type === 'failure') return { ok: false, error: result.data?.error };
		if (result.type === 'redirect') {
			return { ok: false, error: 'Your session has expired. Please log in again.' };
		}
		return { ok: false, error: result.error?.message ?? 'Server error' };
	}

	// One request at a time: every button is disabled while a command is in flight ('arm' or the
	// door id), so presses can't stack up behind each other.
	let busy: string | null = null;
	// briefly highlight the door that just opened
	let openedId: string | null = null;
	let openedTimer: ReturnType<typeof setTimeout> | undefined;

	async function handleOpen(id: string, name: string) {
		if (busy) return;
		busy = id;
		try {
			const body = new FormData();
			body.append('doorId', id);

			if (!GEOFENCE_DISABLED) {
				// Send a current fix with the request; the server re-checks it.
				const position = await getUserLocation(30000);
				if (!position) {
					notify(false, 'Could not confirm your location. Allow location access and try again.');
					return;
				}
				userLocation = position;
				body.append('latitude', String(position.latitude));
				body.append('longitude', String(position.longitude));
				body.append('accuracy', String(position.accuracy));
			}

			const { ok, error } = await postAction('?/control', body);
			notify(ok, ok ? `${name}: opened` : `${name}: ${error ?? 'failed to open'}`);
			if (ok) {
				openedId = id;
				clearTimeout(openedTimer);
				openedTimer = setTimeout(() => (openedId = null), 3000);
			}
		} catch (e) {
			notify(false, `Error: ${(e as Error).message}`);
		} finally {
			busy = null;
		}
		await refreshStatus();
		if (capabilities.autoRelock) watchForRelock();
	}

	async function handleArm() {
		if (busy) return;
		busy = 'arm';
		try {
			const { ok, error } = await postAction('?/arm', new FormData());
			notify(ok, ok ? 'Site armed' : `Arm failed: ${error ?? 'a zone may be open'}`);
		} catch (e) {
			notify(false, `Error: ${(e as Error).message}`);
		} finally {
			busy = null;
		}
		refreshStatus();
	}
</script>

<svelte:document on:visibilitychange={onVisible} />

{#if isLocationValid}
	<div class="flex min-h-screen flex-col items-center px-8 py-8">
		<h1 class="mb-4 w-full text-center text-3xl font-bold">{SITE_NAME}</h1>
		<h2 class="mb-4 text-2xl font-bold">Available Doors</h2>
		<p class="mb-4 text-lg">
			Tap button to open door.{capabilities.arm ? ' The site is disarmed first if armed.' : ''}
		</p>

		{#if capabilities.status}
			<div class="mb-4 text-center text-sm">
				{#if statusLoading && !areas.length && !statusError}
					<span class="animate-pulse opacity-60">Reading panel…</span>
				{:else if statusError}
					<span class="text-red-600">Panel: {statusError}</span>
					<span class="ml-1 opacity-60">{statusLoading ? '· retrying…' : '· retrying shortly'}</span>
				{:else}
					{#each areas as a}
						<span class="mx-2"
							>{a.name}:
							<span
								class={a.state === 'DISARMED'
									? 'font-semibold text-green-600'
									: 'font-semibold text-orange-600'}>{a.state}</span
							>
						</span>
					{/each}
				{/if}
			</div>
		{/if}

		{#if capabilities.arm}
			<button
				type="button"
				class="mb-6 rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
				on:click={handleArm}
				disabled={!!busy}
			>
				{busy === 'arm' ? 'Arming…' : '🛡️ Arm Site'}
			</button>
		{/if}

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each doors as { id, name, icon, locked } (id)}
				<button
					type="button"
					class="focus:shadow-outline flex flex-col items-center rounded-lg bg-blue-500 px-6 py-9 font-bold text-white shadow-lg transition-colors duration-300 focus:outline-none enabled:hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 {id ===
					openedId
						? '!bg-green-500'
						: ''}"
					on:click={() => handleOpen(id, name)}
					disabled={!!busy}
					aria-busy={busy === id}
				>
					<svelte:component
						this={icons[icon]}
						class="mx-auto mb-2 h-8 w-8 text-white {busy === id ? 'animate-pulse' : ''}"
					/>
					{busy === id ? 'Opening…' : name}
					{#if locked !== null && locked !== undefined}
						<span class="mt-1 text-xs font-normal opacity-90"
							>{locked ? '🔒 locked' : '🔓 unlocked'}</span
						>
					{/if}
				</button>
			{/each}
		</div>
	</div>
	<Notification />
{:else}
	<div class="flex min-h-screen items-center justify-center">
		<div class="mx-auto max-w-md rounded-lg border-2 border-red-600 bg-red-100 p-6 text-center">
			<h1 class="mb-2 text-3xl font-bold text-red-600">Access Denied</h1>
			<p class="mb-2 text-lg text-black">You are not within range of {SITE_NAME}.</p>

			{#if userLocationError}
				<div class="rounded-lg border-2 border-red-600 bg-red-200 p-4 text-red-800">
					<p>{userLocationError}</p>
					{#if userLocation}
						<p>
							User's last known location: Latitude {userLocation.latitude}, Longitude {userLocation.longitude}
						</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>
	<Notification />
{/if}
