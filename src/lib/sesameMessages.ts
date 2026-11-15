// What /login says when the round trip to Sésame ends badly (?sesame=…).
// Client-safe: no Node import, read by the login form and lib/sesameFlow.ts.
export const SESAME_ERRORS = {
  expired: "The sign-in through Sésame took too long or started elsewhere. Try again.",
  refused: "Sésame did not let you in to Winnow. Ask the administrator for access in Sésame.",
  failed: "Sésame's answer could not be checked. Try again.",
  unlinked:
    "No Winnow account is linked to this Sésame identity yet. Sign in with your password once, then choose Link Sésame in your account menu.",
  disabled: "This Winnow account is disabled.",
} as const;
export type SesameError = keyof typeof SESAME_ERRORS;
