/**
 * Cloudflare Access verification.
 *
 * Access enforcement lives on the *route*. If that route is ever
 * misconfigured, removed, or shadowed, requests arrive at the Worker with no
 * Access check at all — and a Worker that trusted the
 * Cf-Access-Authenticated-User-Email header on its own would happily serve the
 * club's finances to anyone who found the URL.
 *
 * So the Worker verifies the signed assertion itself. Together with
 * `workers_dev = false` in wrangler.toml, that is two independent controls:
 * the bypass URL does not exist, and if route protection ever fails, the app
 * fails CLOSED. (docs/DECISIONS.md D3)
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

export interface AccessIdentity {
  email: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { actorEmail: string };
};

/**
 * JWKS fetching is cached per team domain for the life of the isolate. jose
 * handles the HTTP caching and key rotation; this map just avoids rebuilding
 * the fetcher on every request.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * True only for a request that did NOT arrive through Cloudflare's edge.
 *
 * The request URL is not a usable signal here. Once `routes` is configured,
 * `wrangler dev` presents the production hostname to the Worker even when you
 * are hitting http://localhost:8787 — so a hostname check silently breaks
 * local development the day a route is added.
 *
 * Cloudflare stamps CF-Ray on every request that traverses its edge, and a
 * client cannot suppress or forge its absence. So no CF-Ray means this is a
 * local workerd process, which is exactly the condition we want.
 *
 * This is the second of two independent conditions: DEV_SKIP_ACCESS must ALSO
 * be set. A production deployment would need both a deliberately-set secret
 * and a request that never touched Cloudflare — two mistakes, not one.
 */
export function isLocalRequest(request: Request): boolean {
  return request.headers.get("CF-Ray") === null;
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 500 = 403,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

export async function verifyAccess(
  request: Request,
  env: Env,
): Promise<AccessIdentity> {
  // Local development escape hatch. Gated on the request actually arriving at
  // localhost, not merely on the flag being set — so a DEV_SKIP_ACCESS left in
  // a production environment cannot open the app to the internet.
  if (env.DEV_SKIP_ACCESS === "1" && isLocalRequest(request)) {
    return { email: env.DEV_ACTOR_EMAIL || "dev@localhost" };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;

  // Missing configuration must never mean "let everyone in".
  if (!teamDomain || !aud) {
    throw new AccessError(
      "Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)",
      500,
    );
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    readCookie(request.headers.get("Cookie"), "CF_Authorization");

  if (!token) throw new AccessError("No Access token");

  try {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: `https://${teamDomain}`,
      // Checking `aud` is what stops a token minted for a DIFFERENT Access
      // application on the same team from being replayed here.
      audience: aud,
    });

    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) throw new AccessError("Access token carries no email claim");

    return { email };
  } catch (err) {
    if (err instanceof AccessError) throw err;
    // jwtVerify covers signature, exp, nbf, iss and aud.
    throw new AccessError("Invalid Access token");
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

/** Hono middleware; puts the verified email in `c.var.actorEmail`. */
export function requireAccess(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    try {
      const { email } = await verifyAccess(c.req.raw, c.env);
      c.set("actorEmail", email);
    } catch (err) {
      const status = err instanceof AccessError ? err.status : 403;
      const message = err instanceof Error ? err.message : "Forbidden";
      return c.json({ error: message }, status);
    }
    await next();
  };
}
