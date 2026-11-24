import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextWindowFor } from "./contextWindow";
import {
  defaultNativeClusterModel,
  inferenceOnlyProvider,
  isNativeClusterChatModel,
  listNativeClusterModels,
  nativeClusterApiKey,
  nativeClusterBaseUrl,
  nativeClusterEnabled,
  nativeClusterRequestBody,
  parseEnvFile,
  resetNativeClusterModelCache,
} from "./nativecluster";
import { providerForModel, reasoningLevelsForModel, resolveModel } from "./models";

/** A /v1/models answer in NativeCluster's shape (docs/api.md). */
const MODELS_BODY = {
  object: "list",
  data: [
    {
      id: "qwen3.8:27b",
      object: "model",
      created: 0,
      owned_by: "nativecluster",
      kind: "chat",
      context_length: 65536,
      max_output_tokens: 8192,
      capabilities: ["completion", "tools", "thinking"],
      good_for: ["coding"],
    },
    {
      id: "gemma4:4b",
      object: "model",
      kind: "chat",
      context_length: 32768,
      capabilities: ["completion"],
    },
    { id: "bge-m3", object: "model", kind: "embedding" },
    { id: "has space", object: "model", kind: "chat" },
  ],
};

let dir: string;

beforeEach(async () => {
  resetNativeClusterModelCache();
  dir = await mkdtemp(path.join(tmpdir(), "nativecluster-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("the env file `nativecluster env` writes", () => {
  it("reads exported, quoted values without running anything", () => {
    const values = parseEnvFile(
      [
        "export OPENAI_BASE_URL='http://localhost:8487/v1'",
        "export OPENAI_API_KEY='nct_one'",
        `export NATIVECLUSTER_API_KEY='nct_it'\\''s'`,
        'DOUBLE="a \\"b\\""',
        "BARE=plain",
        "COMMAND=$(cat /etc/passwd)",
        "BACKTICK=`id`",
        "# a comment",
        "not an assignment",
      ].join("\n"),
    );
    expect(values.get("OPENAI_BASE_URL")).toBe("http://localhost:8487/v1");
    expect(values.get("OPENAI_API_KEY")).toBe("nct_one");
    expect(values.get("NATIVECLUSTER_API_KEY")).toBe("nct_it's");
    expect(values.get("DOUBLE")).toBe('a "b"');
    expect(values.get("BARE")).toBe("plain");
    expect(values.has("COMMAND")).toBe(false);
    expect(values.has("BACKTICK")).toBe(false);
  });

  it("takes the key from NATIVECLUSTER_API_KEY first, then the file", async () => {
    const file = path.join(dir, "env.sh");
    await writeFile(
      file,
      "export OPENAI_API_KEY='nct_openai'\nexport NATIVECLUSTER_API_KEY='nct_file'\n",
    );
    vi.stubEnv("NATIVECLUSTER_ENV_FILE", file);
    vi.stubEnv("NATIVECLUSTER_API_KEY", "");
    await expect(nativeClusterApiKey()).resolves.toBe("nct_file");

    await writeFile(file, "export OPENAI_API_KEY='nct_openai'\n");
    // Read again on every call: a renewed session needs no restart.
    await expect(nativeClusterApiKey()).resolves.toBe("nct_openai");

    vi.stubEnv("NATIVECLUSTER_API_KEY", " nck_direct ");
    await expect(nativeClusterApiKey()).resolves.toBe("nck_direct");
  });

  it("has no key when the file is missing", async () => {
    vi.stubEnv("NATIVECLUSTER_API_KEY", "");
    vi.stubEnv("NATIVECLUSTER_ENV_FILE", path.join(dir, "missing.sh"));
    await expect(nativeClusterApiKey()).resolves.toBeNull();
  });
});

describe("settings", () => {
  it("is off, and never contacted, until configured", async () => {
    for (const name of [
      "MIKE_INFERENCE_PROVIDER",
      "NATIVECLUSTER_BASE_URL",
      "NATIVECLUSTER_API_KEY",
      "NATIVECLUSTER_ENV_FILE",
    ]) {
      vi.stubEnv(name, "");
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(nativeClusterEnabled()).toBe(false);
    expect(inferenceOnlyProvider()).toBeNull();
    await expect(listNativeClusterModels()).resolves.toEqual([]);
    expect(contextWindowFor("nativecluster/qwen3.8:27b")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults to NativeCluster on this Mac", () => {
    vi.stubEnv("NATIVECLUSTER_BASE_URL", "");
    expect(nativeClusterBaseUrl()).toBe("http://localhost:8487/v1");
    vi.stubEnv("NATIVECLUSTER_BASE_URL", "http://studio.local:8487/v1/");
    expect(nativeClusterBaseUrl()).toBe("http://studio.local:8487/v1");
  });

  it("restricts to NativeCluster for any value of the switch", () => {
    vi.stubEnv("MIKE_INFERENCE_PROVIDER", "nativecluster");
    expect(inferenceOnlyProvider()).toBe("nativecluster");
    // A typo errs on the private side; start-up refuses it.
    vi.stubEnv("MIKE_INFERENCE_PROVIDER", "nativeclustr");
    expect(inferenceOnlyProvider()).toBe("nativecluster");
    expect(nativeClusterEnabled()).toBe(true);
  });
});

describe("model ids", () => {
  it("are NativeCluster's ids behind its prefix", () => {
    expect(providerForModel("nativecluster/qwen3.8:27b")).toBe("nativecluster");
    expect(resolveModel("nativecluster/qwen3.8:27b", "")).toBe(
      "nativecluster/qwen3.8:27b",
    );
    expect(resolveModel("nativecluster/org/model-q4_K_M", "")).toBe(
      "nativecluster/org/model-q4_K_M",
    );
    for (const bad of [
      "nativecluster/",
      "nativecluster/../x",
      "nativecluster/a b",
      "nativecluster/a?b",
    ]) {
      expect(resolveModel(bad, "")).toBe("");
    }
  });

  it("think on or off", () => {
    expect(reasoningLevelsForModel("nativecluster/qwen3.8:27b")).toEqual([
      "none",
      "high",
    ]);
  });
});

describe("the cluster's models", () => {
  function stubListing() {
    vi.stubEnv("NATIVECLUSTER_BASE_URL", "http://nc.test/v1");
    vi.stubEnv("NATIVECLUSTER_API_KEY", "nct_listing");
    const fetchMock = vi.fn(async () => Response.json(MODELS_BODY));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("lists GET /v1/models with the key, once a minute", async () => {
    const fetchMock = stubListing();
    const models = await listNativeClusterModels();
    expect(models.map((model) => model.id)).toEqual([
      "qwen3.8:27b",
      "gemma4:4b",
      "bge-m3",
    ]);
    expect(models[0]).toEqual({
      id: "qwen3.8:27b",
      kind: "chat",
      contextLength: 65536,
      maxOutputTokens: 8192,
      capabilities: ["completion", "tools", "thinking"],
    });
    await listNativeClusterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://nc.test/v1/models");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer nct_listing",
    );
  });

  it("offers chat models that call tools", async () => {
    stubListing();
    const chat = (await listNativeClusterModels()).filter(
      isNativeClusterChatModel,
    );
    expect(chat.map((model) => model.id)).toEqual(["qwen3.8:27b"]);
  });

  it("answers an empty list when NativeCluster is down", async () => {
    vi.stubEnv("NATIVECLUSTER_API_KEY", "nct_listing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(listNativeClusterModels()).resolves.toEqual([]);
  });

  it("gives the window NativeCluster states, once listed", async () => {
    stubListing();
    expect(contextWindowFor("nativecluster/qwen3.8:27b")).toBeUndefined();
    await listNativeClusterModels();
    expect(contextWindowFor("nativecluster/qwen3.8:27b")).toBe(65536);
    expect(contextWindowFor("nativecluster/gemma4:4b")).toBe(32768);
    expect(contextWindowFor("nativecluster/bge-m3")).toBeUndefined();
    expect(contextWindowFor("nativecluster/unknown")).toBeUndefined();
    expect(contextWindowFor("claude-sonnet-5-5")).toBeUndefined();
  });

  it("defaults work to the person's NativeCluster model, then the deployment's, then the first listed", async () => {
    stubListing();
    vi.stubEnv("NATIVECLUSTER_MODEL", "");
    await expect(
      defaultNativeClusterModel("nativecluster/gemma4:4b"),
    ).resolves.toBe("nativecluster/gemma4:4b");
    await expect(defaultNativeClusterModel("claude-sonnet-5-5")).resolves.toBe(
      "nativecluster/qwen3.8:27b",
    );
    vi.stubEnv("NATIVECLUSTER_MODEL", "gemma4:4b");
    await expect(defaultNativeClusterModel(null)).resolves.toBe(
      "nativecluster/gemma4:4b",
    );
  });
});

describe("request body", () => {
  it("turns Mike's reasoning level into think, for a model that thinks", () => {
    expect(
      nativeClusterRequestBody(
        { model: "m", reasoning_effort: "high" },
        { thinks: true },
      ),
    ).toEqual({ model: "m", think: true });
    expect(
      nativeClusterRequestBody(
        { model: "m", reasoning_effort: "none" },
        { thinks: true },
      ),
    ).toEqual({ model: "m", think: false });
    expect(
      nativeClusterRequestBody(
        { model: "m", reasoning_effort: "high" },
        { thinks: false },
      ),
    ).toEqual({ model: "m" });
  });
});
