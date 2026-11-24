// NativeCluster: a group's own Macs as the model provider.
//
// NativeCluster runs open models on the Macs of a group and serves them
// through one OpenAI-compatible Chat Completions endpoint, by default
// http://localhost:8487/v1 on a Mac that runs it. Calls wait in the
// cluster's one fair line, so a call may be held before its first token for
// as long as the line takes; NativeCluster sends an SSE comment
// (": waiting") every ten seconds meanwhile. See
// https://www.nativecluster.com/docs/api.md.
//
// Model ids are "nativecluster/<the model's id in GET /v1/models>".
//
// MIKE_INFERENCE_PROVIDER=nativecluster makes NativeCluster the only model
// provider: every other provider is refused where models are chosen, listed
// and called (see inferenceOnlyProvider).

import { readFile } from "node:fs/promises";
import { log, tpl } from "../log";

export const NATIVECLUSTER_MODEL_PREFIX = "nativecluster/";

const DEFAULT_BASE_URL = "http://localhost:8487/v1";

/** How long a listing of NativeCluster's models is reused. */
const MODEL_LIST_MAX_AGE_MS = 60_000;

/** The one provider an inference-only deployment may use. */
export type InferenceOnlyProvider = "nativecluster";

/**
 * MIKE_INFERENCE_PROVIDER. Set (to "nativecluster", the one supported
 * value), every model call must go to NativeCluster. Any other non-empty
 * value restricts too, so a typo errs on the private side;
 * validateRuntimeConfiguration refuses it at start-up.
 */
export function inferenceOnlyProvider(
  env: NodeJS.ProcessEnv = process.env,
): InferenceOnlyProvider | null {
  return env.MIKE_INFERENCE_PROVIDER?.trim() ? "nativecluster" : null;
}

/** The sentence a person sees when a model other than NativeCluster's is refused. */
export const INFERENCE_ONLY_DETAIL =
  "This Mike runs every model on NativeCluster, on your group's own Macs. Select a NativeCluster model.";

export function isNativeClusterModel(model: string): boolean {
  return (
    model.startsWith(NATIVECLUSTER_MODEL_PREFIX) &&
    model.length > NATIVECLUSTER_MODEL_PREFIX.length
  );
}

/** The model's id at NativeCluster, without Mike's prefix. */
export function nativeClusterModelName(model: string): string {
  return model.startsWith(NATIVECLUSTER_MODEL_PREFIX)
    ? model.slice(NATIVECLUSTER_MODEL_PREFIX.length)
    : model;
}

/**
 * Whether this deployment uses NativeCluster at all: inference-only, or any
 * NATIVECLUSTER_* setting. Off, Mike never contacts it, so an upstream
 * deployment's behavior is unchanged.
 */
export function nativeClusterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    inferenceOnlyProvider(env) !== null ||
    !!env.NATIVECLUSTER_BASE_URL?.trim() ||
    !!env.NATIVECLUSTER_API_KEY?.trim() ||
    !!env.NATIVECLUSTER_ENV_FILE?.trim()
  );
}

export function nativeClusterBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (env.NATIVECLUSTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

/**
 * The variables a shell env file assigns, as `nativecluster env` writes
 * them (`export NAME='value'`). The file is parsed, never run: single- and
 * double-quoted and bare values are read, and anything else is ignored.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = unquoteShellWord(match[2]!.trim());
    if (value !== null) values.set(match[1]!, value);
  }
  return values;
}

/** One shell word: 'single' (with '\'' for a quote), "double", or bare. */
function unquoteShellWord(word: string): string | null {
  if (word.startsWith("'")) {
    if (word.length < 2 || !word.endsWith("'")) return null;
    return word.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (word.startsWith('"')) {
    if (word.length < 2 || !word.endsWith('"')) return null;
    return word.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return /^[^\s'"`$\\;&|<>()]*$/.test(word) ? word : null;
}

const ENV_FILE_KEY_NAMES = ["NATIVECLUSTER_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * NativeCluster's key: NATIVECLUSTER_API_KEY, or the file NATIVECLUSTER_ENV_FILE
 * names. The file is read on every call, so a session `nativecluster env`
 * renews is picked up without a restart. Never logged.
 */
export async function nativeClusterApiKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const direct = env.NATIVECLUSTER_API_KEY?.trim();
  if (direct) return direct;
  const path = env.NATIVECLUSTER_ENV_FILE?.trim();
  if (!path) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    log.warn(
      tpl`[nativecluster] NATIVECLUSTER_ENV_FILE could not be read (${typeof code === "string" ? code : "error"}). Run \`nativecluster env\` on this Mac.`,
    );
    return null;
  }
  const values = parseEnvFile(text);
  for (const name of ENV_FILE_KEY_NAMES) {
    const value = values.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The cluster's models
// ---------------------------------------------------------------------------

/** One entry of GET /v1/models, as far as Mike reads it. */
export type NativeClusterModelInfo = {
  /** The model's id at NativeCluster ("qwen3.8:27b"). */
  id: string;
  /** "chat", "embedding", "stt", "tts", "image"; null when not given. */
  kind: string | null;
  /** The window on the Mac that runs it: prompt and answer together. */
  contextLength?: number;
  /** The answer length to ask for so the call runs alongside others. */
  maxOutputTokens?: number;
  /** Any of "completion", "tools", "thinking", "vision". */
  capabilities: string[];
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function modelInfoFrom(entry: unknown): NativeClusterModelInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  // The id becomes part of Mike's model id, which is stored and sent back.
  if (!id || id.length > 200 || /\s/.test(id)) return null;
  const contextLength = positiveInteger(record.context_length);
  const maxOutputTokens = positiveInteger(record.max_output_tokens);
  return {
    id,
    kind: typeof record.kind === "string" ? record.kind : null,
    ...(contextLength ? { contextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}

/**
 * A model Mike can chat with: a chat model (an entry without a kind is
 * taken as one) that can call tools, which every chat turn offers. A model
 * listed without capabilities is offered, and NativeCluster decides.
 */
export function isNativeClusterChatModel(model: NativeClusterModelInfo): boolean {
  return (
    (model.kind === null || model.kind === "chat") &&
    (model.capabilities.length === 0 || model.capabilities.includes("tools"))
  );
}

type ModelListCache = {
  baseUrl: string;
  at: number;
  models: NativeClusterModelInfo[];
};

let modelList: ModelListCache | null = null;
let modelListInflight: Promise<NativeClusterModelInfo[]> | null = null;

/** Test seam: forget the cached listing. */
export function resetNativeClusterModelCache(): void {
  modelList = null;
  modelListInflight = null;
}

/**
 * Every model GET /v1/models lists, reused for a minute. Empty when
 * NativeCluster is off, unreachable or refuses the key, so Mike still opens
 * without it.
 */
export async function listNativeClusterModels(
  options: { maxAgeMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<NativeClusterModelInfo[]> {
  if (!nativeClusterEnabled()) return [];
  const baseUrl = nativeClusterBaseUrl();
  const maxAgeMs = options.maxAgeMs ?? MODEL_LIST_MAX_AGE_MS;
  if (
    modelList &&
    modelList.baseUrl === baseUrl &&
    Date.now() - modelList.at <= maxAgeMs
  ) {
    return modelList.models;
  }
  if (!modelListInflight) {
    const request = fetchModelList(baseUrl, options.fetchImpl ?? fetch).finally(
      () => {
        if (modelListInflight === request) modelListInflight = null;
      },
    );
    modelListInflight = request;
  }
  return modelListInflight;
}

async function fetchModelList(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<NativeClusterModelInfo[]> {
  try {
    const key = await nativeClusterApiKey();
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      // A listing, not a model call: NativeCluster answers it at once.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      log.warn(
        tpl`[nativecluster] model listing refused (${response.status})`,
      );
      return [];
    }
    const payload = (await response.json()) as { data?: unknown };
    const models = (Array.isArray(payload.data) ? payload.data : []).flatMap(
      (entry) => {
        const info = modelInfoFrom(entry);
        return info ? [info] : [];
      },
    );
    modelList = { baseUrl, at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

/**
 * What the last listing said of a model (app-level or NativeCluster id),
 * without waiting. A missing or stale listing is refreshed in the
 * background for the next caller.
 */
export function cachedNativeClusterModel(
  model: string,
): NativeClusterModelInfo | undefined {
  if (!nativeClusterEnabled()) return undefined;
  const fresh =
    modelList &&
    modelList.baseUrl === nativeClusterBaseUrl() &&
    Date.now() - modelList.at <= MODEL_LIST_MAX_AGE_MS;
  if (!fresh) void listNativeClusterModels();
  const name = nativeClusterModelName(model);
  return modelList?.models.find((entry) => entry.id === name);
}

/** The listing's entry for a model, refreshing a stale listing first. */
export async function nativeClusterModelInfo(
  model: string,
): Promise<NativeClusterModelInfo | undefined> {
  const name = nativeClusterModelName(model);
  return (await listNativeClusterModels()).find((entry) => entry.id === name);
}

/** The chat models Mike offers, as app-level ids, in NativeCluster's order. */
export async function nativeClusterChatModelIds(): Promise<string[]> {
  return (await listNativeClusterModels())
    .filter(isNativeClusterChatModel)
    .map((model) => `${NATIVECLUSTER_MODEL_PREFIX}${model.id}`);
}

/**
 * The NativeCluster chat model work runs on when nothing else was chosen:
 * `preferred` when it is a NativeCluster model (the person's last chat
 * model), else NATIVECLUSTER_MODEL, else the first chat model NativeCluster
 * lists. Null when none is known.
 */
export async function defaultNativeClusterModel(
  preferred?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (preferred && isNativeClusterModel(preferred)) return preferred;
  const configured = env.NATIVECLUSTER_MODEL?.trim();
  if (configured) {
    return isNativeClusterModel(configured)
      ? configured
      : `${NATIVECLUSTER_MODEL_PREFIX}${configured}`;
  }
  return (await nativeClusterChatModelIds())[0] ?? null;
}

/**
 * The Chat Completions body NativeCluster takes. Mike's reasoning level
 * arrives as `reasoning_effort`, which NativeCluster does not read; a model
 * that can think is told `think` instead ("none" is false), and any other
 * model is sent neither.
 */
export function nativeClusterRequestBody(
  body: Record<string, unknown>,
  options: { thinks: boolean },
): Record<string, unknown> {
  const { reasoning_effort: effort, ...rest } = body;
  if (!options.thinks || effort === undefined || effort === null) return rest;
  return { ...rest, think: effort !== "none" };
}
