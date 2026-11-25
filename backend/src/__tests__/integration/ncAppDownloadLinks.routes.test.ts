import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The 2026-11-24 security review, L2: in Mike's NativeCluster app a
// download link was a one-hour bearer link: A's link, from the window's
// history or a paste, opened from B's window downloaded A's file. In the app
// a link now carries its person's Mike account, only that person signed in
// redeems it, and a download link lives five minutes.

vi.hoisted(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = "test-signing-secret";
});

vi.mock("../../lib/supabase", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/supabase")>()),
    createServerSupabase: vi.fn(() => ({})),
}));
// The person's account, as nc_ensure_user answers it: "user-" and their id.
vi.mock("../../lib/authNcPeople", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/authNcPeople")>()),
    ensureNcPersonAccount: vi.fn(async (_db: unknown, person: { id: string }) => ({
        ok: true,
        account: { userId: `user-${person.id}`, email: `${person.id}@people.invalid` },
    })),
}));

import { ncIngress } from "../../lib/nc/ingress";
import { runInNcRequest, setNcRequestUser } from "../../lib/nc/context";
import {
    NC_APP_DOWNLOAD_TTL_SECONDS,
    signBlobToken,
    signBlobUploadToken,
    verifyBlobToken,
} from "../../lib/downloadTokens";
import { setStorageAdapter, type StorageAdapter } from "../../lib/storage";
import { blobUploadHandler, downloadsRouter } from "../../modules/downloads/downloads.routes";
import { requireAuthInNcApp } from "../../middleware/ncApp";

const SECRET = "s".repeat(64);
const KEY = "documents/user-p_alice/d1/source.pdf";

function adapter(): StorageAdapter {
    return {
        enabled: true,
        configurationHint: "test adapter",
        uploadFile: vi.fn(),
        uploadFileFromPath: vi.fn(),
        getSignedUploadUrl: vi.fn(),
        downloadFile: vi.fn(),
        openReadStream: vi.fn(async () => (async function* () {
            yield Buffer.from("alice's file");
        })()),
        headFile: vi.fn(async () => ({ size: 12, etag: '"v1"', contentType: null })),
        listFiles: vi.fn(),
        copyFile: vi.fn(),
        deleteFile: vi.fn(),
        getSignedUrl: vi.fn(),
        writeBlobFromStream: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;
}

/** The backend as the launcher reaches it: the ingress, then the routes. */
function backend() {
    const app = express();
    app.use(ncIngress({ secret: () => SECRET }));
    app.put("/download/signed/:token", requireAuthInNcApp, blobUploadHandler);
    app.use("/download", downloadsRouter);
    return app;
}

/** A link made inside a request of `person`'s, once signed in. */
function linkFor(person: string, make: () => string): string {
    return runInNcRequest({ person, request: "r1", at: Date.now(), task: "assistant" }, () => {
        setNcRequestUser(`user-${person}`);
        return make();
    });
}

const asPerson = (req: request.Test, person: string) =>
    req.set("X-NC-Internal", SECRET).set("X-NC-Person", person).set("X-NC-Request", "r2");

let store: StorageAdapter;
beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    store = adapter();
    setStorageAdapter(store);
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("a download link in the NativeCluster app", () => {
    it("carries its person's account and lives five minutes, whatever it was asked for", () => {
        const before = Math.floor(Date.now() / 1000);
        const token = linkFor("p_alice", () => signBlobToken(KEY, "report.pdf", 3600));
        const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
        expect(payload.u).toBe("user-p_alice");
        expect(payload.e).toBeLessThanOrEqual(before + NC_APP_DOWNLOAD_TTL_SECONDS + 1);
        expect(NC_APP_DOWNLOAD_TTL_SECONDS).toBe(300);
        expect(verifyBlobToken(token)).toMatchObject({ path: KEY, user: "user-p_alice" });
    });

    it("is never made for no one", () => {
        expect(() => signBlobToken(KEY, "report.pdf", 60)).toThrow(/signed in/);
        expect(() =>
            runInNcRequest({ person: "", request: "r1", at: Date.now(), task: "assistant" }, () =>
                signBlobToken(KEY, "report.pdf", 60),
            ),
        ).toThrow(/signed in/);
        expect(() => signBlobUploadToken(KEY, "application/pdf", 12, 60)).toThrow(/signed in/);
    });

    it("downloads for its own person", async () => {
        const token = linkFor("p_alice", () => signBlobToken(KEY, "report.pdf", 3600));
        const res = await asPerson(request(backend()).get(`/download/signed/${token}`), "p_alice");
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("alice's file");
    });

    it("is refused to anyone else, and to no one, as if there were no link", async () => {
        const token = linkFor("p_alice", () => signBlobToken(KEY, "report.pdf", 3600));
        const bob = await asPerson(request(backend()).get(`/download/signed/${token}`), "p_bob");
        expect(bob.status).toBe(404);
        const nobody = await asPerson(request(backend()).get(`/download/signed/${token}`), "");
        expect(nobody.status).toBe(403);
        expect(store.openReadStream).not.toHaveBeenCalled();
    });

    it("refuses a link made without a person (another deployment's, or before this)", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        const bare = signBlobToken(KEY, "report.pdf", 3600);
        vi.stubEnv("MIKE_NC_APP", "1");
        const res = await asPerson(request(backend()).get(`/download/signed/${bare}`), "p_alice");
        expect(res.status).toBe(404);
    });

    it("uploads only for its own person", async () => {
        const token = linkFor("p_alice", () => signBlobUploadToken("staging/user-p_alice/f1", "text/plain", 5, 900));
        const bob = await asPerson(request(backend()).put(`/download/signed/${token}`), "p_bob")
            .set("Content-Type", "text/plain")
            .send("hello");
        expect(bob.status).toBe(403);
        const alice = await asPerson(request(backend()).put(`/download/signed/${token}`), "p_alice")
            .set("Content-Type", "text/plain")
            .send("hello");
        expect(alice.status).toBe(200);
    });
});

describe("a download link elsewhere", () => {
    it("is the bearer capability it always was", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        const token = signBlobToken(KEY, "report.pdf", 3600);
        const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
        expect(payload.u).toBeUndefined();
        expect(payload.e).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
        const app = express();
        app.use("/download", downloadsRouter);
        expect((await request(app).get(`/download/signed/${token}`)).status).toBe(200);
    });
});
