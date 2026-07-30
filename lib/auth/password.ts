import type { SupabaseClient } from "@supabase/supabase-js";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RECOVERY_COOLDOWN_SECONDS = 60;

type AuthErrorDetails = {
  code?: string;
  message?: string;
  status?: number;
};

export class PasswordRecoveryRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = PASSWORD_RECOVERY_COOLDOWN_SECONDS) {
    super(
      "Supabase's email service has reached its temporary sending limit. Use the most recent recovery email, or wait before requesting another.",
    );
    this.name = "PasswordRecoveryRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryDelayFromMessage(message: string | undefined) {
  const match = message?.match(
    /(?:after|in|wait)\s+(\d+)\s*(?:second|seconds|sec|secs|s)\b/i,
  );
  if (!match) return PASSWORD_RECOVERY_COOLDOWN_SECONDS;
  return Math.max(PASSWORD_RECOVERY_COOLDOWN_SECONDS, Number(match[1]));
}

export function isPasswordRecoveryRateLimit(
  error: unknown,
): error is AuthErrorDetails {
  if (!error || typeof error !== "object") return false;
  const details = error as AuthErrorDetails;
  return (
    details.status === 429 ||
    details.code === "over_email_send_rate_limit" ||
    /rate.?limit|too many|security purposes.*(?:after|wait)/i.test(
      details.message ?? "",
    )
  );
}

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
    if (isPasswordRecoveryRateLimit(error)) {
      throw new PasswordRecoveryRateLimitError(
        retryDelayFromMessage(error.message),
      );
    }
    throw new Error(
      "The recovery email could not be requested right now. Check your connection and try again.",
    );
  }
}
