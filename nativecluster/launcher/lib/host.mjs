// The launcher's calls to NativeCluster's host, on LB_HOST_SOCKET with the
// app credential: only the app's own secrets store (`ncdev spec hostapi`,
// "An app's own secrets (0.4.15)"). Model calls are the backend's.

import http from "node:http";

export class HostError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "HostError";
    this.status = status;
    this.code = code;
  }
}

function call(socketPath, credential, method, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: {
          Host: "host",
          Authorization: `Bearer ${credential}`,
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new HostError("the host did not answer in time", null, "timeout")));
    req.on("error", (e) => reject(e instanceof HostError ? e : new HostError(`the host could not be reached (${e.code ?? e.message})`, null, "unreachable")));
    if (data) req.write(data);
    req.end();
  });
}

function codeOf(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error === "string" ? parsed.error : typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

/** The app's secrets store. Values are never logged; errors never carry one. */
export function hostSecrets(socketPath, credential) {
  const route = (name) => `/host/v1/secrets/${encodeURIComponent(name)}`;
  return {
    /** The value, or null when none is kept. Throws HostError, `unreadable` on a 409. */
    async get(name) {
      const r = await call(socketPath, credential, "GET", route(name));
      if (r.status === 404) return null;
      if (r.status === 409) throw new HostError(`the host can no longer read the secret ${name}`, 409, "unreadable");
      if (r.status !== 200) throw new HostError(`the host answered ${r.status} for the secret ${name}`, r.status, codeOf(r.body));
      let value;
      try {
        value = JSON.parse(r.body)?.value;
      } catch {}
      if (typeof value !== "string") throw new HostError(`the host's answer for the secret ${name} had no value`, 200, null);
      return value;
    },
    async put(name, value) {
      const r = await call(socketPath, credential, "PUT", route(name), { value });
      if (r.status !== 204 && r.status !== 200) throw new HostError(`the host would not keep the secret ${name} (${r.status})`, r.status, codeOf(r.body));
    },
  };
}

/**
 * Mike's own upkeep schedule, for no person (`"person": ""`): once a day on
 * this computer's clock, and once when it starts again if it was off then.
 * Its firing runs the backend's sweeps (stalled work, retention, old
 * exports), as the host's beat does while Mike runs. Ids and numbers only.
 */
export const UPKEEP_TRIGGER = "upkeep";
export const UPKEEP_ROW = { ID: "upkeep:1", Trigger: UPKEEP_TRIGGER, Spec: { hour: 3, minute: 30, weekdays: "1111111" }, Enabled: true };

export async function setUpkeepSchedule(socketPath, credential) {
  const r = await call(socketPath, credential, "POST", "/host/v1/triggers/table/set", { person: "", list: [UPKEEP_ROW] });
  if (r.status !== 200 && r.status !== 204) throw new HostError(`the host would not keep Mike's upkeep schedule (${r.status})`, r.status, codeOf(r.body));
}
