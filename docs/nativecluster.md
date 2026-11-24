# NativeCluster

[NativeCluster](https://www.nativecluster.com) runs open models on a group's
own Macs and serves them through one OpenAI-compatible Chat Completions
endpoint, by default `http://localhost:8487/v1` on a Mac that runs it. Mike
can use it as a model provider beside the others, or as the only one, so that
no model call leaves the group's Macs.

## Configuration

Set these on the backend. NativeCluster is off, and never contacted, until at
least one of them is set.

| Variable | Meaning |
| --- | --- |
| `NATIVECLUSTER_BASE_URL` | The endpoint. Default `http://localhost:8487/v1`. |
| `NATIVECLUSTER_API_KEY` | A NativeCluster key (`nck_…`), or a session (`nct_…`). |
| `NATIVECLUSTER_ENV_FILE` | Instead of the key: the file `nativecluster env` writes. |
| `NATIVECLUSTER_MODEL` | Optional. The model a review runs on when none was chosen, inference-only. |
| `MIKE_INFERENCE_PROVIDER` | `nativecluster` to refuse every other provider (below). |

On a NativeCluster Mac, `nativecluster env` writes a session for local tools
to a file only its person can read and prints the file's path, never the key.
Point `NATIVECLUSTER_ENV_FILE` at that path. Mike parses the file (it never
runs it), takes `NATIVECLUSTER_API_KEY` or else `OPENAI_API_KEY` from it, and
reads it again on every call, so a session renewed by `nativecluster env`
needs no restart. Never commit or log the key.

The desktop app's local mode does this by itself: when
`~/.local/bin/nativecluster env` answers, the backend gets the env file and
`MIKE_INFERENCE_PROVIDER=nativecluster`; otherwise local models stay on
Ollama.

## Models

NativeCluster's chat models that can call tools are listed live from its
`GET /v1/models` and appear in every picker under **NativeCluster**, as
`nativecluster/<model>` (for example `nativecluster/qwen3.8:27b`), with no
key to add. `GET /models/nativecluster` returns them to the clients without
NativeCluster's address or key.

Each entry of NativeCluster's listing also gives the model's window on the Mac
that runs it (`context_length`), the answer length to ask for
(`max_output_tokens`, sent as the output limit unless `LLM_MAX_OUTPUT_TOKENS`
is set) and its `capabilities`. `contextWindowFor(modelId)` in
`backend/src/lib/llm/contextWindow.ts` returns the window for a NativeCluster
model id once the listing has been read (it is cached for a minute).

Calls carry what NativeCluster reads and nothing a hosted provider alone
reads: no prompt-cache hints, retention options or provider web search. The
reasoning level becomes NativeCluster's `think` (None is off, High is on) for
a model whose capabilities include `thinking`.

Tool calls arrive structured, each whole in one chunk, so tool-using turns
stream. The [local-model tolerance](configured-models.md#tool-call-tolerance)
is still applied: `<think>` prose is shown as reasoning, and a tool call a
model writes as text is recovered.

## No time limits

A NativeCluster call waits in the cluster's one fair line before it starts,
for as long as the line takes, and a local model may read a long prompt
slowly. So a NativeCluster call has no first-chunk or between-chunk deadline
(`STREAM_FIRST_CHUNK_TIMEOUT_MS`, `STREAM_CHUNK_TIMEOUT_MS`), its chat title
has no 15-second cutoff, and while the call is open its run counts as alive
for the run's idle deadline. Only the person's own Stop ends it. Hosted
providers keep their deadlines. The run's lifetime backstop
(`STREAM_MAX_LIFETIME_MS`, four hours) still applies.

## NativeCluster only

`MIKE_INFERENCE_PROVIDER=nativecluster` makes NativeCluster the only model
provider, enforced on the server:

- every model call is refused before it is sent unless it is NativeCluster's,
  whatever path the model id came by;
- a chat, review or preference naming another provider's model is refused
  with a sentence saying why, and saved preferences for other providers read
  as unset;
- the Ollama and configured-model discovery routes list nothing, and the
  key-based provider catalogs are refused;
- an unset tabular review model is the person's last NativeCluster chat
  model, else `NATIVECLUSTER_MODEL`, else the first chat model NativeCluster
  lists; title, memory and subagent models follow the chat's model when
  unset, as they always do;
- provider web search is off, since no NativeCluster model has one.

The web app and the Word add-in then offer NativeCluster's models alone, and
hide Bring Your Own Keys, the key step of onboarding and the provider search
choices. Mike's own services are not model calls and stay as they are: Brave,
Tavily and DeepSeek search, CourtListener, Google Drive and MCP connectors.

Any value other than `nativecluster` stops the backend at start-up. Unset, the
default, every provider is allowed as before.

## Testing against a real NativeCluster

One opt-in test streams a short chat turn with one tool through the provider
to a running NativeCluster, on the smallest chat model it lists (or
`NATIVECLUSTER_LIVE_MODEL`). It never downloads a model:

```bash
NATIVECLUSTER_LIVE_TEST=1 \
NATIVECLUSTER_ENV_FILE="<the path nativecluster env prints>" \
  npm test --prefix backend -- src/lib/llm/nativecluster.live.test.ts
```
