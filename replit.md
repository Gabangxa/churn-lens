# ChurnLens

A lightweight cancellation exit survey tool for indie SaaS founders. Automatically sends surveys after Stripe cancellation events and uses AI to synthesize themes from responses.

## Architecture

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js 20
- **Styling**: Tailwind CSS
- **Database**: Replit PostgreSQL (accessed via `pg` pool, `DATABASE_URL` env var)
- **Auth**: HMAC-signed cookies (`src/lib/auth.ts`) — no Supabase, no RLS
- **AI**: OpenAI GPT-4o-mini for theme synthesis
- **Email**: Resend + React Email
- **Payments**: Stripe (webhooks + subscriptions)

## Project Structure

```
emails/                  # React Email templates
scripts/
  post-merge.sh          # Post-merge setup (npm install + DB migration)
src/
  app/
    api/
      digest/            # Weekly email cron job
      onboarding/connect # Stripe API key connection endpoint
      survey/            # Survey submission endpoint
      themes/            # AI theme clustering cron job
      webhooks/stripe/   # Stripe webhook handler
      settings/status/   # Stripe connection status check
      settings/disconnect/ # Stripe disconnect endpoint
    dashboard/           # Founder analytics dashboard
    onboarding/          # Stripe connection setup (client component)
    settings/            # Settings page with Stripe disconnect
    survey/[token]/      # Customer exit survey page
    layout.tsx
    page.tsx             # Landing page
  lib/
    auth.ts              # HMAC-signed cookie session (setOrgCookie, requireOrgId, clearOrgCookie)
    crypto.ts            # AES-256-GCM encryption for Stripe API keys
    db.ts                # PostgreSQL pool + TypeScript interfaces (Organization, SurveyResponse, Theme)
    openai.ts
    resend.ts
    stripe.ts
  instrumentation.ts     # Internal cron scheduler (setTimeout-based)
```

## Database

Uses Replit's built-in PostgreSQL. Schema is created via `scripts/post-merge.sh` or manually. Tables:
- `organizations` — org settings, encrypted Stripe key, plan tier
- `users` — org members with password_hash for future auth
- `survey_responses` — individual cancellation survey answers
- `themes` — AI-clustered weekly theme summaries

All queries use parameterized SQL via `src/lib/db.ts` (query, queryOne, queryCount helpers).

## Running the App

The app runs via the "Start application" workflow using `npm run dev -p 5000`.

## Scheduled Jobs

Cron jobs are handled internally via `src/instrumentation.ts` (Next.js instrumentation hook), which runs once on server startup. No external cron service is needed.

- **Monday 06:00 UTC** — POST `/api/themes` (AI theme clustering)
- **Monday 07:00 UTC** — POST `/api/digest` (weekly founder email)

Both endpoints are secured with a `CRON_SECRET` bearer token. The scheduler uses plain `setTimeout` so there are no npm dependencies and no webpack bundling issues.

## Environment Variables

Required:
- `DATABASE_URL` — Replit PostgreSQL connection string (auto-provisioned)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `NEXT_PUBLIC_APP_URL` — public app URL (Replit dev domain or production domain)
- `ENCRYPTION_KEY` — 32-byte hex string (64 chars) for AES-256-GCM encryption of Stripe API keys
- `CRON_SECRET` — random secret string; must match the value used in scheduled job requests
