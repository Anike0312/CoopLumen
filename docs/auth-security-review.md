# Authentication Security Review

## Scope

This review covers wallet challenges, Ed25519 signature verification, session and refresh tokens, cookies, authorization middleware, and operator RBAC.

## Threat Review

| Threat | Control | Result |
| --- | --- | --- |
| Forged wallet identity | Challenge signatures are verified with the claimed Stellar public key | Mitigated |
| Challenge replay | Challenges are random, expire after five minutes, and are consumed before signature validation | Mitigated |
| Session forgery | Session payloads use HMAC-SHA256 and constant-time signature comparison | Mitigated |
| Token lifetime manipulation | Verification rejects missing/future `iat`, expired tokens, and lifetimes beyond one hour | Mitigated |
| Browser token theft | Session and refresh cookies are HTTP-only, SameSite Strict, and Secure in production | Mitigated |
| Refresh replay | Refresh tokens are random, stored only as hashes, single-use, and rotated | Mitigated |
| Authorization bypass | Community and operator guards fail closed and derive identity only from verified auth context | Mitigated |
| Credential disclosure | Logger-level recursive redaction removes bearer tokens, cookies, signatures, API keys, and Stellar secret seeds | Mitigated |

## Residual Risks

- Challenges and refresh tokens are process-local. Multi-instance production deployment must use a shared Redis-backed store.
- Stateless access tokens remain valid until their one-hour expiry after logout. Short expiry and refresh rotation limit exposure; a distributed revocation registry is recommended before custody of material funds.
- Authentication proves wallet control, not a legal identity. KYC and community role checks remain separate controls.

## Review Checklist

- Never accept an address from a request body as authorization identity.
- Never log raw authorization headers, cookies, signatures, tokens, or Stellar secret seeds.
- Keep authentication rate limits enabled at the shared Redis layer.
- Rotate `AUTH_SESSION_SECRET` through the deployment secret manager and never commit it.
- Re-run this review after changes to token encoding, cookies, signature verification, or RBAC.
