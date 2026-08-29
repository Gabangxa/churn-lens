# [CL-2] Org API keys and read-only data API

- **Type:** feature
- **Priority:** P2
- **Status:** ready
- **Blocked by:** billing (see [[billing-provider-polar]]) — the plan gate must be reachable before a Growth-tier feature means anything.
- **Blocks:** CL-3 (ChurnLens MCP server)
- **Gates required:** code-guardian, test-architect, deploy-engineer (see Gates section)

---

## Context

Every read path in ChurnLens today is behind a browser session. `requireOrgId` verifies an
HMAC-signed `churnlens_org_id` cookie; the only other credential in the app is `CRON_SECRET`,
a single global bearer for the two internal cron routes. There is no way for an org to read its
own churn data programmatically — which blocks CSV export, the Growth-tier promise in the README,
and CL-3's MCP server.

This ticket adds **org-scoped API keys and a read-only `/api/v1` namespace**. Nothing else.

Explicitly out of scope (YAGNI): write endpoints, per-user keys, OAuth, webhooks out, pagination
cursors, a public API doc site, key rotation reminders, usage metering/billing.

### Hard constraints

- **Read-only.** Every endpoint in this ticket is a `GET`. No key can mutate anything. This is
  what keeps the blast radius of a leaked key to disclosure, and it is what makes CL-3's MCP
  server safe to hand to an autonomous agent.
- **Two credential systems stay disjoint.** `requireOrgId` must never accept an API key, and the
  new `requireApiKey` must never accept the session cookie. A cookie-authenticated `/api/v1` would
  be a CSRF-reachable data-export endpoint.
- **`is_test` isolation holds.** Every query filters `NOT is_test`, matching the existing rule that
  test surveys stay out of stats, themes, digests, and the free-tier cap.
- **PII is opt-in, not default.** Customer email and name are only ever returned under an explicit
  second scope. See the POPIA section.

### Current state (verified against the tree, 2026-08-24)

- `src/lib/auth.ts` — `requireOrgId(req)` returns `{ orgId } | { error: NextResponse }`. That
  discriminated-union shape is the house pattern; mirror it.
- `src/lib/crypto.ts` — `generateLoginToken()` returns `{ token, tokenHash }` from
  `randomBytes(32).base64url`, stored only as `hashLoginToken()` SHA-256 hex. Its comment states
  the rationale: 256 bits is not feasibly guessable, so lookup-by-hash needs no constant-time
  compare. API keys reuse that reasoning exactly.
- `src/lib/db.ts` — `query` / `queryOne` / `execute` / `queryCount`, plus the `Organization`,
  `SurveyResponse`, `Theme` row interfaces. No new data-layer plumbing needed.
- `src/app/dashboard/page.tsx` — holds a **local** `maskEmail()` (`^(.{1,2})[^@]*@` → `$1***@`)
  and the all-time stats query (`total_sent`, `responded`, `mrr_lost`, `NOT is_test`). Both need
  extracting so the API and the dashboard cannot disagree — the same reason the file already
  shares its Stripe-connected test with `/api/settings/status`.
- `src/app/api/themes/route.ts` — the only plan read site: `WHERE plan IN ('starter','growth')`.
- `src/lib/ratelimit.ts` — `checkRateLimit(key, limit, windowMs)`, process-local and best-effort.
  Existing callers key by orgId (`testsurvey:${orgId}`) or IP. Documented as a speed bump, not a
  guarantee, and explicitly not safe across instances.
- `src/lib/env.ts` — validates six required vars at boot and **throws** on any missing one. Adding
  a required var here breaks every existing deploy; this ticket adds none.
- `scripts/migrate.js` — additive and idempotent, run as Railway's pre-deploy command.

### Storage decision

New table, not a column — an org needs more than one key (laptop, CI, revoke-and-replace without
downtime), and revocation must be per-key.

```sql
CREATE TABLE IF NOT EXISTS org_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_api_keys_org ON org_api_keys (org_id);
```

- **Raw key format:** `cl_live_` + `randomBytes(32).toString('base64url')`.
- **Stored:** SHA-256 hex in `key_hash` only. The raw key is shown **once**, at creation, and is
  unrecoverable afterwards — same property as the magic-link token.
- **`key_prefix`:** first 12 chars of the raw key (`cl_live_ab12`), display-only, so a founder can
  tell two keys apart in the UI and in logs without the secret being present.
- **Scopes** — exactly two, no hierarchy:
  - `churn:read` — aggregates, themes, reasons, and responses with **masked** email and no name.
  - `churn:read_pii` — additionally unmasks `customer_email` and returns `customer_name`.

---

## API surface

All routes: `GET`, under `/api/v1/`, authenticated by `Authorization: Bearer cl_live_…`,
scoped to the key's `org_id`, filtered `NOT is_test`, and gated to `plan = 'growth'`.

| Route | Returns | Scope |
|---|---|---|
| `GET /api/v1/summary?since=&until=` | `{ surveysSent, responded, responseRate, mrrLost, periodStart, periodEnd }` | `churn:read` |
| `GET /api/v1/themes?week_of=` | latest week by default: `[{ weekOf, label, responseCount, mrrImpact, quotes[] }]` | `churn:read` |
| `GET /api/v1/themes?from=&to=` | the same shape across a week range, ordered by `week_of` | `churn:read` |
| `GET /api/v1/reasons?since=` | `[{ reason, count, mrrLost }]` grouped on `reason_category` | `churn:read` |
| `GET /api/v1/responses?since=&reason=&limit=` | `[{ id, reason, openText, comebackText, mrrLost, surveyedAt, customerEmail }]`, `limit` ≤ 200 default 50, `surveyed_at IS NOT NULL`, newest first | `churn:read` (masked) |
| `GET /api/v1/responses/{id}` | one response, same shape | `churn:read` (masked) |

`customerEmail` is masked under `churn:read` and unmasked under `churn:read_pii`; `customerName`
is **absent** under `churn:read` and present under `churn:read_pii`. `stripe_subscription_id`,
`token`, and `theme_tags` are never returned — the first two are credentials-adjacent and the
third is unused by any read path today.

---

## Acceptance criteria

**Schema & key generation**
- [ ] `scripts/migrate.js` creates `org_api_keys` and its index via `CREATE TABLE IF NOT EXISTS` /
      `CREATE INDEX IF NOT EXISTS`; running migrate twice is a no-op.
- [ ] `src/lib/crypto.ts` gains `generateApiKey(): { key, keyHash, keyPrefix }` and
      `hashApiKey(key): string`, mirroring the login-token pair (32 random bytes, SHA-256 hex,
      lookup by hash). The raw key is never written to the DB or to any log line.

**Authentication**
- [ ] New `src/lib/api-auth.ts` exports `requireApiKey(req, scope)` returning
      `{ orgId, keyId, scopes } | { error: NextResponse }`, matching `requireOrgId`'s shape.
- [ ] A missing, malformed, unknown, or revoked (`revoked_at IS NOT NULL`) key returns **401**
      with `WWW-Authenticate: Bearer`. All four cases return an identical body — a distinct
      "revoked" message tells an attacker their guess hit a real key.
- [ ] A valid key lacking the required scope returns **403** naming the missing scope.
- [ ] A valid key whose org is not on `growth` returns **403** with an upgrade message, mirroring
      how `/api/themes` reads `organizations.plan` as the single source of entitlement.
- [ ] `requireApiKey` ignores the `churnlens_org_id` cookie entirely; `requireOrgId` ignores the
      `Authorization` header entirely. Each has a test asserting the other's credential fails.
- [ ] A successful authentication updates `last_used_at`. The update must not block the response
      path from returning correct data if it fails (log and continue).

**Endpoints**
- [ ] All six routes above return the documented shape, org-scoped, `NOT is_test`, and reject
      any query param that fails validation with a 400 naming the field.
- [ ] `since` / `until` / `week_of` / `from` / `to` parse as ISO dates; an unparseable value is a
      400, never a silently-ignored filter (a silently dropped `since` returns the org's whole
      history to a caller that asked for a week).
- [ ] `limit` is clamped to 200 and defaults to 50; a non-numeric or negative value is a 400.
- [ ] `/api/v1/summary` numbers equal the dashboard's for the same org over all time — enforced by
      both reading one extracted helper, not by two copies of the SQL.
- [ ] Masking: under `churn:read`, `customerEmail` matches `^.{1,2}\*\*\*@` and `customerName` is
      absent from the JSON. Under `churn:read_pii`, both are verbatim.
- [ ] `maskEmail` is extracted from `src/app/dashboard/page.tsx` into a shared lib and imported by
      both the dashboard and the API; the dashboard's rendered output is unchanged.

**Rate limiting**
- [ ] Each request calls `checkRateLimit` keyed by `api:${keyId}` (not org, not IP — a leaked key
      is the unit of abuse). Over-limit returns **429** with `Retry-After`.
- [ ] The route comments record that this is process-local and does not hold across instances, the
      same caveat `src/lib/ratelimit.ts` already carries.

**Settings UI**
- [ ] The Settings page gains an "API keys" card listing each key's name, `key_prefix`, created
      date, last-used date, and scopes. Revoked keys are hidden or struck through, never editable.
- [ ] Creating a key asks for a name and a `churn:read_pii` opt-in checkbox (default **off**), then
      displays the raw key **once** with an explicit "you will not see this again" warning and a
      copy affordance.
- [ ] Revoking uses the inline two-step confirm already used by the Stripe danger zone. A revoked
      key returns 401 on its next request.
- [ ] All three actions go through org-scoped, cookie-authenticated endpoints under
      `/api/settings/api-keys` — the management API is **not** reachable with an API key, so a
      leaked read key cannot mint a PII key.

**Isolation invariants**
- [ ] No existing route's behavior changes. `/api/themes`, `/api/digest`, the Stripe webhook, and
      the survey flow are untouched except for the `maskEmail` extraction.
- [ ] No new required env var — `src/lib/env.ts` is unchanged, so existing deploys still boot.

---

## Edge cases & states

| Case | Expected behavior |
|---|---|
| Two keys generate the same `key_hash` | Impossible in practice at 256 bits; the `UNIQUE` constraint makes it a create-time error rather than a silent org cross-over. |
| Key belongs to an org deleted mid-request | `ON DELETE CASCADE` removes the key row; next request 401s. |
| Org downgrades `growth` → `free` while a key is live | Next request 403s. Keys are not revoked on downgrade — an upgrade restores access without re-issuing. |
| Key created before the `churn:read_pii` scope existed | `scopes` defaults to `{}`; treat an empty array as `churn:read` only. Never infer PII access. |
| `since` after `until` | 400. Returning an empty set would read as "no churn", which is the opposite of the truth. |
| Org with zero responses | 200 with zeroed aggregates and empty arrays. Not a 404 — a new org is a valid empty state. |
| Org on `growth` with no themes yet (clustering hasn't run) | `/themes` returns `[]`; `/summary` and `/responses` still work. Themes depend on the weekly cron, which needs ≥2 responses with `open_text`. |
| `open_text` containing prompt-injection payloads | Returned verbatim — this endpoint's contract is raw data. Containment is CL-3's job, at the agent boundary. Recorded here so the omission is deliberate. |
| Key leaked publicly | Read-only, single-org, revocable from Settings. `last_used_at` is the only forensic signal; there is no per-request audit log in this ticket. |
| Multiple app instances | Rate limits are per-instance, so effective limits multiply by instance count. Railway runs one instance today. |

---

## Files likely touched

- `scripts/migrate.js` — **new table** `org_api_keys` + index.
- `src/lib/crypto.ts` — add `generateApiKey` / `hashApiKey`.
- `src/lib/api-auth.ts` — **new**: `requireApiKey`, scope checks, plan gate, `last_used_at` touch.
- `src/lib/churn-queries.ts` — **new**: the shared summary/themes/reasons/responses queries and
  `maskEmail`, imported by both `/api/v1` and the dashboard.
- `src/app/api/v1/summary/route.ts` — **new**.
- `src/app/api/v1/themes/route.ts` — **new**.
- `src/app/api/v1/reasons/route.ts` — **new**.
- `src/app/api/v1/responses/route.ts` — **new**.
- `src/app/api/v1/responses/[id]/route.ts` — **new**.
- `src/app/api/settings/api-keys/route.ts` — **new**: `GET` list, `POST` create (cookie-auth).
- `src/app/api/settings/api-keys/[id]/route.ts` — **new**: `DELETE` revoke (cookie-auth).
- `src/app/settings/page.tsx` — add the API keys card.
- `src/app/dashboard/page.tsx` — import the extracted `maskEmail` + stats query; **no visual change**.
- `src/lib/db.ts` — add an `OrgApiKey` row interface alongside the existing ones.
- `docs/legal/dpa` + `src/app/legal/dpa/page.tsx` — see POPIA section.

---

## Test surface (hand-off to `test-architect`)

**Unit**
- `generateApiKey` / `hashApiKey`: prefix format, 256-bit entropy, hash stability, prefix is a
  strict prefix of the raw key.
- `maskEmail`: 1-char local part, 2-char, long, plus-addressing, unicode local part, no `@`.
- Scope resolution: `{}`, `{churn:read}`, `{churn:read_pii}` → what each unlocks.
- Date/limit param validation: valid, unparseable, inverted range, over-max, negative.

**Integration**
- Each `/api/v1` route: no header → 401; bad key → 401; revoked key → 401 with a body identical to
  the unknown-key case; wrong scope → 403; `free`/`starter` plan → 403; valid `growth` key → 200.
- Cross-credential: session cookie against `/api/v1` → 401. API key against `/api/settings/api-keys`
  and against `/api/settings/survey-config` → 401.
- Org isolation: org A's key cannot read org B's responses, themes, reasons, or summary — including
  `/api/v1/responses/{id}` with a valid id belonging to B (must 404, not 403, to avoid confirming
  the id exists).
- `is_test` rows are excluded from all five endpoints.
- Masking round-trip: same response fetched with each scope differs only in `customerEmail` /
  `customerName`.
- `/api/v1/summary` equals the dashboard's computed values for a seeded org.
- Revoke → next request 401.
- Rate limit: N+1 requests on one key → 429 with `Retry-After`; a second key is unaffected.

**e2e**
- Founder on `growth` creates a key in Settings → copies it once → `curl`s `/api/v1/themes` and
  `/api/v1/summary` successfully → revokes it → the same `curl` 401s.
- Regression: a founder who never opens the API keys card sees an unchanged dashboard and settings
  page, and every pre-existing route behaves identically.

---

## Gates required

- [ ] **code-guardian** — required. New credential system, new public-facing namespace, PII masking.
- [ ] **test-architect** — required (see Test surface).
- [ ] **deploy-engineer** — **required**, unlike CL-1. This adds a new table (not an additive
      nullable column) and a new public route namespace. Per the learnings entry on env-var
      checklists, confirm at the gate that no new required var landed in `src/lib/env.ts` and that
      the pre-deploy migration creates the table before the first `/api/v1` request can arrive.

---

## POPIA

ChurnLens is the **operator**; the customer org is the **responsible party**
(see [[popia-compliance-posture]]). An API key is a new export path for personal information,
so it changes the s20–21 picture even though the data itself is unchanged:

- [ ] The DPA (`src/app/legal/dpa/page.tsx`) states that the responsible party may enable
      programmatic export via API keys, that the destination of exported data is the responsible
      party's own choice and responsibility, and that ChurnLens's s19 obligations end at delivery.
- [ ] `churn:read_pii` defaults **off** at creation, so the zero-thought path exports no identifiers.
- [ ] The key-creation UI states in one line what `churn:read_pii` exposes (former customers' email
      addresses and names) before the checkbox, not after.
- [ ] `last_used_at` is the only breach-detection signal here, and it is weak. Note in the ticket's
      close-out that s21(2) notification still depends on the unresolved error-monitoring gap —
      this ticket does not close it and must not be recorded as if it did.

---

## Open questions for Sox

1. **Growth-only, or Starter too?** Specced as `growth` to match the README's CSV-export tier.
   Starter access would make the API a $29 feature and weaken the tier split.
2. **`cl_live_` prefix** implies a `cl_test_` counterpart that does not exist. Keep the prefix for
   greppability and future-proofing, or drop to a bare `cl_`?
