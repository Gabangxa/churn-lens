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
| Payments | Stripe Billing |
| Auth | Passwordless magic-link (email) |
| Hosting | Railway (persistent Node service + Postgres) |

---

## Project structure

```
src/
├── app/
│   ├── page.tsx              # Landing page
│   ├── onboarding/           # Stripe connect flow
│   ├── survey/[token]/       # Exit survey (WCAG AA)
│   ├── dashboard/            # Founder response dashboard
│   └── api/
│       ├── webhooks/stripe/  # Stripe event handler
│       ├── survey/           # Survey form submission
│       ├── themes/           # AI clustering cron (Mon 06:00 UTC)
│       └── digest/           # Weekly email cron (Mon 07:00 UTC)
├── lib/
│   ├── supabase.ts
│   ├── stripe.ts
│   ├── resend.ts
│   └── openai.ts
emails/
└── weekly-digest.tsx         # React Email template
supabase/
└── migrations/001_initial.sql
```

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
cp .env.example .env.local
# Fill in: SUPABASE, STRIPE, OPENAI, RESEND keys

# 3. Apply DB schema
npx supabase db push

# 4. Start dev server
npm run dev

# 5. Preview email template
npx email dev
```

### Stripe webhook (local)

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

---

## Deploy to Railway

Config-as-code lives in `railway.json` (Railpack build, DB migration as the pre-deploy
command, `/api/health` healthcheck). The weekly cron jobs run in-process via
`src/instrumentation.ts` — no separate scheduler service needed.

1. **New Project → Deploy from GitHub repo** → select this repo.
2. **Add → Database → PostgreSQL.**
3. On the web service, set **Variables** (Raw Editor):

   ```bash
   DATABASE_URL=${{ Postgres.DATABASE_URL }}
   NEXT_PUBLIC_APP_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}
   ENCRYPTION_KEY=<64-hex>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   CRON_SECRET=<random>
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
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
