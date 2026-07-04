import { Resend } from 'resend';

// Lazy singleton — see the note in src/lib/db.ts. Constructing the client (and
// requiring RESEND_API_KEY) at import time throws during the Next.js build's
// "Collecting page data" step, before the runtime secret is available.
let client: Resend | null = null;

export function getResend(): Resend {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('RESEND_API_KEY is not set');
  }
  client = new Resend(key);
  return client;
}

export const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ?? 'digest@churnlens.com';
