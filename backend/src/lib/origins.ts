import { ncAppMode } from "./authApp";

export function configuredAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const developmentOrigins =
    env.NODE_ENV === "production"
      ? []
      : [
          ...(env.FRONTEND_URL ? [] : ["http://localhost:3000"]),
          ...(env.WORD_ADDIN_URL ? [] : ["https://localhost:3200"]),
        ];

  return new Set(
    [
      env.FRONTEND_URL ?? "http://localhost:3000",
      env.WORD_ADDIN_URL,
      ...(env.ALLOWED_ORIGINS ?? "").split(","),
      ...developmentOrigins,
    ]
      .map((origin) => origin?.trim().replace(/\/$/, ""))
      .filter((origin): origin is string => !!origin),
  );
}

export function requestOriginIsTrusted(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return false;
  try {
    return configuredAllowedOrigins(env).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function requestOriginIsWordAddin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured =
    env.WORD_ADDIN_URL?.trim() ||
    (env.NODE_ENV === "production" ? "" : "https://localhost:3200");
  if (!origin || !configured) return false;
  try {
    return new URL(origin).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

/**
 * In the NativeCluster app (MIKE_NC_APP=1) the pages are served at an origin
 * of the app's own, `https://127.0.0.1:<port>`, whose port differs per
 * computer, so no list configured in advance can name it. NativeCluster's
 * host passes the browser's own Host header on and the launcher keeps it, so
 * the app's own origin is the one whose host is the request's Host. Another
 * app on the same computer has another port and is refused. Off app mode
 * this is always false.
 */
export function requestOriginIsAppOwn(
  origin: string | undefined,
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!ncAppMode(env) || !origin || !host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** A configured origin, or in the NativeCluster app the request's own. */
export function requestOriginIsAllowed(
  origin: string | undefined,
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    requestOriginIsTrusted(origin, env) ||
    requestOriginIsAppOwn(origin, host, env)
  );
}
