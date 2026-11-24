import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createHostSecrets,
    HostSecretError,
    HostSecretUnreadableError,
    isHostSecretName,
    memoryHostSecrets,
} from "./ncSecrets";

// A stand-in for the host: the secrets routes on a unix socket, as
// NativeCluster's host API describes them.
type Seen = { method: string; url: string; auth: string | undefined; body: string };

let dir: string;
let socketPath: string;
let server: http.Server;
let seen: Seen[];
let answer: (req: Seen) => { status: number; body?: string } | null;
const kept = new Map<string, string>();

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncs-"));
    socketPath = path.join(dir, "host.sock");
    seen = [];
    kept.clear();
    answer = () => null;
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const s: Seen = {
                method: req.method ?? "",
                url: req.url ?? "",
                auth: req.headers.authorization,
                body: Buffer.concat(chunks).toString("utf8"),
            };
            seen.push(s);
            const forced = answer(s);
            if (forced) {
                res.writeHead(forced.status, { "Content-Type": "application/json" });
                return void res.end(forced.body ?? "");
            }
            if (s.auth !== "Bearer cred-1") {
                res.writeHead(401);
                return void res.end();
            }
            const name = decodeURIComponent(s.url.replace("/host/v1/secrets/", ""));
            if (s.method === "PUT") {
                kept.set(name, (JSON.parse(s.body) as { value: string }).value);
                res.writeHead(204);
                return void res.end();
            }
            if (s.method === "DELETE") {
                kept.delete(name);
                res.writeHead(204);
                return void res.end();
            }
            if (!kept.has(name)) {
                res.writeHead(404, { "Content-Type": "application/json" });
                return void res.end('{"error":"not_found"}');
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name, value: kept.get(name) }));
        });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the host's secrets store", () => {
    it("keeps, gives and deletes a value on the host socket with the app credential", async () => {
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        await store.putSecret("mike:p_ab:mcp:00ff:access_token", "tok-1");
        expect(await store.getSecret("mike:p_ab:mcp:00ff:access_token")).toBe("tok-1");
        await store.deleteSecret("mike:p_ab:mcp:00ff:access_token");
        expect(await store.getSecret("mike:p_ab:mcp:00ff:access_token")).toBeNull();
        expect(seen.map((s) => s.method)).toEqual(["PUT", "GET", "DELETE", "GET"]);
        expect(seen.every((s) => s.auth === "Bearer cred-1")).toBe(true);
        expect(seen[0].url).toBe("/host/v1/secrets/mike%3Ap_ab%3Amcp%3A00ff%3Aaccess_token");
        expect(JSON.parse(seen[0].body)).toEqual({ value: "tok-1" });
    });

    it("reads a name nothing is kept under as none, and deleting it is no error", async () => {
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        expect(await store.getSecret("missing")).toBeNull();
        await expect(store.deleteSecret("missing")).resolves.toBeUndefined();
    });

    it("says a value this computer can no longer open is unreadable (409)", async () => {
        answer = () => ({ status: 409, body: '{"error":"unreadable"}' });
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        await expect(store.getSecret("x")).rejects.toBeInstanceOf(HostSecretUnreadableError);
    });

    it("refuses a value over 64 KiB before sending it, and passes on the host's own caps", async () => {
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        await expect(store.putSecret("big", "x".repeat(64 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
        expect(seen).toHaveLength(0);
        answer = () => ({ status: 507, body: '{"error":"store_full"}' });
        await expect(store.putSecret("n", "v")).rejects.toMatchObject({ status: 507, code: "store_full" });
    });

    it("refuses a name the host would not keep, without asking it", async () => {
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        await expect(store.putSecret("has space", "v")).rejects.toBeInstanceOf(HostSecretError);
        await expect(store.getSecret("x".repeat(129))).rejects.toBeInstanceOf(HostSecretError);
        expect(seen).toHaveLength(0);
        expect(isHostSecretName("mike:p_1:gws:ab.cd-ef_gh")).toBe(true);
    });

    it("never puts the value in an error", async () => {
        answer = () => ({ status: 500, body: "boom" });
        const store = createHostSecrets({ socketPath, credential: "cred-1" });
        const err = await store.putSecret("n", "very-secret-token").catch((e: unknown) => e);
        expect(String((err as Error).message)).not.toContain("very-secret-token");
    });

    it("says so when the host cannot be reached", async () => {
        const store = createHostSecrets({ socketPath: path.join(dir, "gone.sock"), credential: "cred-1" });
        await expect(store.getSecret("n")).rejects.toMatchObject({ code: "unreachable" });
    });

    it("has an in-memory store with the same rules", async () => {
        const store = memoryHostSecrets();
        await store.putSecret("a", "1");
        expect(await store.getSecret("a")).toBe("1");
        await store.deleteSecret("a");
        expect(await store.getSecret("a")).toBeNull();
        await expect(store.putSecret("a b", "1")).rejects.toBeInstanceOf(HostSecretError);
    });
});
