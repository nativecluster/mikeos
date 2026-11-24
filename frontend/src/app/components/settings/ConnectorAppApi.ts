// Calls for linking connectors inside Mike's NativeCluster app
// (NEXT_PUBLIC_MIKE_NC_APP=1). The backend's routes exist only there:
// backend/src/modules/user/user.mcpApp.routes.ts and the Drive file list.

import { authenticatedFetch } from "@/app/lib/authEvents";
import { MikeApiError, type McpConnectorSummary } from "@/app/lib/mikeApi";

/** Mike runs as a NativeCluster app: no popups, links open in the browser. */
export function isNcAppMode(): boolean {
  return process.env.NEXT_PUBLIC_MIKE_NC_APP === "1";
}

/** The device grant (RFC 8628) the server offered: a code to type at a link. */
export type McpDeviceAuthorization = {
  state: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresIn: number;
};

export type McpDevicePoll =
  | { status: "connected"; connector?: McpConnectorSummary }
  | { status: "pending"; interval: number }
  | { status: "denied" | "expired" };

export type GoogleLinkProvider = "google-drive" | "gmail" | "google-calendar";

export type GoogleDriveBrowseFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`/api${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    let code: string | null = null;
    let detail = "Something went wrong. Please try again.";
    try {
      const body = (await response.json()) as { code?: unknown; detail?: unknown };
      if (typeof body.code === "string") code = body.code;
      if (response.status < 500 && typeof body.detail === "string" && body.detail)
        detail = body.detail;
    } catch {
      // No JSON body: the fixed sentence stands.
    }
    throw new MikeApiError({ message: detail, status: response.status, code });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function pollMcpDeviceAuthorization(
  connectorId: string,
  state: string,
): Promise<McpDevicePoll> {
  return request(`/user/mcp-connectors/${encodeURIComponent(connectorId)}/oauth/device/poll`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

/** Finishes an MCP authorization from the address the browser landed on. */
export function completeMcpAuthorizationFromAddress(
  connectorId: string,
  address: string,
): Promise<{ connector: McpConnectorSummary }> {
  return request(`/user/mcp-connectors/${encodeURIComponent(connectorId)}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify({ address }),
  });
}

/** Finishes a Google authorization from the address the browser landed on. */
export function completeGoogleAuthorizationFromAddress(
  provider: GoogleLinkProvider,
  address: string,
): Promise<void> {
  return request(`/user/integrations/${provider}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify({ address }),
  });
}

/** The Drive files the connection reaches, in place of the Google Picker. */
export function browseGoogleDriveFiles(options: {
  query?: string;
  pageToken?: string | null;
  workspace?: string;
}): Promise<{ files: GoogleDriveBrowseFile[]; nextPageToken: string | null }> {
  const params = new URLSearchParams();
  if (options.query) params.set("q", options.query);
  if (options.pageToken) params.set("pageToken", options.pageToken);
  if (options.workspace) params.set("workspace", options.workspace);
  const query = params.toString();
  return request(`/user/integrations/google-drive/files${query ? `?${query}` : ""}`);
}
