// Reading a document in parts, for a model whose context window is known.
//
// A hosted model's window holds any document Mike stores, and read_document
// returns the whole text in one result, as it always has. A local model's
// window may not: then read_document returns as much as this turn's budget
// allows (lib/llm/contextBudget.ts), says where the document continues, and
// takes an `offset` to read on. Nothing is cut silently: every part says which
// characters it holds and whether more follows.

import {
  endWithinTokens,
  estimateTokens,
} from "../../../../lib/llm/contextBudget";

/** A read's starting offset from the model's arguments; anything unusable is 0. */
export function readOffset(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

/**
 * The turn's read-once key for one part of a document. Reading on is not
 * reading again: each part has a key of its own.
 */
export function partReadKey(key: string, offset: number): string {
  return `${key}@${offset}`;
}

export type DocumentPage =
  /** The whole text, as an unpaged read returns it. */
  | { kind: "whole"; text: string }
  | {
      kind: "part";
      text: string;
      start: number;
      end: number;
      total: number;
    }
  /** No room is left in this turn for more document text. */
  | { kind: "full" }
  /** The offset is past the end of the text. */
  | { kind: "past_end"; total: number };

/** The part of `text` a read from `offset` returns with `pageTokens` to spend. */
export function documentPage(
  text: string,
  offset: number,
  pageTokens: number,
): DocumentPage {
  if (offset > 0 && offset >= text.length) {
    return { kind: "past_end", total: text.length };
  }
  if (offset === 0 && estimateTokens(text) <= pageTokens) {
    return { kind: "whole", text };
  }
  if (pageTokens <= 0) return { kind: "full" };
  const end = endWithinTokens(text, offset, pageTokens);
  return {
    kind: "part",
    text: text.slice(offset, end),
    start: offset,
    end,
    total: text.length,
  };
}

/** What a part's result says before its text. */
export function partHeading(page: { start: number; end: number; total: number }): string {
  return `[This document is longer than this model's context window allows in one read, so it comes in parts. This part: characters ${page.start}-${page.end} of ${page.total}.]`;
}

/** What a part's result says after its text: where to read on, or that it ended. */
export function partFooting(
  docId: string,
  page: { end: number; total: number },
): string {
  return page.end < page.total
    ? `[The document continues at offset ${page.end}. To read on, call read_document with doc_id "${docId}" and offset ${page.end}.]`
    : "[This is the end of the document.]";
}

/** The result for a read the turn has no room left for. */
export function contextFullResult(docId: string): string {
  return JSON.stringify({
    ok: false,
    error: "context_full",
    doc_id: docId,
    explanation:
      "This model's context window has no room left in this response for more document text.",
    next_required_action:
      "Answer from what you have already read, and tell the user which documents or parts you could not read in this response; they can ask about them in a new message.",
  });
}

/** The result for an offset past the end of the document. */
export function pastEndResult(docId: string, total: number): string {
  return JSON.stringify({
    ok: false,
    error: "offset_past_end",
    doc_id: docId,
    explanation: `The document has ${total} characters, so an offset of ${total} or more is past its end.`,
  });
}
