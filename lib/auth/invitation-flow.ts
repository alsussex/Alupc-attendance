export const PRODUCTION_APP_ORIGIN =
  "https://alupc-attendance.vercel.app";
export const INVITATION_SETUP_PATH = "/auth/setup-password";

function validOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveApplicationOrigin({
  configuredUrl,
  requestUrl,
  production,
}: {
  configuredUrl?: string;
  requestUrl?: string;
  production: boolean;
}) {
  const configured = validOrigin(configuredUrl);
  if (configured) return configured;
  if (!production) {
    const requestOrigin = validOrigin(requestUrl);
    if (requestOrigin) return requestOrigin;
  }
  return PRODUCTION_APP_ORIGIN;
}

export function applicationOrigin(requestUrl?: string) {
  return resolveApplicationOrigin({
    configuredUrl: process.env.APP_URL,
    requestUrl,
    production: process.env.NODE_ENV === "production",
  });
}

export function invitationSetupUrl(requestUrl?: string) {
  return `${applicationOrigin(requestUrl)}${INVITATION_SETUP_PATH}`;
}

export function safeInvitationNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return INVITATION_SETUP_PATH;
  }
  const candidate = new URL(value, PRODUCTION_APP_ORIGIN);
  if (candidate.pathname !== INVITATION_SETUP_PATH) {
    return INVITATION_SETUP_PATH;
  }
  return `${candidate.pathname}${candidate.search}`;
}
