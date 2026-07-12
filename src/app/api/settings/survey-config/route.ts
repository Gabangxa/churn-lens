import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { requireOrgId } from '@/lib/auth';
import { loadSurveyConfig, validateSurveyConfig, toStoredConfig } from '@/lib/survey-config';

/** Org-scoped read of the current survey customization (display name, logo, extra reasons). */
export async function GET(req: NextRequest) {
  const authResult = requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  const config = await loadSurveyConfig(orgId);
  return NextResponse.json(config);
}

/** Org-scoped, authoritative validate-and-save of survey customization. */
export async function PUT(req: NextRequest) {
  const authResult = requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.', field: 'displayName' },
      { status: 400 },
    );
  }

  const result = validateSurveyConfig(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, field: result.field }, { status: 400 });
  }

  try {
    await execute('UPDATE organizations SET survey_config = $1 WHERE id = $2', [
      JSON.stringify(toStoredConfig(result.value)),
      orgId,
    ]);
  } catch (err) {
    console.error(`Failed to save survey_config for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Failed to save survey configuration.' }, { status: 500 });
  }

  return NextResponse.json(result.value);
}
