/**
 * Weekly digest email — React Email component.
 * Rendered server-side and sent via Resend.
 *
 * Plain-text is preferred; this HTML version is a visual fallback
 * for email clients that render it (most do).
 *
 * Preview: npx email dev
 */

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

export interface WeeklyDigestProps {
  founderName: string;
  weekOf: string;
  totalCancellations: number;
  totalMrrLost: number;
  themes: Array<{
    label: string;
    responseCount: number;
    mrrImpact: number;
    quotes: string[];
  }>;
  dashboardUrl: string;
}

const THEME_RANK_LABELS = ['#1', '#2', '#3'];

export default function WeeklyDigest({
  founderName = 'there',
  weekOf = '2026-03-09',
  totalCancellations = 12,
  totalMrrLost = 348,
  themes = [
    {
      label: 'Too expensive for stage',
      responseCount: 6,
      mrrImpact: 174,
      quotes: ["I'm pre-revenue, $29 is hard to justify right now."],
    },
    {
      label: 'Missing Slack integration',
      responseCount: 4,
      mrrImpact: 116,
      quotes: ["I need alerts in Slack — email digest I don't check daily."],
    },
    {
      label: 'Switched to Churnkey',
      responseCount: 2,
      mrrImpact: 58,
      quotes: ['My co-founder was already using Churnkey before I joined.'],
    },
  ],
  dashboardUrl = 'https://app.churnlens.com/dashboard',
}: WeeklyDigestProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>
        Week of {weekOf}: {totalCancellations} cancellations · ${totalMrrLost} MRR
        lost · top theme: {themes[0]?.label}
      </Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          {/* Wordmark */}
          <Text style={wordmarkStyle}>
            Churn<span style={{ color: '#f59e0b' }}>Lens</span>
          </Text>

          <Heading style={h1Style}>Your weekly digest</Heading>
          <Text style={mutedStyle}>Week of {weekOf}</Text>

          <Text style={greetingStyle}>Hey {founderName},</Text>

          {/* Stats strip */}
          <Section style={statsBoxStyle}>
            <Text style={statsTextStyle}>
              <strong style={{ color: '#f4f4f5' }}>{totalCancellations}</strong>{' '}
              cancellations this week &nbsp;·&nbsp;{' '}
              <strong style={{ color: '#f4f4f5' }}>${totalMrrLost}</strong> MRR
              lost
            </Text>
          </Section>

          <Text style={sectionLabelStyle}>TOP REASONS CUSTOMERS LEFT</Text>
          <Hr style={hrStyle} />

          {themes.map((theme, i) => (
            <Section key={theme.label} style={themeBlockStyle}>
              <Text style={themeHeaderStyle}>
                <span style={{ color: '#71717a' }}>{THEME_RANK_LABELS[i]}</span>
                {'  '}
                <strong style={{ color: '#f4f4f5' }}>{theme.label}</strong>
                {'  '}
                <span style={{ color: '#71717a' }}>
                  ({theme.responseCount} response
                  {theme.responseCount !== 1 ? 's' : ''}, ${theme.mrrImpact}{' '}
                  MRR)
                </span>
              </Text>
              {theme.quotes.map((q) => (
                <Text key={q} style={quoteStyle}>
                  &ldquo;{q}&rdquo;
                </Text>
              ))}
            </Section>
          ))}

          <Hr style={hrStyle} />

          <Text style={bodyTextStyle}>
            <Link href={dashboardUrl} style={linkStyle}>
              View all responses in your dashboard &rarr;
            </Link>
          </Text>

          <Text style={bodyTextStyle}>
            Until next Monday,
            <br />
            ChurnLens
          </Text>

          <Hr style={{ ...hrStyle, marginTop: '32px' }} />

          <Text style={footerStyle}>
            You&apos;re on the Starter plan.{' '}
            <Link href={`${dashboardUrl}/settings`} style={linkStyle}>
              Manage preferences
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Styles — inline required for email client compatibility
const bodyStyle: React.CSSProperties = {
  backgroundColor: '#09090b',
  fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
  margin: 0,
  padding: '40px 0',
};

const containerStyle: React.CSSProperties = {
  backgroundColor: '#18181b',
  border: '1px solid #27272a',
  borderRadius: '12px',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '40px 48px',
};

const wordmarkStyle: React.CSSProperties = {
  color: '#f4f4f5',
  fontSize: '18px',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  margin: '0 0 24px',
};

const h1Style: React.CSSProperties = {
  color: '#fafafa',
  fontSize: '22px',
  fontWeight: '700',
  margin: '0 0 4px',
};

const mutedStyle: React.CSSProperties = {
  color: '#71717a',
  fontSize: '13px',
  margin: '0 0 24px',
};

const greetingStyle: React.CSSProperties = {
  color: '#d4d4d8',
  fontSize: '15px',
  margin: '0 0 20px',
};

const statsBoxStyle: React.CSSProperties = {
  backgroundColor: '#27272a',
  borderRadius: '8px',
  padding: '12px 16px',
  margin: '0 0 28px',
};

const statsTextStyle: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: '14px',
  margin: 0,
};

const sectionLabelStyle: React.CSSProperties = {
  color: '#52525b',
  fontSize: '11px',
  fontWeight: '600',
  letterSpacing: '0.08em',
  margin: '0 0 4px',
};

const hrStyle: React.CSSProperties = {
  borderColor: '#27272a',
  margin: '0 0 20px',
};

const themeBlockStyle: React.CSSProperties = {
  margin: '0 0 20px',
};

const themeHeaderStyle: React.CSSProperties = {
  color: '#d4d4d8',
  fontSize: '14px',
  margin: '0 0 6px',
};

const quoteStyle: React.CSSProperties = {
  borderLeft: '3px solid #f59e0b',
  color: '#a1a1aa',
  fontStyle: 'italic',
  fontSize: '13px',
  margin: '0 0 4px',
  paddingLeft: '12px',
};

const bodyTextStyle: React.CSSProperties = {
  color: '#d4d4d8',
  fontSize: '14px',
  margin: '0 0 12px',
};

const linkStyle: React.CSSProperties = {
  color: '#f59e0b',
  textDecoration: 'none',
};

const footerStyle: React.CSSProperties = {
  color: '#52525b',
  fontSize: '12px',
  margin: 0,
};
