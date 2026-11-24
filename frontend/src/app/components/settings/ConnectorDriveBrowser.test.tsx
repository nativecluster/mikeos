import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ browseGoogleDriveFiles: vi.fn() }));
vi.mock("@/app/components/settings/ConnectorAppApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/settings/ConnectorAppApi")>()),
  ...api,
}));

import { ConnectorDriveBrowser } from "./ConnectorDriveBrowser";

afterEach(() => vi.clearAllMocks());

describe("the Drive file list in place of the Google Picker", () => {
  it("lists what the connection reaches, searches, and pages", async () => {
    api.browseGoogleDriveFiles
      .mockResolvedValueOnce({
        files: [
          {
            id: "f1",
            name: "Lease.docx",
            mimeType: "x",
            modifiedTime: "2026-11-20T10:00:00Z",
            webViewLink: "https://docs.google.com/document/d/f1",
          },
        ],
        nextPageToken: "n1",
      })
      .mockResolvedValueOnce({
        files: [{ id: "f2", name: "Notes", mimeType: "x", modifiedTime: null, webViewLink: null }],
        nextPageToken: null,
      })
      .mockResolvedValueOnce({ files: [], nextPageToken: null });

    render(<ConnectorDriveBrowser workspace="org-1" />);
    expect(await screen.findByText("Lease.docx")).toBeInTheDocument();
    expect(api.browseGoogleDriveFiles).toHaveBeenLastCalledWith({ query: "", pageToken: null, workspace: "org-1" });
    expect(screen.getByRole("link", { name: "Open Lease.docx in Google Drive" }).getAttribute("target")).toBe("_blank");

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Lease.docx")).toBeInTheDocument();
    expect(api.browseGoogleDriveFiles).toHaveBeenLastCalledWith({ query: "", pageToken: "n1", workspace: "org-1" });

    fireEvent.change(screen.getByLabelText("Search Google Drive"), { target: { value: "zzz" } });
    await waitFor(() =>
      expect(api.browseGoogleDriveFiles).toHaveBeenLastCalledWith({ query: "zzz", pageToken: null, workspace: "org-1" }),
    );
    expect(await screen.findByText("No files Mike can reach match that.")).toBeInTheDocument();
  });

  it("says why when the list cannot be read", async () => {
    api.browseGoogleDriveFiles.mockRejectedValue(new Error("Google Drive is turned off in Settings → Connectors."));
    render(<ConnectorDriveBrowser />);
    expect(await screen.findByRole("alert")).toHaveTextContent("turned off");
  });
});
