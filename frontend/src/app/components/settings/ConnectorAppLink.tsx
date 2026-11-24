"use client";

// Linking a connector's account inside Mike's NativeCluster app
// (NEXT_PUBLIC_MIKE_NC_APP=1). The app's window opens a link to another site
// in the person's default browser and opens no popup, and nothing the
// browser lands on reaches the app (it does not trust NativeCluster's
// certificate and is not signed in to NativeCluster). So the person either
// types a code at the service (the device grant), or approves there and
// pastes back the address the browser landed on. Meanwhile the page also
// watches for the connection to appear, in case the browser did reach Mike.

import { useState, useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import {
  completeGoogleAuthorizationFromAddress,
  completeMcpAuthorizationFromAddress,
  pollMcpDeviceAuthorization,
  type GoogleLinkProvider,
  type McpDeviceAuthorization,
} from "@/app/components/settings/ConnectorAppApi";

export type AppLinkRequest =
  | {
      kind: "mcp";
      connectorId: string;
      name: string;
      authorizationUrl: string | null;
      device: McpDeviceAuthorization | null;
    }
  | {
      kind: "google";
      provider: GoogleLinkProvider;
      name: string;
      authorizationUrl: string;
    };

/** The person cancelled linking (or the page left it). Not a failure. */
export class AppLinkCancelledError extends Error {
  constructor() {
    super("Authorization was cancelled.");
    this.name = "AppLinkCancelledError";
  }
}

const LINK_TIMEOUT_MS = 10 * 60 * 1000;

type Pending = {
  request: AppLinkRequest;
  submit: (address: string) => Promise<void>;
  cancel: () => void;
};

let pending: Pending | null = null;
const listeners = new Set<() => void>();
function publish(next: Pending | null) {
  pending = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Shows the linking dialog for `request` and resolves once the connection
 * is made: the device grant approved, the pasted address accepted, or
 * `isLinked` answering true. Rejects with AppLinkCancelledError when the
 * person cancels or `signal` aborts, and with an Error whose message is
 * safe to show when the service refused or the time ran out.
 */
export function linkInApp(
  request: AppLinkRequest,
  options: { signal?: AbortSignal; isLinked?: () => Promise<boolean> } = {},
): Promise<void> {
  pending?.cancel();
  return new Promise<void>((resolve, reject) => {
    const stop = new AbortController();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stop.abort();
      options.signal?.removeEventListener("abort", onAbort);
      if (pending?.request === request) publish(null);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new AppLinkCancelledError());
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const submit = async (address: string) => {
      if (request.kind === "mcp")
        await completeMcpAuthorizationFromAddress(request.connectorId, address);
      else await completeGoogleAuthorizationFromAddress(request.provider, address);
      finish();
    };
    publish({ request, submit, cancel: () => finish(new AppLinkCancelledError()) });

    const started = Date.now();
    void (async () => {
      let interval = request.kind === "mcp" && request.device ? request.device.interval : 2;
      while (!settled) {
        await wait((Date.now() - started < 60_000 ? interval : Math.max(interval, 5)) * 1000, stop.signal);
        if (settled) return;
        if (Date.now() - started > LINK_TIMEOUT_MS)
          return finish(new Error("Authorization timed out. Try again."));
        try {
          if (request.kind === "mcp" && request.device) {
            const poll = await pollMcpDeviceAuthorization(request.connectorId, request.device.state);
            if (poll.status === "connected") return finish();
            if (poll.status === "denied")
              return finish(new Error("Access was not granted. Try again and approve it."));
            if (poll.status === "expired")
              return finish(new Error("The code expired. Try again."));
            if (poll.status === "pending") interval = poll.interval;
          } else if (options.isLinked && (await options.isLinked())) {
            return finish();
          }
        } catch {
          // One failed check is tolerated; the wait goes on.
        }
      }
    })();
  });
}

/** For tests: the dialog's current request. */
export function currentAppLink(): AppLinkRequest | null {
  return pending?.request ?? null;
}

/**
 * The linking dialog. Mount it once on a page that links connectors; it
 * shows whatever linkInApp is waiting for.
 */
export function ConnectorAppLinkDialog() {
  const current = useSyncExternalStore(subscribe, () => pending, () => null);
  return current ? <AppLinkBody key={keyOf(current.request)} pending={current} /> : null;
}

function keyOf(request: AppLinkRequest) {
  return request.kind === "mcp"
    ? `mcp:${request.connectorId}:${request.device?.state ?? request.authorizationUrl}`
    : `google:${request.provider}:${request.authorizationUrl}`;
}

function AppLinkBody({ pending: current }: { pending: Pending }) {
  const { request } = current;
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const device = request.kind === "mcp" ? request.device : null;
  const link = device ? (device.verificationUriComplete ?? device.verificationUri) : request.authorizationUrl;

  const finish = async () => {
    if (!address.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await current.submit(address.trim());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "That address could not be used. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={current.cancel}
      breadcrumbs={["Connectors", `Connect ${request.name}`]}
      size="md"
      primaryAction={
        device
          ? undefined
          : {
              label: busy ? "Connecting…" : "Connect",
              onClick: () => void finish(),
              disabled: !address.trim() || busy,
            }
      }
      cancelAction={{ label: "Cancel", onClick: current.cancel }}
    >
      <div className="space-y-4 text-sm text-gray-700">
        {device ? (
          <>
            <p>
              Open the link below in your browser, sign in, and enter this code. You can also do it on your phone.
            </p>
            <p
              className="select-all text-center font-mono text-2xl tracking-widest text-gray-900"
              data-testid="app-link-user-code"
            >
              {device.userCode}
            </p>
            <AppLinkAnchor href={link!} label={`Open ${new URL(device.verificationUri).host}`} />
            <p className="text-gray-500">Mike connects as soon as you approve. This window updates by itself.</p>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Open the sign-in page in your browser and approve access.
                <div className="mt-2">
                  <AppLinkAnchor href={link!} label="Open the sign-in page" />
                </div>
              </li>
              <li>
                Your browser then shows a page it cannot open: a security warning, or a NativeCluster page asking you
                to sign in. That is expected. Copy the whole address from the browser&apos;s address bar.
              </li>
              <li>Paste it here and choose Connect.</li>
            </ol>
            <p className="text-gray-500">
              If the service says it can&apos;t send you back to this address, it can&apos;t be linked from here. If it
              gives you an API token, add it as a custom connector with that token instead.
            </p>
            <ModalTextInput
              aria-label="Address from your browser"
              placeholder="https://127.0.0.1:…/…?code=…&state=…"
              value={address}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void finish();
              }}
            />
          </>
        )}
        {error ? (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * A plain link: Mike's NativeCluster window opens a link to another site in
 * the person's default browser (a page that sends itself there goes nowhere).
 */
function AppLinkAnchor({ href, label }: { href: string; label: string }) {
  const safe = /^https:\/\//i.test(href) ? href : undefined;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 font-medium text-blue-600 underline-offset-2 hover:underline"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}
