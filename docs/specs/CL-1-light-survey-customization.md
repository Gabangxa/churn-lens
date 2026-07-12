# [CL-1] Light survey customization

- **Type:** feature
- **Priority:** P2
- **Status:** ready
- **Gates required:** code-guardian, test-architect (deploy-engineer — not required; see Gates section)

---

## Context

Every org today sees the identical exit survey: 8 hardcoded cancellation reasons and generic
"the founder / the team" copy on both the survey page and the survey email. Founders have asked
to make the survey feel like *their* product without us building a full survey editor.

This ticket adds **two knobs, per org, nothing more**:

1. **Extra cancellation reasons** — an org can *append* custom reasons to the built-in list.
   Built-ins cannot be removed, edited, or reordered.
2. **Branding** — an org can set a product/company **display name** and an optional **logo URL**,
   shown on the survey page (and the display name used in the email copy), replacing the generic
   wording.

Explicitly out of scope (YAGNI): question editor, per-question config, colors/themes, custom CSS,
removing or reordering built-in reasons, HTML email redesign.

### Hard constraints (from the active Decisions Log — do not violate)

- **Zero-config is the universal fallback.** An org that configures nothing gets *exactly today's
  behavior*, byte-for-byte. Defaults are unchanged. A present-but-empty config behaves as zero-config.
- **Test surveys (`is_test`) stay isolated.** Customization must not touch the `is_test` flow or its
  exclusion from stats / themes / digests / free-tier cap.
- **Survey token payload/format must NOT change.** HMAC tokens are already in the wild. Config is
  *never* encoded in the token — it is loaded from the DB by `orgId` (already present in the payload).

### Current state (verified)

- Survey render: `src/app/survey/[token]/page.tsx` — server component, `CANCELLATION_REASONS`
  hardcoded const (8 entries, `'Other'` last). Renders purely from the token; does **no** DB read today.
- Reasons are stored as **free text** in `survey_responses.reason_category`, so a reason string
  survives even if the org later deletes the custom reason that produced it.
- Submission: `src/app/api/survey/route.ts` — `kind:'preview'` never persists; `kind:'test'` persists
  with `is_test=true`.
- Email body: `src/lib/survey-email.ts` — **plain-text** (`text:` field), generic "The team" sign-off.
  Called by `src/app/api/survey/test/route.ts` and `src/app/api/webhooks/stripe/[orgId]/route.ts`.
- Preview: `src/app/api/survey/preview/route.ts` — has a separate known bug (redirect built from
  `req.url` leaks the internal host behind the Railway proxy — Railway injects `PORT=8080`). Fix is in scope since the file is touched.
- Settings UI: `src/app/settings/page.tsx` — client component; already has an "Exit Survey" card with
  Preview + Send-test buttons.
- DB: table is named **`organizations`** (not `orgs`). Migrations live in `scripts/migrate.js` and are
  **additive + idempotent** (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), run on every deploy.

### Storage decision

Add one nullable JSONB column **`survey_config`** to `organizations`. Shape:

```jsonc
{
  "display_name":   "Acme Billing",              // optional, string
  "logo_url":       "https://acme.com/logo.png", // optional, string (https only)
  "custom_reasons": ["Billing was confusing"]    // optional, string[]
}
```

`NULL` column, `{}`, or all-empty values ⇒ zero-config (today's behavior). Keys are read defensively:
any missing/malformed key falls back to default rather than erroring the survey render.

---

## Acceptance criteria

Each item is independently testable.

**Schema & config loading**
- [ ] `scripts/migrate.js` adds `survey_config jsonb` (nullable, no default) to `organizations` via
      `ADD COLUMN IF NOT EXISTS`; running migrate twice is a no-op.
- [ ] A shared loader (e.g. `src/lib/survey-config.ts`) reads `survey_config` by `orgId` and returns a
      normalized object with safe defaults: `{ displayName: string|null, logoUrl: string|null, customReasons: string[] }`.
      A `NULL` column, `{}`, or malformed JSON returns the all-default object without throwing.

**Settings UI (edit the two knobs)**
- [ ] The Settings "Exit Survey" card gains a form to edit: display name, logo URL, and a list of custom
      reasons (add/remove rows). It loads current values on mount and shows a saved/error state.
- [ ] Saving calls a new authenticated endpoint (e.g. `PUT /api/settings/survey-config`) scoped to the
      caller's `orgId`; unauthenticated requests get 401 and redirect to `/onboarding` (matches existing pattern).
- [ ] Clearing all three fields and saving persists an empty/`{}` config and the org reverts to zero-config behavior.

**Validation (server-side, authoritative — client hints optional)**
- [ ] Custom reasons: max **5** entries; each trimmed to **1–60 chars**; empty/whitespace-only entries dropped;
      de-duplicated case-insensitively against **each other and the built-in list** (a custom reason equal to a
      built-in is silently dropped, not stored).
- [ ] Display name: trimmed, max **60 chars**, control characters stripped. Over-limit input is rejected with a
      clear error (not silently truncated).
- [ ] Logo URL: optional; if present must parse as a URL with scheme **`https`** and be ≤ **300 chars**;
      non-https / unparseable values are rejected with a clear error.
- [ ] Validation failures return a 4xx with a field-level message and persist **nothing**.

**Survey page rendering**
- [ ] With custom reasons configured, the survey renders built-in reasons first, then the org's custom reasons,
      with `'Other'` remaining the **last** option. Radio `name="reason"` / `value` wiring is unchanged.
- [ ] With a display name configured, the generic header/body copy uses the display name; with a logo URL
      configured, the logo renders as an `<img>` (with `alt` text) at the top of the survey, replacing/joining
      the brand mark. Display name and reasons are rendered as text through JSX (auto-escaped).
- [ ] A zero-config org's survey page is **identical** to today (same 8 reasons, same copy, same "Powered by
      ChurnLens" mark).

**Email**
- [ ] `sendSurveyEmail` accepts an optional display name; when set, the email subject/body/sign-off use it in
      place of "the founder / The team". When unset, the email is byte-identical to today.
- [ ] Both callers (`api/survey/test` and `webhooks/stripe/[orgId]`) load the org config and pass the display
      name through. (Email is plain-text; **logo is not embedded in the email** — see Open questions.)

**Preview & test reflect config**
- [ ] The Preview flow (`kind:'preview'`) and Send-test flow (`kind:'test'`) render/send with the org's live
      config, so a founder sees their customization before it reaches real customers.
- [ ] **Preview redirect bug fix:** `api/survey/preview/route.ts` builds the `/survey/{token}` redirect from
      `NEXT_PUBLIC_APP_URL` (validated as `https://…`, mirroring `api/survey/test`), not from `req.url`, so the
      internal proxy host no longer leaks. If `NEXT_PUBLIC_APP_URL` is missing/non-https, return a clear 500.

**Isolation invariants**
- [ ] `is_test` behavior is unchanged: test responses still persist with `is_test=true` and stay excluded from
      stats/themes/digests/free-tier cap regardless of config.
- [ ] The survey token is byte-for-byte unchanged; config is loaded by `orgId` and never encoded into the token.

---

## Edge cases & states

| Case | Expected behavior |
|---|---|
| Org deletes a custom reason that already has responses | Responses unaffected — `reason_category` stores the string, not an FK. Historical rows stay readable; the reason simply no longer appears as an option. |
| Custom reason duplicates a built-in (exact or case-insensitive) | Dropped at save time; never stored, never double-rendered. |
| Two custom reasons duplicate each other | Deduped case-insensitively; one kept. |
| XSS via display name / custom reason | Rendered through JSX (auto-escaped) on the page; plain-text in email. No `dangerouslySetInnerHTML`. Server still strips control chars and enforces length. |
| XSS / `javascript:` via logo URL | Blocked by https-only + URL-parse validation; rejected at save. |
| Logo URL that 404s or is slow | Page still renders; broken `<img>` degrades gracefully (has `alt`, layout does not collapse). No server-side fetch/validation of reachability. |
| Config present but empty (`{}`, `""`, `[]`) | Treated as zero-config — today's behavior. |
| Overly long inputs | Rejected with field-level error; nothing persisted. |
| Malformed JSON in `survey_config` (manual DB edit) | Loader returns defaults; survey renders normally, no crash. |
| Config saved between a token being issued and the survey being opened | Survey reflects **current** config at render time (config is not snapshotted into the token) — acceptable and expected. |
| Preview/test for an org mid-edit | Reflects whatever is currently saved; unsaved UI edits are not previewed. |

---

## Files likely touched

- `scripts/migrate.js` — add `survey_config jsonb` to `organizations`.
- `src/lib/survey-config.ts` — **new**: load + normalize + validate config (shared by page, email callers, API).
- `src/app/api/settings/survey-config/route.ts` — **new**: `GET` current config, `PUT` validated config, org-scoped.
- `src/app/settings/page.tsx` — add the edit form to the existing Exit Survey card.
- `src/app/survey/[token]/page.tsx` — load config by `orgId`; render custom reasons + branding; keep zero-config path identical.
- `src/lib/survey-email.ts` — optional display-name param in copy/sign-off.
- `src/app/api/survey/test/route.ts` — load config, pass display name to `sendSurveyEmail`.
- `src/app/api/webhooks/stripe/[orgId]/route.ts` — load config, pass display name to `sendSurveyEmail`.
- `src/app/api/survey/preview/route.ts` — fix host-leak redirect (use `NEXT_PUBLIC_APP_URL`).
- `src/app/api/survey/route.ts` — expected **no change** (reason already stored as free text); confirm during build.

---

## Test surface (hand-off to `test-architect`)

**Unit**
- Config loader/normalizer: NULL / `{}` / malformed JSON / partial keys → correct defaults.
- Validation: reason count cap (5), per-reason length (1–60), whitespace-drop, case-insensitive dedupe vs built-ins
  and vs each other; display-name length + control-char strip; logo-url https-only + length + parse failure.
- `sendSurveyEmail`: with display name vs without → without is byte-identical to current snapshot.

**Integration**
- `PUT /api/settings/survey-config`: auth required (401 → onboarding), valid save round-trips, invalid save persists
  nothing and returns field errors, empty save reverts to zero-config.
- Survey page render: zero-config snapshot equals baseline; configured org renders custom reasons after built-ins
  with `'Other'` last, plus display name + logo `<img>` with `alt`.
- Test-send flow: `is_test=true` still set; email carries display name; still excluded from stats/cap.
- Preview redirect: response `Location` derives from `NEXT_PUBLIC_APP_URL`, not the request host.

**e2e**
- Founder edits config in Settings → Preview reflects it → Send test → configured email arrives → real webhook
  survey shows the same customization.
- Regression: an org with no config sees the exact current survey and email.

---

## Gates required

- **code-guardian** — required (all code changes; XSS/validation surface, shared email path).
- **test-architect** — required (see Test surface).
- **deploy-engineer** — **not required.** Per the repo convention the change is a single additive, nullable
  JSONB column applied through the existing idempotent `scripts/migrate.js` path — no backfill, no destructive
  DDL, no new infra, no new index. If the build adds a backfill or index, re-request this gate.

---

## Resolved decisions (Sox approved defaults, 2026-07-12)

1. **Logo in the email:** display name in email copy only; logo renders on the survey page. HTML email is a
   separate future ticket.
2. **Reason ordering:** built-ins → custom reasons → `'Other'` last. Confirmed.
3. **Logo constraints:** any https URL ≤300 chars, rendered best-effort with `alt`. No size/host allowlist for MVP.
