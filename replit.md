# ChurnLens

A lightweight cancellation exit survey tool for indie SaaS founders. Automatically sends surveys after Stripe cancellation events and uses AI to synthesize themes from responses.

## Architecture

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js 20
- **Styling**: Tailwind CSS
- **Database & Auth**: Supabase (Postgres + Row Level Security)
- **AI**: OpenAI GPT-4o-mini for theme synthesis
- **Email**: Resend + React Email
- **Payments**: Stripe (webhooks + subscriptions)

## Project Structure

```
emails/                  # React Email templates
src/
  app/
    api/
      digest/            # Weekly email cron job
      survey/            # Survey submission endpoint
      themes/            # AI theme clustering cron job
      webhooks/stripe/   # Stripe webhook handler
    dashboard/           # Founder analytics dashboard
    onboarding/          # Stripe connection setup
    survey/[token]/      # Customer exit survey page
    layout.tsx
    page.tsx             # Landing page
  lib/
    openai.ts
    resend.ts
    stripe.ts
    supabase.ts
supabase/
  migrations/            # SQL schema files
```

## Running the App

The app runs via the "Start application" workflow using `npm run dev -p 5000`.

## Environment Variables

See `.env.example` for required variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `NEXT_PUBLIC_APP_URL`
