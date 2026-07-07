const getSafeRedirect = (redirectTo?: string) => {
  if (!redirectTo || redirectTo === "/") return "/repos";
  return redirectTo.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : "/repos";
};

const getAuthCallbackURL = (redirectTo?: string) => {
  const safeRedirect = getSafeRedirect(redirectTo);
  return safeRedirect === "/repos"
    ? "/repos"
    : `/auth/redirect?to=${encodeURIComponent(safeRedirect)}`;
};

export { getAuthCallbackURL, getSafeRedirect };
