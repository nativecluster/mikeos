import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  pollMcpDeviceAuthorization: vi.fn(),
  completeMcpAuthorizationFromAddress: vi.fn(),
  completeGoogleAuthorizationFromAddress: vi.fn(),
}));
vi.mock("@/app/components/settings/ConnectorAppApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/settings/ConnectorAppApi")>()),
  ...api,
}));

import {
  AppLinkCancelledError,
  ConnectorAppLinkDialog,
  currentAppLink,
  linkInApp,
} from "./ConnectorAppLink";

const AUTH_URL = "https://as.example/authorize?client_id=c&state=s";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("linking inside the NativeCluster app", () => {
  it("shows the sign-in page as a plain link and finishes from the pasted address", async () => {
    api.completeMcpAuthorizationFromAddress.mockResolvedValue({ connector: {} });
    render(<ConnectorAppLinkDialog />);
    let linked = false;
    const done = linkInApp({
      kind: "mcp",
      connectorId: "c1",
      name: "Files",
      authorizationUrl: AUTH_URL,
      device: null,
    }).then(() => {
      linked = true;
    });

    const link = await screen.findByRole("link", { name: /open the sign-in page/i });
    // A link the window hands to the browser; no popup, no navigation of the page.
    expect(link.getAttribute("href")).toBe(AUTH_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    // A service that refuses to send the person back here is told apart.
    expect(
      screen.getByText(/If the service says it can't send you back to this address, it can't be linked from here\./),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Address from your browser"), {
      target: { value: "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback?code=x&state=s" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await done;
    expect(linked).toBe(true);
    expect(api.completeMcpAuthorizationFromAddress).toHaveBeenCalledWith(
      "c1",
      "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback?code=x&state=s",
    );
    await waitFor(() => expect(screen.queryByLabelText("Address from your browser")).toBeNull());
  });

  it("keeps the dialog open and says why when the address is refused", async () => {
    api.completeGoogleAuthorizationFromAddress.mockRejectedValue(
      new Error("That address has no authorization in it."),
    );
    render(<ConnectorAppLinkDialog />);
    const done = linkInApp({
      kind: "google",
      provider: "google-drive",
      name: "Google Drive",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
    }).catch((e: unknown) => e);
    fireEvent.change(await screen.findByLabelText("Address from your browser"), {
      target: { value: "https://127.0.0.1:8494/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That address has no authorization in it.");
    expect(currentAppLink()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await done).toBeInstanceOf(AppLinkCancelledError);
  });

  it("shows the device code and finishes when the service says it was approved", async () => {
    api.pollMcpDeviceAuthorization
      .mockResolvedValueOnce({ status: "pending", interval: 5 })
      .mockResolvedValueOnce({ status: "connected" });
    render(<ConnectorAppLinkDialog />);
    const done = linkInApp({
      kind: "mcp",
      connectorId: "c1",
      name: "Files",
      authorizationUrl: null,
      device: {
        state: "st-0123456789abcdef",
        userCode: "WDJB-MJHT",
        verificationUri: "https://as.example/activate",
        verificationUriComplete: null,
        interval: 5,
        expiresIn: 600,
      },
    });
    expect(await screen.findByTestId("app-link-user-code")).toHaveTextContent("WDJB-MJHT");
    expect(screen.getByRole("link", { name: /as\.example/ }).getAttribute("href")).toBe(
      "https://as.example/activate",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await done;
    expect(api.pollMcpDeviceAuthorization).toHaveBeenCalledWith("c1", "st-0123456789abcdef");
  });

  it("stops with words the person can read when the service refuses", async () => {
    api.pollMcpDeviceAuthorization.mockResolvedValue({ status: "denied" });
    const done = linkInApp({
      kind: "mcp",
      connectorId: "c1",
      name: "Files",
      authorizationUrl: null,
      device: {
        state: "st-0123456789abcdef",
        userCode: "A",
        verificationUri: "https://as.example/activate",
        verificationUriComplete: null,
        interval: 1,
        expiresIn: 600,
      },
    }).catch((e: unknown) => e);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(String(await done)).toMatch(/not granted/);
  });

  it("finishes when the connection appears by itself, and is cancelled with the page", async () => {
    let connected = false;
    const done = linkInApp(
      { kind: "google", provider: "gmail", name: "Gmail", authorizationUrl: "https://accounts.google.com/x" },
      { isLinked: async () => connected },
    );
    connected = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await done;

    const controller = new AbortController();
    const cancelled = linkInApp(
      { kind: "google", provider: "gmail", name: "Gmail", authorizationUrl: "https://accounts.google.com/x" },
      { signal: controller.signal },
    ).catch((e: unknown) => e);
    controller.abort();
    expect(await cancelled).toBeInstanceOf(AppLinkCancelledError);
    expect(currentAppLink()).toBeNull();
  });

  it("never links anything but https", async () => {
    render(<ConnectorAppLinkDialog />);
    const done = linkInApp({
      kind: "mcp",
      connectorId: "c1",
      name: "Files",
      authorizationUrl: "javascript:alert(1)",
      device: null,
    }).catch(() => undefined);
    const link = await screen.findByText("Open the sign-in page");
    expect(link.closest("a")?.getAttribute("href")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await done;
  });
});
