const RECOVERY_PATH = "/reset-password";
const INVITATION_PATH = "/accept-invite";

function callbackParameters(url: URL) {
  return {
    search: url.searchParams,
    hash: new URLSearchParams(url.hash.replace(/^#/, "")),
  };
}

export function isPasswordRecoveryCallback(currentUrl: string) {
  const url = new URL(currentUrl);
  const { search, hash } = callbackParameters(url);
  return (
    search.get("type") === "recovery" ||
    hash.get("type") === "recovery" ||
    search.get("auth_action") === "recovery"
  );
}

export function isInvitationCallback(currentUrl: string) {
  const url = new URL(currentUrl);
  const { search, hash } = callbackParameters(url);
  return (
    search.get("type") === "invite" ||
    hash.get("type") === "invite" ||
    search.get("auth_action") === "invite"
  );
}

export function passwordRecoveryDestination(currentUrl: string) {
  const url = new URL(currentUrl);
  if (url.pathname === RECOVERY_PATH || !isPasswordRecoveryCallback(currentUrl)) {
    return null;
  }
  return `${RECOVERY_PATH}${url.search}${url.hash}`;
}

export function invitationDestination(currentUrl: string) {
  const url = new URL(currentUrl);
  if (
    url.pathname === INVITATION_PATH ||
    !isInvitationCallback(currentUrl)
  ) {
    return null;
  }
  return `${INVITATION_PATH}${url.search}${url.hash}`;
}

export function authCallbackDestination(currentUrl: string) {
  return (
    passwordRecoveryDestination(currentUrl) ??
    invitationDestination(currentUrl)
  );
}
