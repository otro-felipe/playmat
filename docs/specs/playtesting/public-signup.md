# Public landing and registration

### PUB-AC-01 — Public home and authorized play

Given a visitor without a session, when they open `/`, they see Thoughtseize’s landing page with links to create an account and sign in. An existing authenticated browser opens its play home on `/`. A visitor following a protected match link continues through sign-in with the original destination intact.

### PUB-AC-02 — Email signup

Given a visitor on `/register`, submitting a valid email requests a registration link. An accepted request shows the same check-your-email state regardless of whether an account exists. A failed request leaves the address editable and can be retried.

### PUB-AC-03 — First password

Given a visitor follows `/register/complete#token=…`, the token stays in the fragment until completion and only goes to the signup API in the request body. The player chooses a username and password. A successful response establishes a session and opens Thoughtseize. A taken username can be corrected without obtaining a new link. An invalid or expired link gives the player a path to request a fresh one. Opening the link alone does not consume it. A registration started from a match invitation returns to that match after verification in the same browser.

### PUB-AC-04 — Verify the visitor before requesting an email

When Turnstile is configured, the registration form enables submission only after receiving a challenge token. The form submits the token with the email address. After a failed request, the email address remains editable and resubmission requires a fresh challenge. When the challenge configuration or script cannot load, the form reports the error and leaves submission disabled.

## Browser coverage

`Mage.Web.Client/e2e/public-signup.spec.ts` uses the Thoughtseize product frontend build with controlled signup and identity responses.

- `[PUB-AC-01] public home offers signup and password sign-in`
- `[PUB-AC-02] retries a failed verification email request with the address intact`
- `[PUB-AC-03] submits a fragment token only when the player sets a password`
- `[PUB-AC-03] missing or expired links can be replaced`
- `[PUB-AC-03] signup from a match invitation preserves the match across tabs`
- `[PUB-AC-04] requires a fresh Turnstile token for each verification-email request`

## Product service

### PM-SIGNUP-AC-01 — Verify an email and set a password

A visitor can request a registration email. The link opens the public setup page without consuming the token. Submitting a valid username and password creates a verified account and signs it in. The account can subsequently sign in through the usual password form. Thoughtseize stores a digest of each token and disables email tracking for registration links.

### PM-SIGNUP-AC-02 — Enforce verification and uniqueness

A registration token expires after 30 minutes and can create only one account. Simultaneous completions cannot reuse it. Validation and username conflicts leave the link usable. A new registration cannot replace an existing username or create another account for a verified email. An address with an existing account receives the same request status as a new address.

### PM-SIGNUP-AC-03 — Limit email delivery and recover from failures

Repeated requests for the same address have a two-minute cooldown. Rate limits also apply to source addresses and the service as a whole. A provider failure does not mark the email as sent or lock the visitor out of retrying. Without a configured sender, signup is unavailable and password sign-in continues working.

### PM-SIGNUP-AC-04 — Verify a fresh challenge at the service boundary

When Turnstile is configured, the product verifies each email link request and password sign-in against the canonical public hostname and the action for that flow. Missing, rejected, or reused tokens stop the request before email delivery or password verification. A verification provider error also stops the request. Concurrent requests to the same product instance cannot share one accepted challenge. The signup configuration endpoint exposes only the public site key.

### HTTP and PostgreSQL coverage

- `ops/playtesting/product/product.test.mjs` — `[PM-SIGNUP-AC-01] creates a password account only after email verification`
- `ops/playtesting/product/product.test.mjs` — `[PM-SIGNUP-AC-02] rejects expired and reused links and preserves valid links after input conflicts`
- `ops/playtesting/product/product.test.mjs` — `[PM-SIGNUP-AC-03] limits delivery and releases failed delivery for retry`
- `ops/playtesting/product/product.test.mjs` — `[PM-SIGNUP-AC-04] browser auth verifies a fresh challenge for the correct action and hostname`
