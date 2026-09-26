export const ANTHROPIC_VERSION = '2023-06-01';

// Buffer used to refresh the OAuth access token BEFORE it actually expires,
// so a request that grabs the token has plenty of time to finish.
export const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;

// Tokens with expiresAt further than this in the future are treated as
// `claude setup-token` long-lived tokens — no refresh attempted.
export const LONG_LIVED_TOKEN_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
