import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';

/**
 * POST /api/survey
 *
 * Receives completed survey form submission.
 * Token is validated before writing to DB.
 */
export async function POST(req: NextRequest) {
  const body = await req.formData();

  const token = body.get('token') as string | null;
  const reason = body.get('reason') as string | null;
  const openText = body.get('open_text') as string | null;
  const comebackText = body.get('comeback_text') as string | null;

  if (!token || !reason) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Decode and validate the token
  let payload: { orgId: string; subscriptionId: string; exp: number };
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  if (Date.now() > payload.exp) {
    return NextResponse.json({ error: 'Survey link expired' }, { status: 410 });
  }

  const db = getAdminClient();

  const { error } = await db
    .from('survey_responses')
    .update({
      reason_category: reason,
      open_text: openText ?? null,
      comeback_text: comebackText ?? null,
      surveyed_at: new Date().toISOString(),
    })
    .eq('token', token)
    .eq('org_id', payload.orgId)
    .is('surveyed_at', null); // Prevent duplicate submissions

  if (error) {
    console.error('Survey update error:', error);
    return NextResponse.json({ error: 'Failed to save response' }, { status: 500 });
  }

  // Redirect to thank-you screen
  return NextResponse.redirect(
    new URL('/survey/thanks', req.url),
    { status: 303 },
  );
}
