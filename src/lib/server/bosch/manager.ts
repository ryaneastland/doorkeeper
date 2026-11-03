// Single shared connection to the Bosch panel for the whole server process.
//
// The panel/relay allows only ONE session per device, so every request must go
// through this one connection. Operations are serialized (mutex) so commands
// never interleave on the shared socket, and the connection is reused across
// users/requests, reconnecting transparently when idle or on error.
import { env } from '$env/dynamic/private';
import { BoschClient } from './index';
import { loadSession } from './session-store';

const IDLE_MS = 45_000; // proactively reconnect a session idle longer than this

class BoschManager {
	private client: BoschClient | null = null;
	private lastUsed = 0;
	private tail: Promise<unknown> = Promise.resolve();

	/** Run an operation with exclusive, serialized access to the shared client. */
	run<T>(fn: (client: BoschClient) => Promise<T>): Promise<T> {
		const job = this.tail.then(async () => {
			await this.ensure();
			try {
				const out = await fn(this.client!);
				this.lastUsed = Date.now();
				return out;
			} catch (e) {
				this.drop(); // force a fresh connect next time
				throw e;
			} finally {
				// a timed-out read may have been swallowed by fn; don't keep reusing
				// a session the panel has stopped answering
				if (this.client?.needsReconnect) this.drop();
			}
		});
		this.tail = job.then(
			() => undefined,
			() => undefined
		);
		return job as Promise<T>;
	}

	/** True once a usable session exists (for the page to show "connected"). */
	get connected(): boolean {
		return !!this.client?.sessionKeyHex && Date.now() - this.lastUsed < IDLE_MS;
	}

	private async ensure(): Promise<void> {
		if (this.client && Date.now() - this.lastUsed < IDLE_MS) return;
		this.drop();
		const s = loadSession();
		if (!s?.sessionKeyHex) throw new Error('site not registered — run setup first');
		const client = new BoschClient({
			endpoint: {
				host: env.BOSCH_HOST ?? 'ap.myalarms1.com',
				port: Number(env.BOSCH_PORT ?? 9050),
				timeoutMs: 6000
			},
			credentials: {
				serialNumber: env.BOSCH_SERIAL ?? '',
				appCode: env.BOSCH_APPCODE ?? '',
				deviceId: Number(env.BOSCH_DEVICEID ?? 0),
				userPin: env.BOSCH_USERPIN || undefined
			}
		});
		client.restore(s.sessionKeyHex, s.feature);
		const c = await client.connect();
		if (!c.ok) {
			client.close();
			throw new Error(`connect failed: ${c.error}`);
		}
		this.client = client;
		this.lastUsed = Date.now();
	}

	private drop(): void {
		try {
			this.client?.close();
		} catch {
			/* ignore */
		}
		this.client = null;
	}
}

// One instance per server process (adapter-node). Survives across requests.
export const bosch = new BoschManager();
