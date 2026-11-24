// The assistant task's `min_window` in nativecluster/nc-app.json, held to
// what the assistant sends on every turn.
//
// Measured 2026-11-24 with Mike's estimator (lib/llm/contextBudget.ts: three
// ASCII characters a token, so it errs high), the turn's fixed part, as
// runLLMStream assembles it for a model whose window is known:
//
//   every turn: the system prompt (its research, earlier-turns, message-time,
//   delegation and paged-reads parts), 17,591 characters, about 5,870
//   tokens; and 16 tool schemas, 19,128 characters, about 6,506 tokens.
//   With CourtListener and web search on: 20,956 and 23,355 characters,
//   about 6,992 and 7,963 tokens (22 tools).
//
// A real call through NativeCluster showed about 7,900 prompt tokens for a
// short question: the model's tokenizer counts about 4.6 characters a token
// here, so the estimate above is about 1.5 times what the model sees.
//
// A turn also keeps room for the answer (a quarter of the window, at most
// 16,384) and a safety margin (5%). What is left holds the earlier
// conversation (60% of it at most, the oldest turns left out first) and the
// pages of documents the turn reads, which are sized to what is left:
//
//   window 16,384: answer 4,096, margin 820, left -924 (-3,503 with every
//                  tool): the fixed part alone does not fit, every turn fails;
//   window 24,576: left 4,811 (2,232): about one exchange of history;
//   window 32,768: answer 8,192, margin 1,639, left 10,545 (7,966): history
//                  up to 6,327 (4,779) estimated tokens, the rest for pages;
//                  about 15,000 of the model's own tokens.
//
// So 32,768 is the smallest window with room for a reasonable conversation
// and a page of a document beside the answer, and nc-app.json says it.
//
// The playbook task's fixed part is small (its instructions, the JSON shape
// and one tool, about 700 estimated tokens), but a review sends the whole
// playbook and contract at once and keeps min(20,000, half the window) for
// its findings: at 16,384 that leaves about 6,700 estimated tokens (some
// 20,000 characters) for both, at 32,768 about 14,000 (42,000 characters, a
// contract of some ten pages), and a contract that does not fit is refused
// in words (playbooks.operations.ts, reviewFitsWindow). Its min_window is
// 32,768 too. Tabular reviews, titles and memory send little beside the
// document, which is paged, and set none.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, EARLIER_TURNS_PROMPT } from "../prompts";
import {
  PAGED_READS_SYSTEM_PROMPT,
  PLAYBOOK_TOOLS,
  TOOLS,
  WORKFLOW_TOOLS,
  withPagedDocumentReads,
} from "../tools/toolSchemas";
import { COURTLISTENER_TOOLS } from "../tools/courtlistenerTools";
import {
  MIKE_WEB_SEARCH_SYSTEM_PROMPT,
  WEB_SEARCH_SYSTEM_PROMPT,
  webToolsFor,
  withPagedWebReads,
} from "../tools/webSearchTools";
import { delegateSystemPrompt, delegateTool } from "../tools/delegateTools";
import { CITE_DOCUMENTS_TOOL } from "../citeSources";
import { MESSAGE_TIME_PROMPT } from "../../../../lib/userTime";
import {
  answerRoomTokens,
  HISTORY_SHARE,
  promptBudgetTokens,
} from "../../../../lib/llm/contextBudget";

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../../../nativecluster/nc-app.json"), "utf8"),
) as { tasks: { id: string; min_window?: number }[] };
const minWindow = (task: string) => manifest.tasks.find((t) => t.id === task)?.min_window;

/** The tokens a turn has left beside its fixed part, every tool on (the most it can be). */
function leftAt(windowTokens: number): number {
  const systemPrompt = [
    buildSystemPrompt(true),
    EARLIER_TURNS_PROMPT,
    MESSAGE_TIME_PROMPT,
    WEB_SEARCH_SYSTEM_PROMPT,
    MIKE_WEB_SEARCH_SYSTEM_PROMPT,
    delegateSystemPrompt(),
    PAGED_READS_SYSTEM_PROMPT,
  ].join("\n\n");
  const model = "nativecluster:qwen3.8:27b";
  const tools = withPagedWebReads(
    withPagedDocumentReads([
      CITE_DOCUMENTS_TOOL,
      ...TOOLS,
      ...COURTLISTENER_TOOLS,
      ...WORKFLOW_TOOLS,
      ...PLAYBOOK_TOOLS,
      ...webToolsFor("brave"),
      delegateTool(model, [model]),
    ]),
  );
  return promptBudgetTokens({
    windowTokens,
    answerTokens: answerRoomTokens(windowTokens),
    systemPrompt,
    tools,
  });
}

describe("the assistant task's min_window", () => {
  it("is set, for the assistant and for playbook reviews", () => {
    expect(minWindow("assistant")).toBe(32_768);
    expect(minWindow("playbook")).toBe(32_768);
    expect(minWindow("tabular")).toBeUndefined();
  });

  it("leaves room for a conversation and a page beside the fixed prompt and the answer", () => {
    const left = leftAt(minWindow("assistant")!);
    // Estimated tokens: a few exchanges of history and a page of a document.
    expect(Math.floor(left * HISTORY_SHARE)).toBeGreaterThanOrEqual(4_000);
    expect(left).toBeGreaterThanOrEqual(7_000);
  });

  it("is the smallest such window: half of it does not hold the fixed prompt", () => {
    expect(leftAt(minWindow("assistant")! / 2)).toBeLessThan(0);
  });
});
