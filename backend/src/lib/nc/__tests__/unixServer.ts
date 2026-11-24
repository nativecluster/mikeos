// A real HTTP server on a unix socket in a temp folder, for the NativeCluster
// plumbing tests. Not a test file itself (no .test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

export type UnixServer = {
  socketPath: string;
  seen: Seen[];
  close(): Promise<void>;
};

/** A short temp folder: a socket's path holds about 100 bytes on macOS. */
export function socketDir(): string {
  const base = tmpdir().length > 60 ? "/tmp" : tmpdir();
  return mkdtempSync(path.join(base, "ncs-"));
}

export async function startUnixServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
  options: { dir?: string; name?: string; readBody?: boolean } = {},
): Promise<UnixServer> {
  const dir = options.dir ?? socketDir();
  const socketPath = path.join(dir, options.name ?? "s.sock");
  const seen: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (req, res) => {
    let body = "";
    if (options.readBody !== false) {
      for await (const chunk of req) body += String(chunk);
    }
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    try {
      await handler(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    seen,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
