/* Server-side authentication for the API routes.
 *
 * The client (AuthGate.tsx) only proved identity in the browser, so anyone could
 * POST directly to the AI endpoints and burn the Qwen quota. This module adds a
 * real server check:
 *   1. At sign-in the client sends its Google ID token to POST /api/auth.
 *      We verify the token's signature against Google's public keys, then check
 *      audience (our client id) and hosted-domain (@keitsz.edu.hk).
 *   2. On success we mint our own short signature-checked session cookie
 *      (HttpOnly, 30 days) so later API calls don't need a fresh Google token.
 *   3. Each AI route calls requireAuth() to reject requests without a valid
 *      session cookie.
 *
 * Rollout safety: enforcement only turns on once SESSION_SECRET is configured.
 * If it is unset the routes behave exactly as before (no breakage), but a
 * warning is logged so the gap is visible.
 */
import { NextRequest, NextResponse } from "next/server";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";

export const SESSION_COOKIE = "ksz_session";
const ALLOWED_DOMAIN = "keitsz.edu.hk";
const SESSION_DAYS = 30;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const CLIENT_ID =
  process.env.AUTH_GOOGLE_CLIENT_ID ||
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  "623198168089-oht8mb2d4pi444g4imks1ncn1sdgkg44.apps.googleusercontent.com";

function getSessionSecret(): Uint8Array | null {
  const raw = process.env.SESSION_SECRET;
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

/** Whether server-side enforcement is active (i.e. a session secret is set). */
export function authEnabled(): boolean {
  return !!process.env.SESSION_SECRET;
}

// Google's rotating public keys, fetched + cached by jose.
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export type SessionClaims = { email: string; name?: string };

/**
 * Verify a Google ID token (the `credential` from Google Identity Services).
 * Throws if the signature, audience, issuer, expiry, hosted domain or email
 * verification fails. Returns the claims we care about on success.
 */
export async function verifyGoogleCredential(credential: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(credential, googleJwks, {
    issuer: GOOGLE_ISSUERS,
    audience: CLIENT_ID,
  });
  const email = String(payload.email || "");
  const hd = String(payload.hd || email.split("@")[1] || "");
  if (hd !== ALLOWED_DOMAIN) {
    throw new Error(`此網站只開放給 @${ALLOWED_DOMAIN} 帳號使用`);
  }
  if (payload.email_verified === false) {
    throw new Error("Google 帳號電郵尚未驗證");
  }
  return { email, name: payload.name ? String(payload.name) : undefined };
}

/** Mint a signed session JWT (HS256) valid for SESSION_DAYS. */
export async function createSessionToken(claims: SessionClaims): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET 未設定");
  return new SignJWT({ email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret);
}

/** Verify our own session cookie. Returns claims or null. */
export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return { email: String(payload.email || ""), name: payload.name ? String(payload.name) : undefined };
  } catch {
    return null;
  }
}

/** Cookie attributes shared by login (set) and logout (clear). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

/**
 * Guard for API routes. Returns a 401 NextResponse if the caller is not
 * authenticated, or null if the request may proceed. When SESSION_SECRET is
 * unset, enforcement is disabled (returns null) so existing deploys keep working.
 */
export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  if (!authEnabled()) {
    console.warn("[auth] SESSION_SECRET not set — API routes are UNPROTECTED. Set it to enable enforcement.");
    return null;
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySessionToken(token) : null;
  if (!claims) {
    return NextResponse.json({ error: "未登入或登入已過期，請重新登入。", auth_required: true }, { status: 401 });
  }
  return null;
}

/* ───────────── Student app (數學小助教) — class-code access ───────────── */

export const STUDENT_COOKIE = "ksz_student";

/** Valid class codes from the CLASS_CODES env (comma-separated). Falls back to a
 * default so the app works right after deploy; override via CLASS_CODES. */
function getClassCodes(): string[] {
  const raw = process.env.CLASS_CODES;
  if (raw && raw.trim()) return raw.split(",").map(s => s.trim()).filter(Boolean);
  return ["math2026"];
}

export function verifyClassCode(code: unknown): boolean {
  const c = String(code ?? "").trim();
  if (!c) return false;
  return getClassCodes().includes(c);
}

/** Mint a signed student session (separate role from the teacher session). */
export async function createStudentSessionToken(classCode: string): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET 未設定");
  return new SignJWT({ role: "student", class: classCode })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret);
}

async function verifyStudentSession(token: string): Promise<boolean> {
  const secret = getSessionSecret();
  if (!secret) return false;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.role === "student";
  } catch {
    return false;
  }
}

/** Guard for the student app's API: accept a valid student OR teacher session. */
export async function requireStudentOrTeacher(req: NextRequest): Promise<NextResponse | null> {
  if (!authEnabled()) {
    console.warn("[auth] SESSION_SECRET not set — API routes are UNPROTECTED.");
    return null;
  }
  const studentTok = req.cookies.get(STUDENT_COOKIE)?.value;
  if (studentTok && await verifyStudentSession(studentTok)) return null;
  const teacherTok = req.cookies.get(SESSION_COOKIE)?.value;
  if (teacherTok && await verifySessionToken(teacherTok)) return null;
  return NextResponse.json({ error: "未登入或代碼已過期，請重新輸入班級代碼。", auth_required: true }, { status: 401 });
}
