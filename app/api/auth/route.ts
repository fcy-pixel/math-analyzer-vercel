/* Auth endpoint: exchange a Google ID token for a server session cookie. */
import { NextRequest, NextResponse } from "next/server";
import {
  verifyGoogleCredential,
  createSessionToken,
  authEnabled,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "edge";

/** POST { credential } — verify Google token, set HttpOnly session cookie. */
export async function POST(req: NextRequest) {
  // When enforcement is off there is no secret to sign with; report success so
  // the existing client flow is unaffected.
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, enforced: false });
  }
  try {
    const { credential } = await req.json();
    if (!credential || typeof credential !== "string") {
      return NextResponse.json({ error: "缺少 Google 登入憑證" }, { status: 400 });
    }
    const claims = await verifyGoogleCredential(credential);
    const token = await createSessionToken(claims);
    const res = NextResponse.json({ ok: true, enforced: true, email: claims.email });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `登入驗證失敗：${msg}` }, { status: 401 });
  }
}

/** DELETE — clear the session cookie (sign out). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
