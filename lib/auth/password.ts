import type { SupabaseClient } from "@supabase/supabase-js";

export const PASSWORD_MIN_LENGTH = 8;

export function passwordValidationError(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use a password with at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

export function passwordConfirmationError(
  password: string,
  confirmation: string,
) {
  return passwordValidationError(password) ??
    (password !== confirmation ? "The passwords do not match." : null);
}

export async function preparePasswordSetupSession(
  client: SupabaseClient,
  currentUrl: string,
) {
  const url = new URL(currentUrl);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const callbackError =
    url.searchParams.get("error_description") ??
    hash.get("error_description") ??
    url.searchParams.get("error") ??
    hash.get("error");
  if (callbackError) {
    throw new Error(
      "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
    );
  }

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      throw new Error(
        "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
      );
    }
  } else if (
    tokenHash &&
    url.searchParams.get("type") === "recovery"
  ) {
    const { error } = await client.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    if (error) {
      throw new Error(
        "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
      );
    }
  } else {
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    if (!accessToken || !refreshToken) {
      throw new Error(
        "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
      );
    }
    const { error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      throw new Error(
        "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
      );
    }
  }

  const {
    data: { session },
    error,
  } = await client.auth.getSession();
  if (error || !session) {
    throw new Error(
      "This account setup link is invalid, expired, or has already been used. Request a new link and try again.",
    );
  }
  return session;
}

export async function requestPasswordRecovery(
  client: SupabaseClient,
  email: string,
  redirectTo: string,
) {
  const { error } = await client.auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
    { redirectTo },
  );
  if (error) {
    throw new Error(
      "The recovery email could not be requested right now. Check your connection and try again.",
    );
  }
}
