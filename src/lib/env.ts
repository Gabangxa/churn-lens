/**
 * Validates all required environment variables at process startup.
 * Called from instrumentation.ts so failures surface immediately in the logs,
 * not on the first request that happens to hit the missing var.
 */

const REQUIRED: Record<string, string> = {
  DATABASE_URL: 'PostgreSQL connection string',
  ENCRYPTION_KEY: '64-character hex string (32 bytes) for AES-256 and HMAC signing',
  STRIPE_SECRET_KEY: 'Stripe platform secret key (sk_...)',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhook signing secret for the legacy /api/webhooks/stripe route',
  RESEND_API_KEY: 'Resend API key for sending emails',
  CRON_SECRET: 'Secret used to authenticate internal cron requests',
  NEXT_PUBLIC_APP_URL: 'Public URL of this app (e.g. https://your-app.replit.app)',
  OPENAI_API_KEY: 'OpenAI API key for weekly theme clustering',
};

export function validateEnv(): void {
  const missing = Object.entries(REQUIRED)
    .filter(([key]) => !process.env[key])
    .map(([key, description]) => `  ${key} — ${description}`);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.join('\n')}\n\nSet these in Replit Secrets before starting the app.`,
    );
  }

  // Additional format check for ENCRYPTION_KEY
  const key = process.env.ENCRYPTION_KEY!;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
}
