// The host's clock beat, for an app whose own timers do not run
// (MIKE_NC_APP=1).
//
// NativeCluster ticks a running app (`POST /nc/v1/tick` on its socket); the
// launcher forwards it to the backend, whose ingress (lib/nc/ingress.ts)
// runs the handler registered here: workerRuntime's runNativeClusterTick,
// which index.ts registers at start. Kept apart from workerRuntime so lib/
// imports nothing of jobs/ or modules/.

export function ncAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_NC_APP?.trim() === "1";
}

const TICK_PATH = "/nc/v1/tick";

export function ncTickPath(): string {
  return TICK_PATH;
}

type TickHandler = () => Promise<string[]>;
let handler: TickHandler | null = null;

export function setNcTickHandler(next: TickHandler | null): void {
  handler = next;
}

/** Run the registered beat; the sweeps it ran, by name ([] with none registered or outside the app). */
export async function runNcTick(): Promise<string[]> {
  if (!ncAppMode() || !handler) return [];
  return handler();
}
