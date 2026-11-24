const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  backendModelEnvironment,
  findNativeCluster,
  parseEnvCommandOutput,
} = require("./nativecluster");

function fakeCommand(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-nativecluster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = path.join(dir, "nativecluster");
  fs.writeFileSync(command, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const envFile = path.join(dir, "env.sh");
  fs.writeFileSync(envFile, "export NATIVECLUSTER_API_KEY='nct_test'\n", { mode: 0o600 });
  return { command, envFile, dir };
}

test("reads the env file and base URL `nativecluster env --json` prints", () => {
  assert.deepEqual(
    parseEnvCommandOutput(JSON.stringify({
      ok: true,
      data: { base_url: "http://localhost:8487/v1/", tool: "nativecluster", env_file: "/Users/me/nc/cli/env.sh" },
    })),
    { envFile: "/Users/me/nc/cli/env.sh", baseUrl: "http://localhost:8487/v1" },
  );
  assert.deepEqual(
    parseEnvCommandOutput(
      "OPENAI_BASE_URL=http://localhost:8487/v1\n" +
        "The key is in /Users/me/nc/cli/env.sh (only you can read it). In a shell: . '/Users/me/nc/cli/env.sh'\n",
    ),
    { envFile: "/Users/me/nc/cli/env.sh", baseUrl: "http://localhost:8487/v1" },
  );
  assert.equal(parseEnvCommandOutput(JSON.stringify({ ok: false, error: { message: "not running" } })), null);
  assert.equal(parseEnvCommandOutput(JSON.stringify({ ok: true, data: { env_file: "relative/env.sh" } })), null);
  assert.equal(parseEnvCommandOutput(""), null);
});

test("finds NativeCluster through its command, asking for JSON and nothing else", async (t) => {
  const { command, envFile, dir } = fakeCommand(t, "");
  const args = path.join(dir, "args");
  fs.writeFileSync(command, `#!/bin/sh\necho "$@" > '${args}'\nprintf '%s' '{"ok":true,"data":{"base_url":"http://localhost:8487/v1","env_file":"${envFile}"}}'\n`, { mode: 0o755 });
  const found = await findNativeCluster({ command });
  assert.deepEqual(found, { envFile, baseUrl: "http://localhost:8487/v1" });
  assert.equal(fs.readFileSync(args, "utf8").trim(), "env --json");
});

test("keeps Ollama when NativeCluster is missing, refuses, or names no file", async (t) => {
  assert.equal(await findNativeCluster({ command: path.join(os.tmpdir(), "no-such-nativecluster") }), null);
  const refusing = fakeCommand(t, `echo '{"ok":false}'; exit 4`);
  assert.equal(await findNativeCluster({ command: refusing.command }), null);
  const missingFile = fakeCommand(t, `echo '{"ok":true,"data":{"env_file":"/nonexistent/env.sh"}}'`);
  assert.equal(await findNativeCluster({ command: missingFile.command }), null);
  const hanging = fakeCommand(t, "exec sleep 30");
  assert.equal(await findNativeCluster({ command: hanging.command, timeoutMs: 200 }), null);
});

test("points the backend at NativeCluster alone, or at Ollama as before", () => {
  assert.deepEqual(
    backendModelEnvironment({ envFile: "/Users/me/nc/cli/env.sh", baseUrl: "http://localhost:8487/v1" }),
    {
      NATIVECLUSTER_BASE_URL: "http://localhost:8487/v1",
      NATIVECLUSTER_ENV_FILE: "/Users/me/nc/cli/env.sh",
      MIKE_INFERENCE_PROVIDER: "nativecluster",
    },
  );
  assert.deepEqual(backendModelEnvironment(null), { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" });
});
