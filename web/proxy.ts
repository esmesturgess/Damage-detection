import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * A shared password for the whole site (HTTP Basic auth; any username), on when SITE_PASSWORD is set.
 * Until there are accounts, this keeps a deployed copy to the people given the password.
 */
export function proxy(request: NextRequest) {
  // Spaces pasted round the stored value aren't part of the password.
  const password = process.env.SITE_PASSWORD?.trim();
  if (!password) return NextResponse.next();
  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = decodeBasic(encoded);
    const given = decoded.slice(decoded.indexOf(":") + 1);
    if (sameText(given, password)) return NextResponse.next();
  }
  return new NextResponse("Password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Corroborator", charset="UTF-8"' },
  });
}

/** Base64 "user:password" from the browser, read as UTF-8 so characters like £ or é survive. */
function decodeBasic(encoded: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** Compares without stopping at the first difference, so timing doesn't reveal the password. */
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  // /api/health stays open so the host's health check gets through; it reveals nothing.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
