# ChurnLens

> Understand why customers cancel — without paying enterprise prices.

ChurnLens is a lightweight cancellation exit survey tool with AI-powered theme synthesis, built for indie SaaS founders at **$29/mo**.

---

## The problem

Solo SaaS founders have no affordable way to understand *why* customers cancel at a qualitative level:

- **Raaft** — $79/mo (overpriced for sub-$5K MRR products)
- **Churnkey** — $250/mo
- **Baremetrics** add-on — $129/mo

ChurnLens fills the gap: exit interviews + AI theme synthesis at indie-founder pricing.

---



---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| Backend / API routes | Next.js Route Handlers |
| Database | PostgreSQL (`pg`), schema in `scripts/migrate.js` |
| Email | Resend |
| AI | OpenAI GPT-4o-mini |
| Billing integration | Stripe — each org's own account, via a per-org restricted key |
| Auth | Passwordless magic-link (email) |
| Hosting | Railway (persistent Node service + Postgres) |

---

### Auth flow

`/login` is both signup and login: posting an email to `/api/auth/request` creates
an org and an owner user the first time it sees that address, then emails a
magic link either way. `/api/auth/verify` is the *only* route that ever mints
a session — it sends a founder with no Stripe key yet to `/onboarding`,
everyone else to wherever they were headed (or `/dashboard`). `/api/onboarding/connect`
requires that session and only ever attaches a Stripe key to it; it can no
longer create an org or accept an email on its own.

---

## Project structure

```
src/
├── app/
│   ├── page.tsx                   # Landing page
│   ├── onboarding/                # Connect a Stripe restricted key (session required)
│   ├── login/                     # Passwordless magic-link login + signup
│   ├── survey/[token]/            # Exit survey (WCAG AA)
│   ├── dashboard/                 # Founder response dashboard
│   ├── settings/                  # Survey config, disconnect
│   ├── legal/                     # Privacy, terms, DPA (draft)
│   └── api/
│       ├── webhooks/stripe/[orgId]/  # Per-org Stripe event handler
│       ├── onboarding/            # Key validation + webhook registration
│       ├── auth/                  # Magic-link request/verify, logout
│       ├── survey/                # Survey submission + opt-out
│       ├── settings/              # Survey config, status, disconnect
│       ├── themes/                # AI clustering cron (Mon 06:00 UTC)
│       ├── digest/                # Weekly email cron (Mon 07:00 UTC)
│       └── health/                # Railway healthcheck
├── lib/
│   ├── db.ts                      # pg pool + query helpers
│   ├── crypto.ts                  # AES-256-GCM key storage, signed tokens
│   ├── auth.ts                    # Org session cookie
│   ├── app-url.ts                 # Public-URL resolution behind the proxy
│   ├── openai.ts                  # Theme clustering
│   ├── resend.ts / survey-email.ts
│   ├── survey-config.ts           # Per-org survey customization
│   └── ratelimit.ts / week.ts / legal.ts / env.ts
└── instrumentation.ts             # In-process weekly cron scheduler
scripts/
└── migrate.js                     # Idempotent schema migration
```

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
cp .env.example .env.local
# Fill in: DATABASE_URL, OPENAI_API_KEY, RESEND_API_KEY,
#          ENCRYPTION_KEY, CRON_SECRET, NEXT_PUBLIC_APP_URL

# 3. Apply DB schema (idempotent — safe to re-run)
npm run db:migrate

# 4. Start dev server (port 5000)
npm run dev
```

### Stripe webhook (local)

Webhooks are per-org, so the forwarding URL needs the org's id. Log in at
`/login` (which creates the org on first use) and connect through `/onboarding`,
then:

```bash
stripe listen --forward-to localhost:5000/api/webhooks/stripe/<orgId>
```

ChurnLens never uses a platform-level Stripe key — each org's restricted key is
collected at onboarding and stored encrypted, so there is nothing to set here.

---

## End-to-end tests

Unit tests (`npm test`, vitest) cover route handlers against mocks. The Playwright
suite in `e2e/` covers the flows those mocks cannot: a real Chromium against a real
production build against a real PostgreSQL.

### Prerequisites

Docker, for the throwaway database:

```bash
npm run e2e:db up      # postgres:16-alpine on 127.0.0.1:55432, db churnlens_test
```

Then build the app the way the suite runs it — `NEXT_PUBLIC_APP_URL` is inlined at
build time and, in production, is the entire origin allow-list `assertSameOrigin`
checks against:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:5100 npx next build
npm run e2e            # or: npm run e2e:ui
npm run e2e:db down    # when you're done
```

The suite runs on port **5100**, not the 5000 `npm run dev` uses: `reuseExistingServer`
would otherwise adopt a running dev server and point a suite that truncates everything
it touches at your real `.env` database.

Playwright starts `npx next start -p 5100` itself and waits on `/api/health` **first**,
and only then runs `e2e/global-setup.ts` — which refuses to continue unless
`TEST_DATABASE_URL` is a local database whose name contains "test"
(`assertThrowawayDatabase`), fails fast with instructions if it is unreachable, runs
`scripts/migrate.js` against it, and truncates every application table. Recreating the
schema under a running server is safe because `/api/health` does no DB work. Each run
therefore starts clean, and a second run cannot inherit the first one's rows.
**`TEST_DATABASE_URL` is truncated on every run. Never point it at a database you
care about.** The whole environment (fake keys included) is defined once in
`e2e/env.ts`, which also sets `E2E_DISABLE_SCHEDULER=1` so the in-process cron
scheduler cannot race the cron spec.

### What it covers

| Spec | Flow |
|------|------|
| `e2e/landing.spec.ts` | Marketing links: no anchor points at the session-gated `/onboarding`, pricing CTAs carry `?plan=`, header CTA goes to `/login` |
| `e2e/auth.spec.ts` | Signup through the real form (email normalization, plan carried into `redirect_to`, no session yet), magic-link verification, replayed and expired links, signed-out redirects to `/login?next=…` |
| `e2e/csrf.spec.ts` | `assertSameOrigin` wired in front of connect / login / checkout, and an off-site `next` dropped rather than stored |
| `e2e/onboarding.spec.ts` | Key-only form behind a session (no email field — that was the account-takeover hole) and the `rk_` validation error |
| `e2e/account.spec.ts` | Delete account from Settings: two-step confirm, Stripe columns cleared, session ended |
| `e2e/cron.spec.ts` | `CRON_SECRET` gate on all three jobs; the purge job's retention, erasure, abandoned-signup and orphaned-opt-out rules against real rows; themes + digest recorded as succeeded |
| `e2e/legal.spec.ts` | Privacy / Terms / DPA render with the draft banner, POPIA specifics, unsubscribe page's privacy link |

Sign-in is seeded (a `login_tokens` row written directly, then the link is clicked)
rather than requested through `/api/auth/request`, because that route is the one
place a real user's inbox is involved and it is rate limited.

### The rate-limit constraint

`/api/auth/request` allows **5 requests per IP per 10 minutes**, and the limiter is
in-memory: it resets only when the server process restarts, not between runs. The
suite therefore makes exactly **two** real calls to it (the signup form in
`auth.spec.ts`, the open-redirect check in `csrf.spec.ts`) — keep it that way when
adding specs.

Repeat runs against a reused server would still hit that ceiling on the third run, so
every request the suite makes carries a per-run random `x-forwarded-for` (see
`E2E_CLIENT_IP` in `e2e/env.ts`); `clientIp()` reads the last hop of that header, so
each run gets its own bucket. Per-email buckets are handled by `uniqueEmail()`.

### In CI

`.github/workflows/ci.yml` runs on pushes to `test`/`main` and on pull requests:

- **checks** — `npm ci`, `tsc --noEmit`, `next lint`, `vitest run` against a
  `postgres:16` service container, so the DB-gated purge suite actually runs
  instead of skipping.
- **e2e** — same service, `playwright install --with-deps chromium`, `npm run build`
  with `NEXT_PUBLIC_APP_URL=http://localhost:5100`, `playwright test`, and the HTML
  report uploaded as an artifact on failure.

---

## Deploy to Railway

Config-as-code lives in `railway.json` (Railpack build, DB migration as the pre-deploy
command, `/api/health` healthcheck). The weekly cron jobs run in-process via
`src/instrumentation.ts` — no separate scheduler service needed.

`instrumentation.ts` polls every 10 minutes (plus once ~30s after boot) rather than
firing a one-shot timer at the exact due instant, so a redeploy or crash spanning
Monday morning still catches up on the next poll instead of silently skipping the
week. `cron_runs` (see `src/lib/cron.ts`) tracks each week's status: a week that
crashed mid-run (`running` with no update in 2+ hours) or that finished `failed` is
retried with exponential backoff (30min, 1h, 2h, 4h, capped at 8h), up to 5 attempts,
after which the scheduler logs once and waits for a manual retry. `digest` proceeds
once `themes` has reached a terminal state for the week — `succeeded`, or `failed`
with its retries exhausted, so one poison org in themes can't silence every founder's
digest — and `digest_sends` (org, week) rows stop a retry from re-emailing a founder
who already got that week's mail.

To manually retry a week that's given up (attempts exhausted, or you just don't want
to wait for the next backoff window), reset it from a `psql` session against the
Railway Postgres:

```sql
-- substitute the job ('themes' or 'digest') and the Monday the week starts on
UPDATE cron_runs SET status = 'failed', attempts = 0 WHERE job = 'themes' AND week_of = '2026-03-09';
```

This resets `attempts` so decidePollAction (src/lib/cron.ts) no longer reports the
week 'exhausted'; `ran_at` is left as-is, and by the time anyone runs this it's
almost always well past even the 8h-capped backoff window, so the next poll (within
10 minutes) reclaims and retries the week right away.

1. **New Project → Deploy from GitHub repo** → select this repo.
2. **Add → Database → PostgreSQL.**
3. On the web service, set **Variables** (Raw Editor):

   ```bash
   DATABASE_URL=${{ Postgres.DATABASE_URL }}
   NEXT_PUBLIC_APP_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}
   ENCRYPTION_KEY=<64-hex>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   CRON_SECRET=<random>
   RESEND_API_KEY=re_...
   RESEND_FROM_EMAIL=digest@churnlens.com
   OPENAI_API_KEY=sk-...
   ```

   All variables in `src/lib/env.ts` are required — the server refuses to boot without them.
4. **Settings → Networking → Generate Domain** (populates `RAILWAY_PUBLIC_DOMAIN`), then deploy.
   The pre-deploy step runs `scripts/migrate.js`; the healthcheck waits on `/api/health`.

DB TLS is handled automatically: no SSL over Railway's `*.railway.internal` private network
(override with `DATABASE_SSL=require`), verified TLS elsewhere when `DATABASE_CA_CERT` is set.

---

## Pricing

| Plan | Price | Limit |
|------|-------|-------|
| Free | $0 | 10 cancellations/mo |
| Starter | $29/mo | 100 cancellations/mo + AI themes + weekly digest |
| Growth | $79/mo | Unlimited + Slack + CSV export + custom questions |

**Launch offer:** $299 lifetime deal (Starter tier) — Product Hunt / Indie Hackers.

---



---

## Contributing

This is a mockup / early-stage repo. Issues and PRs welcome.

## License

MIT
