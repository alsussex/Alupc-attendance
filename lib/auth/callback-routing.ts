const RECOVERY_PATH = "/reset-password";

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

export function passwordRecoveryDestination(currentUrl: string) {
  const url = new URL(currentUrl);
  if (url.pathname === RECOVERY_PATH || !isPasswordRecoveryCallback(currentUrl)) {
    return null;
  }
  return `${RECOVERY_PATH}${url.search}${url.hash}`;
}
