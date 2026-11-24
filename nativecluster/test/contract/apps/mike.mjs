// The contract tests' hooks for Mike packaged as a NativeCluster app.
//
// Pablo, 2026-11-24: NativeCluster is Mike's only login. Each NativeCluster
// person (the ticket's person, which the launcher passes to the backend as
// X-NC-Person) is a Mike account of its own, made on first use; a request
// naming nobody is refused 403, "Sign in to NativeCluster to use Mike." So a
// person here is a ticket and nothing else: no Mike session, no sign-in.
//
// Chosen for a package whose manifest id or name says Mike (harness.mjs).
// The launcher proxies /api/* to the backend, the prefix stripped
// (/api/health is the backend's /health; /api/projects its /projects).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const name = "mike";
export const NOBODY_WORDS = "Sign in to NativeCluster to use Mike.";

/** Up once the backend answers through the launcher. */
export async function ready(host) {
  const deadline = Date.now() + 300000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await host.request("GET", "/api/health", { as: "alice", timeoutMs: 10000 });
      if (r.status === 200) return r.json;
      last = `${r.status} ${r.text.slice(0, 100)}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error(`Mike's backend did not answer /api/health within 300 s (last: ${last})`);
}

const projectNames = async (host, as, headers = {}) => {
  const r = await host.request("GET", "/api/projects", { as, headers });
  if (r.status !== 200) throw new Error(`GET /api/projects as ${as ?? "nobody"} answered ${r.status}: ${r.text.slice(0, 200)}`);
  return (Array.isArray(r.json) ? r.json : (r.json?.projects ?? [])).map((p) => p.name);
};

/** A project of alice's, made through the API as the frontend makes one. */
export async function seed(host) {
  const name = `contract ${Date.now()}`;
  const r = await host.request("POST", "/api/projects", { as: "alice", body: { name } });
  if (r.status >= 300) throw new Error(`POST /api/projects answered ${r.status}: ${r.text.slice(0, 200)}`);
  if (!(await projectNames(host, "alice")).includes(name)) throw new Error("alice's new project is not in her list");
  return { name };
}

/** After the restart: alice still has it, bob never saw it, nobody gets 403. */
export async function kept(host, { name }) {
  if (!(await projectNames(host, "alice")).includes(name)) throw new Error(`alice's project "${name}" was gone after the restart`);
  if ((await projectNames(host, "bob")).includes(name)) throw new Error(`bob sees alice's project "${name}"`);
  const nobody = await host.request("GET", "/api/projects", { as: null });
  if (nobody.status !== 403 || !nobody.text.includes(NOBODY_WORDS)) {
    throw new Error(`a request naming nobody answered ${nobody.status} ${nobody.text.slice(0, 200)}, not 403 "${NOBODY_WORDS}"`);
  }
}

/**
 * Forged X-NC-* headers reach the launcher (the real host passes them on):
 * the backend must still act for the ticket's person, never the forged one.
 */
export async function forgedHeaders(host, forged) {
  const { name } = await seed(host);
  const alice = host.person("alice");
  if (!(await projectNames(host, "alice", forged)).includes(name)) throw new Error("alice, with forged X-NC-* headers naming bob, lost her own project");
  if ((await projectNames(host, "bob", { ...forged, "x-nc-person": alice.id })).includes(name)) throw new Error("bob, forging X-NC-Person as alice, saw alice's project");
  const nobody = await host.request("GET", "/api/projects", { as: null, headers: { ...forged, "x-nc-person": alice.id } });
  if (nobody.status !== 403) throw new Error(`a ticket naming nobody, forging X-NC-Person as alice, answered ${nobody.status}`);
}

/** Requests a browser makes, so the sandbox sees the stack at work. */
export async function exercise(host) {
  for (const p of ["/", "/assistant", "/projects", "/api/health"]) {
    const r = await host.request("GET", p, { as: "alice" });
    if (r.status >= 500) throw new Error(`GET ${p} answered ${r.status}`);
  }
  await seed(host);
}

// Mike's model calls are driven by the e2e specs (chat-fake, tabular-fake),
// which check the same ledger.
export const drive = null;

export const expectedDenials = [];
