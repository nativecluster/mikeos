"use client";

// Mike's NativeCluster app, in place of "Add files from Google Drive": the
// Google Picker cannot load in the app's window, so Mike's backend lists the
// files the Drive connection reaches, and the person searches them here.
// With drive.file alone those are the files Mike made or that were picked
// before; Mike's Drive tools search and read the same ones.

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { PillButtonUI } from "@mike/ui";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import {
  browseGoogleDriveFiles,
  type GoogleDriveBrowseFile,
} from "@/app/components/settings/ConnectorAppApi";

export function ConnectorDriveBrowser({ workspace }: { workspace?: string }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<GoogleDriveBrowseFile[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (search: string, pageToken: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const page = await browseGoogleDriveFiles({ query: search, pageToken, workspace });
        if (ticket !== latest.current) return;
        setFiles((current) => (pageToken ? [...current, ...page.files] : page.files));
        setNext(page.nextPageToken);
      } catch (err) {
        if (ticket !== latest.current) return;
        setError(err instanceof Error && err.message ? err.message : "Google Drive could not be listed. Try again.");
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [workspace],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim(), null), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <div className="flex w-full flex-col gap-2">
      <ModalTextInput
        aria-label="Search Google Drive"
        placeholder="Search Google Drive"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Google Drive files">
        {files.map((file) => (
          <li key={file.id} className="flex min-w-0 items-start justify-between gap-2 text-sm">
            <span className="min-w-0 break-words text-gray-800">
              {file.name}
              {file.modifiedTime ? (
                <span className="block text-xs text-gray-500">
                  Changed {new Date(file.modifiedTime).toLocaleDateString()}
                </span>
              ) : null}
            </span>
            {file.webViewLink ? (
              <a
                href={file.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${file.name} in Google Drive`}
                className="shrink-0 text-gray-500 hover:text-gray-800"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {!loading && !error && files.length === 0 ? (
        <p className="text-xs text-gray-500">
          {query.trim()
            ? "No files Mike can reach match that."
            : "Mike reaches no Drive files yet. Files Mike creates in Drive appear here."}
        </p>
      ) : null}
      {loading ? (
        <p className="flex items-center gap-1.5 text-xs text-gray-500" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…
        </p>
      ) : next ? (
        <PillButtonUI tone="white" onClick={() => void load(query.trim(), next)}>
          Show more
        </PillButtonUI>
      ) : null}
    </div>
  );
}
