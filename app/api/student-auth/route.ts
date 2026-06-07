/* Student app access: exchange a class code for a student session cookie. */
import { NextRequest, NextResponse } from "next/server";
import {
  verifyClassCode,
  createStudentSessionToken,
  authEnabled,
  STUDENT_COOKIE,
  SESSION_MAX_AGE,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "edge";

/** POST { code } — verify class code, set HttpOnly student session cookie. */
export async function POST(req: NextRequest) {
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, enforced: false });
  }
  try {
    const { code } = await req.json();
    if (!verifyClassCode(code)) {
      return NextResponse.json({ error: "班級代碼不正確，請向老師查詢。" }, { status: 401 });
    }
    const token = await createStudentSessionToken(String(code).trim());
    const res = NextResponse.json({ ok: true, enforced: true });
    res.cookies.set(STUDENT_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `登入失敗：${msg}` }, { status: 500 });
  }
}

/** DELETE — clear the student session cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(STUDENT_COOKIE, "", sessionCookieOptions(0));
  return res;
}
