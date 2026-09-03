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

## Deploy to Railway

Config-as-code lives in `railway.json` (Railpack build, DB migration as the pre-deploy
command, `/api/health` healthcheck). The weekly cron jobs run in-process via
`src/instrumentation.ts` — no separate scheduler service needed.

`instrumentation.ts` polls every 10 minutes (plus once ~30s after boot) rather than
firing a one-shot timer at the exact due instant, so a redeploy or crash spanning
Monday morning still catches up on the next poll instead of silently skipping the
week. `cron_runs` (see `src/lib/cron.ts`) tracks each week's status: a week that
crashed mid-run (`running` with no update in 2+ hours) or that finished `failed` is
retried automatically, up to 5 attempts, after which the scheduler logs once and
waits for a manual retry. `digest` additionally checks that `themes` has `succeeded`
for the week before it claims a run, and `digest_sends` (org, week) rows stop a retry
from re-emailing a founder who already got that week's mail.

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
