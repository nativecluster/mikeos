// HTTP layer for the auth module.
//
// Everything that genuinely needs req/res lives here: creating the
// cookie-bearing Supabase client, clearing auth cookies, reading the request
// origin, and rendering GoTrue's errors as safe responses. The payload
// schemas, the redirect-URL construction, and the GoTrue calls themselves are
// in auth.service.ts.

import { Router, type Request, type Response } from "express";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import {
  clearRequestAuthCookies,
  createRequestSupabase,
  publicAuthUser,
} from "../../lib/authSession";
import { ssoConfiguration, ssoDomainSchema } from "../../lib/ssoConfig";
import {
  sendInternalError,
  sendUpstreamUnavailable,
} from "../../lib/httpError";
import { isAuthUpstreamFailure } from "../../lib/authUpstream";
import { AppError } from "../../lib/appError";
import { reportError, setOperation } from "../../lib/observability/sentry";
import { requestOriginIsWordAddin } from "../../lib/origins";
import { appAccessToken, ncAppMode, ncPersonOf } from "../../lib/authApp";
import {
  appSessionTokens,
  createAppAuthSupabase,
  createAppSessionSupabase,
} from "../../lib/authAppSession";
import { NC_PERSON_REQUIRED_DETAIL } from "../../lib/authPersonBinding";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { requireTrustedOrigin } from "../../middleware/trustedOrigin";
import {
  applyHandoffSession,
  bindAccountToPerson,
  buildCallbackUrl,
  challengeAndVerifyMfa,
  challengeMfaFactor,
  consumeWordHandoff,
  createFirstAccount,
  emailSignupOpen,
  SIGNUP_EMAIL_NOT_CONFIGURED_DETAIL,
  credentialsSchema,
  currentUser,
  emailSchema,
  enrollMfaFactor,
  exchangeCodeForSession,
  exchangeSchema,
  factorSchema,
  friendlyNameSchema,
  handoffSchema,
  issueWordHandoff,
  listMfaFactors,
  mfaAssuranceLevel,
  passwordSchema,
  refreshAppSession,
  refreshSchema,
  revokeAppSession,
  sendPasswordReset,
  signInWithPassword,
  signInOptions,
  signOut,
  signUpWithPassword,
  startGoogleOAuth,
  ssoRequestSchema,
  startSsoSignIn,
  unenrollMfaFactor,
  updateEmail,
  updatePassword,
  verificationSchema,
  verifyMfaChallenge,
  signupSchema,
} from "./auth.service";
import {
  describeAuthProviderError,
  describeAuthValidationIssues,
} from "./auth.messages";

export const authRouter = Router();

authRouter.use(requireTrustedOrigin);
authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

function requestOrigin(req: Request): string {
  return new URL(req.get("origin") as string).origin;
}

function callbackUrl(
  req: Request,
  next: unknown,
  fallback: string,
  path = "/auth/callback",
): string {
  return buildCallbackUrl(requestOrigin(req), next, fallback, path);
}

function authError(
  res: Response,
  error: unknown,
  fallback = "Authentication could not be completed.",
) {
  const wire = describeAuthProviderError(error, fallback);
  if (wire.status < 500) {
    return res.status(wire.status).json({ code: wire.code, detail: wire.detail });
  }
  // A server-side failure goes through sendInternalError, the one place a
  // 5xx becomes a Sentry event: reported once, logged, and marked so the
  // response sanitizer does not file it again. GoTrue being unreachable (no
  // answer, or a gateway 502/503/504) is an outage the user can only wait
  // out: 503 upstream_unavailable. A GoTrue 500 is GoTrue failing on
  // something of ours, so it stays a 500.
  const failure = new AppError(
    "auth.supabase_unavailable",
    "unexpected server-side authentication failure",
    { cause: error },
  );
  if (isAuthUpstreamFailure(error)) return sendUpstreamUnavailable(res, failure);
  return sendInternalError(res, failure);
}

function invalidBody(
  res: Response,
  issues?: ReadonlyArray<{ path: PropertyKey[]; code: string; message?: string }>,
) {
  res.status(400).json(describeAuthValidationIssues(issues ?? []));
}

/**
 * The client holding the signed-in session these routes act on: the cookie
 * client requireAuth made, or, in the NativeCluster app, one holding the
 * access token the request presented.
 */
function sessionClient(_req: Request, res: Response): SupabaseClient | null {
  if (ncAppMode() && res.locals.authSource === "app") {
    const token = typeof res.locals.token === "string" ? res.locals.token : "";
    if (token) {
      return createAppSessionSupabase(token, res.locals.authUser as User | undefined);
    }
  }
  const client = res.locals.authClient as SupabaseClient | undefined;
  if (!client || res.locals.authSource !== "cookie") {
    res.status(401).json({
      code: "cookie_session_required",
      detail: "A cookie-authenticated session is required.",
    });
    return null;
  }
  return client;
}

// ---------------------------------------------------------------------------
// The NativeCluster app (lib/authApp.ts): no cookies, so the tokens travel in
// JSON bodies, and two keys, so every session is bound to the NativeCluster
// person signed in to the window.
// ---------------------------------------------------------------------------

/** A sign-in route that needs a cookie or a redirect, refused in the app. */
function refuseInApp(res: Response) {
  res.status(403).json({
    code: "nc_app_unavailable",
    detail: "This way of signing in isn't available in the NativeCluster app.",
  });
}

/** Nobody is signed in to NativeCluster: nobody may sign in to Mike. */
function refuseWithoutPerson(req: Request, res: Response): string | null {
  const person = ncPersonOf(req);
  if (person) return person;
  res.status(403).json({ code: "nc_person_required", detail: NC_PERSON_REQUIRED_DETAIL });
  return null;
}

/**
 * Bind the account a session was just made for to `person` and answer the
 * session's tokens; or, when the account is someone else's, revoke the new
 * session and refuse. Returns false once it has answered a refusal.
 */
async function bindNewSession(
  res: Response,
  user: User,
  session: Session,
  person: string,
): Promise<boolean> {
  const db = createServerSupabase();
  const bound = await bindAccountToPerson(db, user.id, person);
  if (bound.ok) return true;
  try {
    const { error } = await revokeAppSession(db, session.access_token);
    if (error) throw error;
  } catch (error) {
    reportError(
      new AppError("auth.supabase_unavailable", "refused app session could not be revoked", {
        cause: error,
      }),
      { level: "warning", tags: { component: "http" } },
    );
  }
  if (bound.reason === "lookup_failed") {
    sendInternalError(
      res,
      new AppError("db.query_failed", "NativeCluster account binding failed", {
        cause: bound.error,
      }),
    );
    return false;
  }
  res.status(bound.status).json({ code: bound.code, detail: bound.detail });
  return false;
}

async function appSignIn(
  req: Request,
  res: Response,
  credentials: { email: string; password: string },
  status = 200,
) {
  const person = refuseWithoutPerson(req, res);
  if (!person) return;
  try {
    const client = createAppAuthSupabase();
    const { data, error } = await signInWithPassword(client, credentials);
    if (error || !data.user || !data.session) return authError(res, error);
    if (!(await bindNewSession(res, data.user, data.session, person))) return;
    res.status(status).json({
      user: publicAuthUser(data.user),
      session: appSessionTokens(data.session),
    });
  } catch (error) {
    authError(res, error);
  }
}

authRouter.post("/login", asyncRoute(async (req, res) => {
  setOperation("auth.signin");
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);
  if (ncAppMode()) return appSignIn(req, res, parsed.data);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await signInWithPassword(client, parsed.data);
    if (error || !data.user || !data.session) return authError(res, error);
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/signup", asyncRoute(async (req, res) => {
  setOperation("auth.signup");
  // Refuse before GoTrue creates an account that can never be confirmed.
  if (!emailSignupOpen()) {
    return res.status(403).json({
      code: "signup_email_not_configured",
      detail: SIGNUP_EMAIL_NOT_CONFIGURED_DETAIL,
    });
  }
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);
  if (ncAppMode()) return appSignUp(req, res, parsed.data);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await signUpWithPassword(
      client,
      parsed.data,
      callbackUrl(req, req.body?.next, "/onboarding/profile"),
    );
    if (error || !data.user) return authError(res, error);
    res.status(201).json({
      user: publicAuthUser(data.user),
      requiresEmailConfirmation: !data.session,
    });
  } catch (error) {
    authError(res, error);
  }
}));

async function appSignUp(
  req: Request,
  res: Response,
  credentials: { email: string; password: string },
) {
  const person = refuseWithoutPerson(req, res);
  if (!person) return;
  try {
    const client = createAppAuthSupabase();
    const { data, error } = await signUpWithPassword(
      client,
      credentials,
      callbackUrl(req, req.body?.next, "/onboarding/profile"),
    );
    if (error || !data.user) return authError(res, error);
    // A session now means GoTrue confirmed the account at once (the app's
    // own GoTrue autoconfirms): this is its first sign-in, so bind it.
    // Without one, the binding waits for the first log-in.
    if (data.session && !(await bindNewSession(res, data.user, data.session, person))) {
      return;
    }
    res.status(201).json({
      user: publicAuthUser(data.user),
      requiresEmailConfirmation: !data.session,
      ...(data.session ? { session: appSessionTokens(data.session) } : {}),
    });
  } catch (error) {
    authError(res, error);
  }
}

// Which sign-in routes to offer, and whether this instance still needs its
// first account. Public: the login page asks before anyone is signed in.
authRouter.get("/options", asyncRoute(async (_req, res) => {
  setOperation("auth.options");
  try {
    res.json(await signInOptions(createServerSupabase()));
  } catch (error) {
    sendInternalError(
      res,
      new AppError("auth.options_failed", "Sign-in options could not be read", {
        cause: error,
      }),
    );
  }
}));

// First-run setup: create the instance's first account and sign it in.
authRouter.post("/setup", asyncRoute(async (req, res) => {
  setOperation("auth.setup");
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);
  if (ncAppMode() && !refuseWithoutPerson(req, res)) return;

  let result: Awaited<ReturnType<typeof createFirstAccount>>;
  try {
    result = await createFirstAccount(createServerSupabase(), parsed.data);
  } catch (error) {
    return sendInternalError(
      res,
      new AppError("auth.setup_failed", "First-run setup could not be completed", {
        cause: error,
      }),
    );
  }
  if (!result.ok) {
    if (result.reason === "auth_error") return authError(res, result.error);
    return res.status(409).json({
      code: "setup_complete",
      detail: "This Mike instance is already set up. Log in instead.",
    });
  }

  if (ncAppMode()) return appSignIn(req, res, parsed.data, 201);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await signInWithPassword(client, parsed.data);
    if (error || !data.user || !data.session) return authError(res, error);
    res.status(201).json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
}));

async function startSso(req: Request, res: Response) {
  try {
    const config = ssoConfiguration();
    if (!config.enabled) {
      return res
        .status(403)
        .json({
          code: "sso_disabled",
          detail: "Single sign-on is not enabled.",
        });
    }
    const parsed = ssoRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res);
    const emailDomain = parsed.data.email.slice(
      parsed.data.email.lastIndexOf("@") + 1,
    );
    const parsedDomain = ssoDomainSchema.safeParse(emailDomain);
    if (!parsedDomain.success) return invalidBody(res);
    const domain = parsedDomain.data;
    if (config.allowedDomains && !config.allowedDomains.includes(domain)) {
      return res
        .status(400)
        .json({
          code: "sso_domain_not_allowed",
          detail: "Single sign-on is not available for this domain.",
        });
    }
    const client = createRequestSupabase(req, res);
    const { data, error } = await startSsoSignIn(
      client,
      domain,
      callbackUrl(req, req.body?.next, "/onboarding/profile"),
    );
    if (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        return res
          .status(400)
          .json({
            code: "sso_unavailable",
            detail: "Unable to start single sign-on for this domain.",
          });
      }
      throw new Error("SSO provider request failed", { cause: error });
    }
    if (!data?.url) throw new Error("Missing SSO redirect");
    return res.json({ url: data.url });
  } catch (error) {
    // The thrown value stays the cause so the event names what failed
    // (a GoTrue status, a network code) without its message ever leaving.
    return sendInternalError(
      res,
      new AppError("auth.sso_failed", "SSO sign-in could not be started", {
        cause: error,
      }),
    );
  }
}

authRouter.post("/oauth", asyncRoute(async (req, res) => {
  setOperation("auth.signin");
  if (ncAppMode()) return refuseInApp(res);
  if (req.body?.provider === "sso") return startSso(req, res);
  if (req.body?.provider !== "google") return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await startGoogleOAuth(
      client,
      callbackUrl(
        req,
        req.body?.next,
        "/onboarding/profile",
        req.body?.callbackPath === "/oauth-dialog.html"
          ? "/oauth-dialog.html"
          : "/auth/callback",
      ),
    );
    if (error || !data.url) return authError(res, error);
    res.json({ url: data.url });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/exchange", asyncRoute(async (req, res) => {
  setOperation("auth.signin");
  if (ncAppMode()) return refuseInApp(res);
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await exchangeCodeForSession(
      client,
      parsed.data.code,
    );
    if (error || !data.user || !data.session) return authError(res, error);
    if (parsed.data.handoffRequestId) {
      setOperation("auth.handoff");
      if (!requestOriginIsWordAddin(req.get("origin"))) {
        res.status(403).json({
          code: "word_handoff_origin_required",
          detail: "The authentication handoff origin is not allowed.",
        });
        return;
      }
      const handoffTicket = await issueWordHandoff({
        userId: data.user.id,
        requestId: parsed.data.handoffRequestId,
        origin: requestOrigin(req),
        session: data.session,
      });
      res.json({ handoffTicket });
      return;
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/handoff", asyncRoute(async (req, res) => {
  setOperation("auth.handoff");
  if (ncAppMode()) return refuseInApp(res);
  const parsed = handoffSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  if (!requestOriginIsWordAddin(req.get("origin"))) {
    res.status(403).json({
      code: "word_handoff_origin_required",
      detail: "The authentication handoff origin is not allowed.",
    });
    return;
  }

  try {
    const handoff = await consumeWordHandoff({
      ticket: parsed.data.ticket,
      requestId: parsed.data.requestId,
      origin: requestOrigin(req),
    });
    if (!handoff) {
      res.status(400).json({
        code: "invalid_auth_handoff",
        detail: "This authentication handoff is invalid or has expired.",
      });
      return;
    }

    const client = createRequestSupabase(req, res);
    const { data, error } = await applyHandoffSession(client, {
      accessToken: handoff.accessToken,
      refreshToken: handoff.refreshToken,
    });
    if (
      error ||
      !data.user ||
      !data.session ||
      data.user.id !== handoff.userId
    ) {
      clearRequestAuthCookies(req, res);
      return authError(
        res,
        error,
        "Authentication handoff could not be completed.",
      );
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error, "Authentication handoff could not be completed.");
  }
}));

authRouter.post("/password-reset", asyncRoute(async (req, res) => {
  setOperation("auth.signin");
  // Its link completes through a code verifier kept in a cookie.
  if (ncAppMode()) return refuseInApp(res);
  const email = emailSchema.safeParse(req.body?.email);
  if (email.success) {
    try {
      const client = createRequestSupabase(req, res);
      const { error } = await sendPasswordReset(
        client,
        email.data,
        callbackUrl(req, "/reset-password", "/reset-password"),
      );
      if (error) throw error;
    } catch (error) {
      // Deliberately indistinguishable to prevent account enumeration: the
      // response is the same 204 either way. The failure itself is still
      // worth seeing (GoTrue down, or its mailer), so it is reported, as a
      // warning, with no trace of the address.
      reportError(
        new AppError("auth.password_reset_failed", "password reset request failed", {
          cause: error,
        }),
        { level: "warning", tags: { component: "http" } },
      );
    }
  }
  res.status(204).end();
}));

authRouter.get("/session", requireAuth, asyncRoute(async (_req, res) => {
  setOperation("auth.session");
  const client = sessionClient(_req, res);
  if (!client) return;
  const { user, error } = await currentUser(client);
  if (error || !user) return authError(res, error);
  res.json({ user: publicAuthUser(user) });
}));

// The NativeCluster app's refresh. The browser keeps the refresh token and
// trades it here before its access token expires (or after a 401); the
// rotated pair comes back in the body. Elsewhere the cookie client refreshes
// by itself and this route does not exist.
authRouter.post("/refresh", asyncRoute(async (req, res) => {
  setOperation("auth.session");
  if (!ncAppMode()) {
    return res.status(404).json({ code: "not_found", detail: "Not found." });
  }
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const person = refuseWithoutPerson(req, res);
  if (!person) return;
  try {
    const { data, error } = await refreshAppSession(
      createAppAuthSupabase(),
      parsed.data.refresh_token,
    );
    if (error || !data.session || !data.user) {
      const status = (error as { status?: unknown } | null)?.status;
      // GoTrue refused the refresh token (used, revoked, expired): the
      // browser must sign in again. An outage keeps its session (503).
      if (typeof status === "number" && status >= 400 && status < 500) {
        return res
          .status(401)
          .json({ code: "session_expired", detail: "Invalid or expired session" });
      }
      return authError(res, error);
    }
    if (!(await bindNewSession(res, data.user, data.session, person))) return;
    res.json({
      user: publicAuthUser(data.user),
      session: appSessionTokens(data.session),
    });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/logout", asyncRoute(async (req, res) => {
  setOperation("auth.session");
  if (ncAppMode()) {
    // The browser forgets its tokens whatever happens here; this revokes
    // the session in GoTrue so its refresh token is dead too.
    const token = appAccessToken(req);
    if (token) {
      try {
        const { error } = await signOut(
          createAppSessionSupabase(token),
          req.body?.scope === "global" ? "global" : "local",
        );
        if (error) throw error;
      } catch (error) {
        const failure = new AppError(
          "auth.supabase_unavailable",
          "upstream sign-out failed",
          { cause: error },
        );
        reportError(failure, { level: "warning", tags: { component: "http" } });
        console.error("[auth/logout] upstream sign-out failed", failure);
      }
    }
    return res.status(204).end();
  }
  try {
    const client = createRequestSupabase(req, res);
    await signOut(client, req.body?.scope === "global" ? "global" : "local");
  } catch (error) {
    // Local cookie removal must not depend on the upstream revocation request,
    // but a GoTrue that cannot revoke sessions is an outage worth seeing.
    const failure = new AppError(
      "auth.supabase_unavailable",
      "upstream sign-out failed",
      { cause: error },
    );
    reportError(failure, { level: "warning", tags: { component: "http" } });
    console.error("[auth/logout] upstream sign-out failed", failure);
  } finally {
    clearRequestAuthCookies(req, res);
  }
  res.status(204).end();
}));

authRouter.patch("/email", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.session");
  const email = emailSchema.safeParse(req.body?.email);
  if (!email.success) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await updateEmail(
    client,
    email.data,
    callbackUrl(req, req.body?.next, "/settings?emailChange=processed"),
  );
  if (error || !data.user) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.patch("/password", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.session");
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await updatePassword(client, parsed.data.password);
  if (error || !data.user) return authError(res, error);
  if (parsed.data.signOut) {
    await signOut(client, "global");
    clearRequestAuthCookies(req, res);
  }
  res.json({ user: publicAuthUser(data.user) });
}));

/**
 * A verified factor raises the session to aal2 with new tokens. The cookie
 * client wrote them to the cookie; in the NativeCluster app the browser
 * keeps them, so they are in the answer.
 */
function verifiedSessionAnswer(
  res: Response,
  data: {
    user: User;
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    token_type?: string;
  },
) {
  const user = publicAuthUser(data.user);
  if (res.locals.authSource !== "app") return { user };
  return { user, session: appSessionTokens(data) };
}

authRouter.get("/mfa/factors", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await listMfaFactors(client);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.get("/mfa/assurance", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await mfaAssuranceLevel(client);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.post("/mfa/enroll", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const friendlyName = friendlyNameSchema.safeParse(req.body?.friendlyName);
  if (!friendlyName.success) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await enrollMfaFactor(client, friendlyName.data);
  if (error) return authError(res, error);
  res.status(201).json(data);
}));

authRouter.post("/mfa/challenge", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const parsed = factorSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await challengeMfaFactor(client, parsed.data);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.post("/mfa/verify", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.challengeId) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await verifyMfaChallenge(client, {
    factorId: parsed.data.factorId,
    challengeId: parsed.data.challengeId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json(verifiedSessionAnswer(res, data));
}));

authRouter.post("/mfa/challenge-and-verify", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await challengeAndVerifyMfa(client, {
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json(verifiedSessionAnswer(res, data));
}));

authRouter.delete("/mfa/factors/:factorId", requireAuth, asyncRoute(async (req, res) => {
  setOperation("auth.mfa");
  const parsed = factorSchema.safeParse({ factorId: req.params.factorId });
  if (!parsed.success) return invalidBody(res);
  const client = sessionClient(req, res);
  if (!client) return;
  const { data, error } = await unenrollMfaFactor(client, parsed.data);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.use(routerErrorHandler("[auth]"));
