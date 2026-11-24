// NativeCluster on this Mac. NativeCluster runs models on a group's own Macs
// behind one OpenAI-compatible endpoint (http://localhost:8487/v1 here). Its
// command, when installed, writes a session for local tools to a file only
// its person can read and prints that file's path, never the key:
//
//   nativecluster env --json  ->  {"ok": true, "data": {"base_url", "env_file", "tool"}}
//
// When it answers, the backend is pointed at NativeCluster and every model
// call is kept there (MIKE_INFERENCE_PROVIDER=nativecluster); the backend
// reads the key from the file on each call, so a renewed session needs no
// restart. When it does not (not installed, not running, not signed in),
// Mike's local models stay on Ollama, as before.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NATIVECLUSTER_COMMAND = path.join(os.homedir(), ".local", "bin", "nativecluster");
const DEFAULT_BASE_URL = "http://localhost:8487/v1";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
// A command that asks the running app for a session; not a model call.
const ENV_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The env file and base URL `nativecluster env` printed, or null: its
 * --json envelope, or the two lines it prints as text.
 */
function parseEnvCommandOutput(stdout) {
  const text = String(stdout).trim();
  let found = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.ok !== false) {
      const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
      found = { envFile: data.env_file, baseUrl: data.base_url };
    }
  } catch {
    // "OPENAI_BASE_URL=<url>" and "The key is in <path> (only you can read it)."
    found = {
      envFile: /^The key is in (\/.+?) \(only you can read it\)/m.exec(text)?.[1],
      baseUrl: /^OPENAI_BASE_URL=(\S+)$/m.exec(text)?.[1],
    };
  }
  const envFile = typeof found?.envFile === "string" ? found.envFile.trim() : "";
  if (!envFile || !path.isAbsolute(envFile)) return null;
  const baseUrl = typeof found.baseUrl === "string" && /^https?:\/\//.test(found.baseUrl.trim())
    ? found.baseUrl.trim().replace(/\/+$/, "")
    : DEFAULT_BASE_URL;
  return { envFile, baseUrl };
}

function commandEnvironment(inherited = process.env) {
  const env = { HOME: os.homedir(), PATH: inherited.PATH || "/usr/bin:/bin" };
  for (const key of ["USER", "LOGNAME", "TMPDIR", "LANG"]) {
    if (typeof inherited[key] === "string") env[key] = inherited[key];
  }
  return env;
}

function runEnvCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      command,
      ["env", "--json"],
      // Nothing from the launching shell reaches it but what any command
      // needs to find its home; it must never wait on a terminal.
      {
        timeout: timeoutMs,
        env: commandEnvironment(),
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * NativeCluster's settings for the backend, or null when its command is
 * missing or does not answer with an env file that exists.
 */
async function findNativeCluster({
  command = NATIVECLUSTER_COMMAND,
  timeoutMs = ENV_COMMAND_TIMEOUT_MS,
} = {}) {
  try {
    fs.accessSync(command, fs.constants.X_OK);
  } catch {
    return null;
  }
  const stdout = await runEnvCommand(command, timeoutMs);
  if (stdout === null) return null;
  const found = parseEnvCommandOutput(stdout);
  if (!found || !fs.existsSync(found.envFile)) return null;
  return found;
}

/** The backend's model settings: NativeCluster alone when found, else Ollama. */
function backendModelEnvironment(nativeCluster) {
  if (!nativeCluster) return { OLLAMA_BASE_URL };
  return {
    NATIVECLUSTER_BASE_URL: nativeCluster.baseUrl,
    NATIVECLUSTER_ENV_FILE: nativeCluster.envFile,
    MIKE_INFERENCE_PROVIDER: "nativecluster",
  };
}

module.exports = {
  NATIVECLUSTER_COMMAND,
  backendModelEnvironment,
  findNativeCluster,
  parseEnvCommandOutput,
};
