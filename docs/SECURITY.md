# Daily Pitch Drafter: security model

This repository is public. It holds only generic code and synthetic test data.
Passwords, keys, sheet locations and the brand prompt pack live in private
Netlify configuration and storage.

## Endpoints

| Route | Caller | Auth | Limits |
| --- | --- | --- | --- |
| `POST /api/login` | browser | password checked server-side → session cookie | attempts per IP and global (durable) |
| `GET /api/session` | browser | session cookie | — |
| `POST /api/logout` | browser | CSRF header; revokes the session id | — |
| `POST /api/sheet` | browser | session cookie + CSRF | body must be `{}` |
| `POST /api/draft` | browser | session cookie + CSRF | per-session and global usage (durable), one draft at a time per session |
| `POST /api/assess` | Apps Script automation | `x-assessment-secret` only (no cookies) | global usage (durable) |

Every route authorizes before it reads the prompt pack, fetches the sheet or
calls the model. The assessment secret is accepted only by `/api/assess`; a
browser session is not accepted there.

## Sessions

- Cookie `__Host-pd_session`: HMAC-SHA256 signed, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Expiry (`SESSION_TTL_HOURS`, default 12) is enforced on the server.
- Signed with `SESSION_SECRET`, which must be at least 32 characters and differ from `APP_PASSWORD`.
- **Sign out** revokes that session id on the server. If the revocation can't be recorded, the server returns 503 and keeps the cookie; the page says sign-out failed and the user stays signed in until a retry succeeds.
- **Sign everyone out:** change `SESSION_EPOCH` (or rotate `SESSION_SECRET`) and redeploy.
- Usage limits and the one-draft-at-a-time lock are **per session**, not per person: signing in again creates a new session. Global limits cap the total.
- Revocations live in the `pitch-drafter-security` Blobs store. **Deleting that store re-enables signed-out cookies that haven't expired**, so increment `SESSION_EPOCH` (and redeploy) before clearing it.
- Locks carry a unique owner token and are released by compare-and-set only by their owner, so a request whose lock expired can't release a newer holder's lock.
- **Password change:** set a new `APP_PASSWORD` and redeploy. Sessions issued under the old password stop working.
- CSRF: cookie-authenticated POSTs need `X-Pitch-Request: 1` and a same-origin `Origin`/`Sec-Fetch-Site`.
- Missing or weak configuration returns 503 for every browser route.

## Configuration (Netlify → Environment variables, scope: Functions, secret)

See `.env.example` for names and placeholders. Never commit real values.

## Prompt pack

Brand voice, pitch rules, curated examples and assessment guidance are stored
as one JSON document in the private Netlify Blobs store `pitch-drafter-private`
(key `prompt-pack/active`, or the key named by `PROMPT_PACK_KEY`). The pack is
validated on every request; if it is missing or invalid, drafting and
assessment return 503. There is no fallback copy in the code. The renderer and
the pack schema are in `netlify/lib/prompts.mjs`; tests use
`tests/fixtures/synthetic-pack.json`.

Import (team only; the real pack file is never committed):

```
netlify blobs:set pitch-drafter-private prompt-pack/<version> --input <private-pack.json>
netlify blobs:set pitch-drafter-private prompt-pack/active --input <private-pack.json>
```

## Tracker data

The source sheet location is read only from `SHEET_CSV_URL`. Callers cannot
supply a URL. Fetches go over HTTPS to Google hosts only, with validated
redirects, a deadline that covers body reads, and a size cap. The "Open package
tracker" link comes from `PACKAGE_TRACKER_URL` and is returned only to signed-in
users, so **authorized users do see that URL**. The sheets themselves remain
viewable by anyone who already has their links.

## Untrusted content

Journalist queries and product fields are treated as data: control characters
are stripped, sizes are bounded, template placeholders in them are never
expanded, and the model is told not to follow instructions inside them. Model
output is validated, size-capped and rendered as text. Assessment reasons that
start with `= + - @` are prefixed with `'` before they are returned for sheet
writing. No model output triggers any external action.

## Tests

`npm test` (unit/security, synthetic data, mocked providers) and
`npm run test:browser` (Playwright against a local stand-in server).
