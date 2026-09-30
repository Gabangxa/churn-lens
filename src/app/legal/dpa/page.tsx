import Link from 'next/link';
import LegalPage, { Section, List, Callout } from '@/components/LegalPage';
import { LEGAL, DPA_SUB_PROCESSORS } from '@/lib/legal';

export const metadata = {
  title: 'Data Processing Agreement — ChurnLens',
  description:
    'The operator terms POPIA section 21 requires, and processor terms under GDPR Article 28, between ChurnLens and its customers.',
};

export default function DpaPage() {
  return (
    <LegalPage
      title="Data Processing Agreement"
      intro="The processor terms that apply when ChurnLens handles personal data on your behalf. These form part of our Terms of Service."
    >
      <Section heading="1. Scope and roles">
        <p>
          This Agreement applies where {LEGAL.entity} (&quot;Processor&quot;) processes
          personal data on behalf of a customer (&quot;Controller&quot;) in providing
          ChurnLens. It is incorporated into and governed by our{' '}
          <Link href="/legal/terms" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            Terms of Service
          </Link>
          , and takes effect when you begin using the service. No signature is required, but
          we will countersign a copy on request to {LEGAL.privacyEmail}.
        </p>
        <Callout>
          <p>
            You are the Controller of your former customers&apos; personal data. You decide
            that surveys are sent and what they ask. We are your Processor and act only on
            your instructions. Please read this document rather than assuming its contents —
            it allocates real obligations to you.
          </p>
        </Callout>
        <p>
          Where the personal data concerned is subject to South Africa&apos;s Protection of
          Personal Information Act (POPIA), this Agreement is also the written contract that
          POPIA section 21 requires between a &quot;responsible party&quot; and an
          &quot;operator&quot; before the latter may process personal data on the former&apos;s
          behalf. Throughout this document, &quot;Controller&quot; and &quot;responsible
          party&quot; are used interchangeably, as are &quot;Processor&quot; and
          &quot;operator&quot; — the same allocation of responsibility, under two different
          statutes.
        </p>
      </Section>

      <Section heading="2. Subject matter and details of processing">
        <List
          items={[
            <><strong>Subject matter</strong> — provision of the ChurnLens exit-survey service.</>,
            <><strong>Duration</strong> — for as long as your account is open, plus the deletion window in section 9.</>,
            <><strong>Nature and purpose</strong> — collecting, storing, transmitting, analysing and reporting cancellation feedback.</>,
            <>
              <strong>Categories of data subject</strong> — your former customers whose
              subscriptions have been cancelled. Your own account details (the people who sign
              in to ChurnLens) are not covered here: we handle those as controller, under our
              Privacy Policy.
            </>,
            <>
              <strong>Categories of personal data</strong> — name, email address, subscription
              identifier, subscription value, cancellation reason, free-text feedback, and
              opt-out status.
            </>,
            <>
              <strong>Special personal information</strong> (special category data) — none
              requested. The service is not designed for it, and you must not configure survey
              questions or reasons that ask for it. Free-text answers are written by your
              customers and may incidentally contain it; we process any such content only as
              part of the service described here.
            </>,
          ]}
        />
      </Section>

      <Section heading="3. Instructions, and your obligations as responsible party">
        <p>
          We process personal data only on your documented instructions, including for
          international transfers, unless required otherwise by law — in which case we will
          tell you before processing, unless that law prohibits it. Your instructions are
          given through your configuration and use of the service, and through this Agreement
          and the Terms.
        </p>
        <p>
          We will tell you if, in our opinion, an instruction infringes applicable data
          protection law.
        </p>
        <p>As Controller (responsible party), you are responsible for:</p>
        <List
          items={[
            <>
              Having a lawful basis to have your former customers contacted for feedback (a
              justification under POPIA section 11, or its equivalent where you operate).
            </>,
            <>
              Telling your customers, in your own privacy notice, that their details may be
              shared with a service provider for post-cancellation feedback (POPIA section 18).
            </>,
            <>
              Not instructing us to contact anyone who has objected, opted out, or asked not to
              be contacted.
            </>,
            <>
              Keeping survey content non-promotional, as the Terms of Service require.
            </>,
            <>
              Responding to your customers&apos; requests to exercise their rights, and making any
              notifications to a regulator or to affected individuals that the law requires of
              you. We assist with both as set out in sections 7 and 8.
            </>,
          ]}
        />
        <p>
          Section 7 of the{' '}
          <Link href="/legal/terms" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            Terms of Service
          </Link>{' '}
          sets out these responsibilities in full.
        </p>
      </Section>

      <Section heading="4. Confidentiality">
        <p>
          We treat personal data processed on your behalf as confidential and do not disclose
          it, unless the law requires us to or it is necessary for the proper performance of
          the service, including disclosure to the sub-processors listed in section 6 (POPIA
          section 20).
        </p>
        <p>
          We ensure that anyone authorised to process personal data is bound by an
          appropriate duty of confidentiality, and that access is limited to those who need
          it to provide or support the service.
        </p>
      </Section>

      <Section heading="5. Security measures">
        <p>Taking account of the risk, we implement measures including:</p>
        <List
          items={[
            <>Encryption of stored credentials at rest using AES-256-GCM.</>,
            <>Encryption in transit using TLS.</>,
            <>Authentication tokens stored only as one-way hashes, single-use and short-lived.</>,
            <>Cryptographically signed session cookies, and signed survey links that expire after 7 days.</>,
            <>Verification of the authenticity of inbound webhook events.</>,
            <>Logical separation of each Controller&apos;s data, with access scoped by account identifier.</>,
            <>Rate limiting on authentication and other sensitive endpoints.</>,
          ]}
        />
        <p>
          As POPIA section 19 requires, we identify reasonably foreseeable internal and
          external risks to the personal data we hold, maintain safeguards against them, and
          review and update those safeguards regularly, including in response to new risks.
        </p>
        <p>
          We may update these measures provided the level of protection is not materially
          reduced.
        </p>
      </Section>

      <Section heading="6. Sub-processors">
        <p>
          You give general authorisation for us to engage the sub-processors listed below.
          Each is bound by written terms offering protection materially equivalent to this
          Agreement, and we remain fully liable to you for their performance.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b-2 border-zinc-200 dark:border-zinc-800">
                <th className="py-2 pr-4 font-bold text-zinc-900 dark:text-zinc-100">Sub-processor</th>
                <th className="py-2 pr-4 font-bold text-zinc-900 dark:text-zinc-100">Purpose</th>
                <th className="py-2 pr-4 font-bold text-zinc-900 dark:text-zinc-100">Data</th>
                <th className="py-2 font-bold text-zinc-900 dark:text-zinc-100">Location</th>
              </tr>
            </thead>
            <tbody>
              {DPA_SUB_PROCESSORS.map((sp) => (
                <tr key={sp.name} className="border-b border-zinc-100 dark:border-zinc-800/60">
                  <td className="py-3 pr-4">
                    <a href={sp.url} className="font-bold text-pink-500 dark:text-pink-400 hover:underline" target="_blank" rel="noreferrer">
                      {sp.name}
                    </a>
                  </td>
                  <td className="py-3 pr-4">{sp.purpose}</td>
                  <td className="py-3 pr-4">{sp.data}</td>
                  <td className="py-3">{sp.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          We will give at least 30 days&apos; notice before adding or replacing a
          sub-processor, by email to your account&apos;s owner address and by updating the
          table above. If you reasonably object on data protection grounds within that
          period, you may terminate the affected service and receive a pro-rata refund of any
          prepaid fees.
        </p>
      </Section>

      <Section heading="7. Assistance with data subject rights">
        <p>
          Taking account of the nature of the processing, we will assist you by appropriate
          technical and organisational measures in responding to requests to exercise rights
          of access, rectification, erasure, restriction, portability and objection.
        </p>
        <p>
          If we receive such a request directly from one of your customers, we will not
          respond to it substantively ourselves. We will refer them to you and forward the
          request without undue delay. The one exception is unsubscribe requests, which we
          action immediately on your behalf, as they are also a legal requirement of the
          email itself.
        </p>
      </Section>

      <Section heading="8. Breach notification and impact assessments">
        <p>
          We will notify you immediately, and in any event within 48 hours, where there are
          reasonable grounds to believe that personal data processed on your behalf has been
          accessed or acquired by an unauthorised person (POPIA section 21(2)), or on becoming
          aware of any other personal data breach affecting your data. We will provide the
          information reasonably available to help you meet your own notification
          obligations, including under POPIA section 22.
        </p>
        <p>
          Notifications go to your account&apos;s owner email address. Our Information Officer,{' '}
          {LEGAL.informationOfficer}, is your contact for them at {LEGAL.privacyEmail}.
        </p>
        <p>
          We will provide reasonable assistance with data protection impact assessments and
          any prior consultation with a supervisory authority, so far as they relate to our
          processing and taking account of the information available to us.
        </p>
      </Section>

      <Section heading="9. Deletion and return">
        <p>
          On termination of your account, we will delete all personal data processed on your
          behalf within {LEGAL.deletionWindow}, unless retention is required by law. Before
          then you may request a copy in a commonly used machine-readable format by emailing{' '}
          {LEGAL.privacyEmail}.
        </p>
        <p>
          Residual copies held by sub-processors (for example, email delivery logs, or inputs
          retained for a limited period for abuse monitoring) and copies in infrastructure
          backups are deleted on those providers&apos; own retention schedules. They are not used
          for any purpose in the meantime.
        </p>
        <p>
          This is not aspirational: requesting account deletion from Settings triggers our
          account-deletion endpoint, which disconnects Stripe and stops surveys immediately and
          records the request; a daily purge job then permanently erases the account and its
          data once {LEGAL.deletionWindow} have passed. The same purge job independently
          enforces the survey-response retention period described in our Privacy Policy
          (section 8), so responses are deleted on a schedule regardless of whether or when you
          close your account.
        </p>
        <p>
          Opt-out records follow their own rule: we retain the minimum needed — the account
          identifier and the email address that opted out — for as long as your account with us
          exists, so that the suppression continues to be honoured while it can still apply.
          Once your account is closed, the corresponding opt-out records are deleted along with
          it by the same daily job: retaining them any longer serves no purpose once you can no
          longer instruct us to survey that customer again.
        </p>
      </Section>

      <Section heading="10. Audit">
        <p>
          We will make available the information reasonably necessary to demonstrate
          compliance with this Agreement and, on reasonable written notice and no more than
          once in any 12-month period, allow for and contribute to an audit conducted by you
          or an independent auditor you appoint, subject to confidentiality and to not
          unreasonably disrupting our operations. Where available, current third-party
          certifications or reports may be provided to satisfy this obligation.
        </p>
      </Section>

      <Section heading="11. International transfers">
        <p>
          Where we transfer personal data of individuals in the UK or European Economic Area
          outside those territories, the transfer is made under the European Commission&apos;s
          Standard Contractual Clauses, the UK International Data Transfer Addendum, or
          another lawful transfer mechanism, as incorporated into our agreements with each
          sub-processor.
        </p>
        <p>
          Where the data transferred is instead subject to POPIA, the transfer relies on
          section 72(1)(a): each sub-processor listed in section 6 is bound by a written data
          processing agreement which, in our assessment, provides an adequate level of
          protection — upholding principles for reasonable processing substantially similar to
          POPIA&apos;s conditions for lawful processing, including restrictions on onward
          transfer.
        </p>
      </Section>

      <Section heading="12. Precedence">
        <p>
          In the event of a conflict between this Agreement and the Terms of Service in
          relation to the processing of personal data, this Agreement prevails.
        </p>
      </Section>
    </LegalPage>
  );
}
