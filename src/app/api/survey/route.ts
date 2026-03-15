import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { verifySurveyToken } from '@/lib/crypto';

export async function POST(req: NextRequest) {
  const body = await req.formData();

  const token = body.get('token') as string | null;
  const reason = body.get('reason') as string | null;
  const openText = body.get('open_text') as string | null;
  const comebackText = body.get('comeback_text') as string | null;

  if (!token || !reason) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const payload = verifySurveyToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  if (Date.now() > payload.exp) {
    return NextResponse.json({ error: 'Survey link expired' }, { status: 410 });
  }

  try {
    const updated = await execute(
      `UPDATE survey_responses
       SET reason_category = $1, open_text = $2, comeback_text = $3, surveyed_at = $4
       WHERE token = $5 AND org_id = $6 AND surveyed_at IS NULL`,
      [reason, openText ?? null, comebackText ?? null, new Date().toISOString(), token, payload.orgId],
    );

    if (updated === 0) {
      return NextResponse.json({ error: 'Survey not found or already submitted' }, { status: 404 });
    }
  } catch (err) {
    console.error('Survey update error:', err);
    return NextResponse.json({ error: 'Failed to save response' }, { status: 500 });
  }

  return NextResponse.redirect(
    new URL('/survey/thanks', req.url),
    { status: 303 },
  );
}
