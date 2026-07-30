import { NextRequest, NextResponse } from "next/server";
import {
  applicationOrigin,
  safeInvitationNext,
} from "@/lib/auth/invitation-flow";
import {
  createConfirmationClient,
  type PendingAuthCookie,
} from "@/lib/supabase/confirm-server";

function applyAuthResponse(
  response: NextResponse,
  cookies: PendingAuthCookie[],
  headers: Record<string, string>,
) {
  for (const cookie of cookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  response.headers.set(
    "Cache-Control",
    "private, no-cache, no-store, must-revalidate, max-age=0",
  );
  return response;
}

function failedInvitation(request: NextRequest) {
  const destination = new URL(
    "/auth/setup-password?error=invalid_invitation",
    applicationOrigin(request.url),
  );
  return NextResponse.redirect(destination);
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");
  if (!tokenHash || type !== "invite") {
    return failedInvitation(request);
  }

  const pendingCookies: PendingAuthCookie[] = [];
  let authHeaders: Record<string, string> = {};
  try {
    const supabase = createConfirmationClient(
      request,
      (cookies, headers) => {
        pendingCookies.push(...cookies);
        authHeaders = { ...authHeaders, ...headers };
      },
    );
    const {
      data: { session },
      error,
    } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "invite",
    });
    if (error || !session) return failedInvitation(request);

    const next = safeInvitationNext(
      request.nextUrl.searchParams.get("next"),
    );
    const destination = new URL(next, applicationOrigin(request.url));
    destination.hash = new URLSearchParams({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      type: "invite",
    }).toString();
    return applyAuthResponse(
      NextResponse.redirect(destination),
      pendingCookies,
      authHeaders,
    );
  } catch {
    return failedInvitation(request);
  }
}
