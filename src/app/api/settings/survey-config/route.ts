import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { assertSameOrigin, requireOrgId } from '@/lib/auth';
import { loadSurveyConfig, validateSurveyConfig, toStoredConfig } from '@/lib/survey-config';
import { isBadInputDbError, reportError, warnBadInput } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

/** Org-scoped read of the current survey customization (display name, logo, extra reasons). */
async function readSurveyConfig(req: NextRequest) {
  const authResult = await requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  const config = await loadSurveyConfig(orgId);
  return NextResponse.json(config);
}

/** Org-scoped, authoritative validate-and-save of survey customization. */
async function saveSurveyConfig(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const authResult = await requireOrgId(req);
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
    // A value validation let through that the jsonb column still refuses (a
    // NUL in the logo URL fails with 22P05) is the founder's input, not an
    // outage: a 400 they can act on and a warning, not an operator alert.
    if (isBadInputDbError(err)) {
      warnBadInput('settings.survey-config', err, { orgId });
      return NextResponse.json(
        { error: 'Your survey settings contain characters that cannot be saved.' },
        { status: 400 },
      );
    }
    // Otherwise validation passed, so this is the database, not the founder.
    reportError('settings.survey-config', err, { orgId });
    return NextResponse.json({ error: 'Failed to save survey configuration.' }, { status: 500 });
  }

  return NextResponse.json(result.value);
}

export const GET = withErrorReporting('settings.survey-config', readSurveyConfig);
export const PUT = withErrorReporting('settings.survey-config', saveSurveyConfig);
