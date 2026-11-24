import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelGoogleDriveOAuth, getGoogleDriveStatus, startGoogleDriveOAuth } from "@/app/lib/mikeApi";

vi.mock("@/app/lib/mikeApi", () => ({
  cancelGoogleDriveOAuth: vi.fn(async () => undefined),
  cancelGoogleWorkspaceOAuth: vi.fn(),
  disconnectGoogleDrive: vi.fn(),
  disconnectGoogleWorkspace: vi.fn(),
  getGoogleDriveStatus: vi.fn(),
  getGoogleWorkspaceStatus: vi.fn(),
  setGoogleDriveToolEnabled: vi.fn(),
  setGoogleWorkspaceToolEnabled: vi.fn(),
  startGoogleDriveOAuth: vi.fn(),
  startGoogleWorkspaceOAuth: vi.fn(),
  updateGoogleDriveSettings: vi.fn(),
  updateGoogleWorkspaceSettings: vi.fn(),
}));
const link = vi.hoisted(() => ({ linkInApp: vi.fn() }));
vi.mock("@/app/components/settings/ConnectorAppLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/settings/ConnectorAppLink")>()),
  ...link,
}));

import { AppLinkCancelledError } from "./ConnectorAppLink";
import { GoogleAuthorizationCancelledError, GoogleConnectorFlowError, useGoogleConnector } from "./useGoogleConnector";

const status = (connected: boolean) => ({
  connected,
  configured: true,
  available: true,
  enabled: true,
  tools: [],
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
  vi.mocked(getGoogleDriveStatus).mockResolvedValue(status(false) as never);
  vi.mocked(startGoogleDriveOAuth).mockResolvedValue({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-1",
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Google in the NativeCluster app", () => {
  it("links through the dialog, with no popup", async () => {
    const open = vi.spyOn(window, "open");
    link.linkInApp.mockImplementation(async () => {
      vi.mocked(getGoogleDriveStatus).mockResolvedValue(status(true) as never);
    });
    const { result } = renderHook(() => useGoogleConnector("google-drive", "Google Drive"));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => {
      await result.current.connect();
    });
    expect(open).not.toHaveBeenCalled();
    expect(link.linkInApp).toHaveBeenCalledWith(
      {
        kind: "google",
        provider: "google-drive",
        name: "Google Drive",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-1",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal), isLinked: expect.any(Function) }),
    );
    expect(result.current.status?.connected).toBe(true);
    expect(cancelGoogleDriveOAuth).not.toHaveBeenCalled();
  });

  it("cancels the attempt when the person cancels", async () => {
    link.linkInApp.mockRejectedValue(new AppLinkCancelledError());
    const { result } = renderHook(() => useGoogleConnector("google-drive", "Google Drive"));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    let error: unknown;
    await act(async () => {
      error = await result.current.connect().catch((e: unknown) => e);
    });
    expect(error).toBeInstanceOf(GoogleAuthorizationCancelledError);
    expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith("st-1", undefined);
  });

  it("passes on what went wrong in words", async () => {
    link.linkInApp.mockRejectedValue(new Error("Authorization timed out. Try again."));
    const { result } = renderHook(() => useGoogleConnector("google-drive", "Google Drive"));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    let error: unknown;
    await act(async () => {
      error = await result.current.connect().catch((e: unknown) => e);
    });
    expect(error).toBeInstanceOf(GoogleConnectorFlowError);
    expect((error as Error).message).toBe("Authorization timed out. Try again.");
  });
});
