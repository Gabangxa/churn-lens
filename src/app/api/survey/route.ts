import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { verifySurveyToken } from '@/lib/crypto';
import { redirectUrl } from '@/lib/app-url';
import { BUILTIN_CANCELLATION_REASONS, loadSurveyConfig } from '@/lib/survey-config';
import { MAX_COMEBACK_TEXT, MAX_OPEN_TEXT, MAX_REASON, truncateFreeText } from '@/lib/survey-limits';
import { reportError } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

async function submitSurvey(req: NextRequest) {
  // Anyone can POST here, so a body that is not a form is their mistake, not
  // a failure: answered here, it never reaches withErrorReporting's alert.
  let body: FormData;
  try {
    body = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a form submission' }, { status: 400 });
  }

  // FormData.get() hands back a File for a file part. Every field here is
  // text, so a File is a malformed request, answered before string methods
  // throw on it (which, wrapped, would page the operator from anyone's POST).
  const fields: Record<string, string | null> = {};
  for (const name of ['token', 'reason', 'open_text', 'comeback_text']) {
    const value = body.get(name);
    if (value !== null && typeof value !== 'string') {
      return NextResponse.json({ error: `Invalid ${name}` }, { status: 400 });
    }
    fields[name] = value;
  }
  const { token, reason, open_text: openText, comeback_text: comebackText } = fields;

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

  // `reason` is capped and flagged, not rejected.
  //
  // It looks like a closed set — the built-ins plus this org's custom reasons,
  // rendered as radio buttons — but the set is editable and the check would run
  // against a config loaded at submit time, not the one the page rendered with.
  // A founder deleting a custom reason while a customer has the survey open
  // would 400 that customer's answer away, and they do not come back: the link
  // is single-use and they have already cancelled. Losing a real response to
  // catch a hypothetical tampered one is the wrong trade for a product whose
  // entire job is capturing these answers.
  //
  // So the cap is the control that matters — it is what bounds a column that is
  // a grouping key on the dashboard and an input to a paid OpenAI call. An
  // off-set value is stored and logged, which is a signal an operator can act
  // on rather than data that is simply gone.
  const reasonResult = truncateFreeText(reason, MAX_REASON);
  const storedReason = reasonResult.value;

  // Only used to decide whether this reason is worth flagging, so a transient
  // config read failure must not cost us the submission.
  let allowedReasons: Set<string>;
  try {
    const config = await loadSurveyConfig(payload.orgId);
    allowedReasons = new Set<string>([
      ...BUILTIN_CANCELLATION_REASONS,
      ...config.customReasons,
    ]);
  } catch (err) {
    console.error(`Could not load survey config for org ${payload.orgId}:`, err);
    allowedReasons = new Set<string>(BUILTIN_CANCELLATION_REASONS);
  }

  if (!allowedReasons.has(storedReason)) {
    console.warn(
      `Survey submission for org ${payload.orgId} carried an off-set reason ` +
        `(${reason.length} chars, truncated=${reasonResult.truncated}) — stored anyway.`,
    );
  }

  // Free text is capped, not rejected — see truncateFreeText for why a churned
  // customer's over-long answer is worth keeping in part rather than discarding.
  let storedOpenText: string | null = null;
  if (openText !== null) {
    const result = truncateFreeText(openText, MAX_OPEN_TEXT);
    if (result.truncated) {
      console.warn(
        `Truncated open_text for org ${payload.orgId}: ${openText.length} chars -> ${MAX_OPEN_TEXT}`,
      );
    }
    storedOpenText = result.value;
  }

  let storedComebackText: string | null = null;
  if (comebackText !== null) {
    const result = truncateFreeText(comebackText, MAX_COMEBACK_TEXT);
    if (result.truncated) {
      console.warn(
        `Truncated comeback_text for org ${payload.orgId}: ${comebackText.length} chars -> ${MAX_COMEBACK_TEXT}`,
      );
    }
    storedComebackText = result.value;
  }

  // Preview submissions exercise the form without touching the database.
  if (payload.kind === 'preview') {
    return NextResponse.redirect(redirectUrl('/survey/thanks', req), { status: 303 });
  }

  try {
    const updated = await execute(
      `UPDATE survey_responses
       SET reason_category = $1, open_text = $2, comeback_text = $3, surveyed_at = $4
       WHERE token = $5 AND org_id = $6 AND surveyed_at IS NULL`,
      [storedReason, storedOpenText, storedComebackText, new Date().toISOString(), token, payload.orgId],
    );

    if (updated === 0) {
      return NextResponse.json({ error: 'Survey not found or already submitted' }, { status: 404 });
    }
  } catch (err) {
    // The link is single-use and the customer has already cancelled, so
    // a lost answer does not come back. Org id only: the token is a
    // credential and the answer is the customer's own words.
    //
    // Reported even for a Postgres data exception, which other routes answer
    // as bad input (isBadInputDbError): every value bound here is ours or has
    // been through truncateFreeText, so one means that sanitising missed
    // something and a customer's answer was lost. That needs a human.
    reportError('survey.submit', err, { orgId: payload.orgId });
    return NextResponse.json({ error: 'Failed to save response' }, { status: 500 });
  }

  return NextResponse.redirect(
    redirectUrl('/survey/thanks', req),
    { status: 303 },
  );
}

export const POST = withErrorReporting('survey.submit', submitSurvey);
