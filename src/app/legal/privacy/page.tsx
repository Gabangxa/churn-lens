import LegalPage, { Section, List, Callout } from '@/components/LegalPage';
import { LEGAL, SUB_PROCESSORS } from '@/lib/legal';

export const metadata = {
  title: 'Privacy Policy — ChurnLens',
  description: 'How ChurnLens collects, uses, and protects personal data.',
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="How ChurnLens handles personal data — both for the founders who use it and for the customers who receive an exit survey."
    >
      <Section heading="1. Who we are">
        <p>
          ChurnLens is operated by {LEGAL.entity}, {LEGAL.entityDescription}, of{' '}
          {LEGAL.postalAddress} (&quot;ChurnLens&quot;, &quot;we&quot;, &quot;us&quot;).
        </p>
        <p>
          For privacy questions or to exercise your rights, contact{' '}
          <a href={`mailto:${LEGAL.privacyEmail}`} className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            {LEGAL.privacyEmail}
          </a>
          .
        </p>
      </Section>

      <Section heading="2. Who this policy is for">
        <p>
          ChurnLens sits between two different groups of people, and the law treats them
          differently. Find yourself below.
        </p>
        <Callout>
          <p className="mb-3">
            <strong className="text-zinc-900 dark:text-zinc-100">
              If you signed up for ChurnLens
            </strong>{' '}
            — you are our customer. We decide how your account data is handled, so we are
            the &quot;controller&quot; for it. Sections 3, 5 and 6 apply to you.
          </p>
          <p>
            <strong className="text-zinc-900 dark:text-zinc-100">
              If you received an exit survey email
            </strong>{' '}
            — you cancelled a subscription with a business that uses ChurnLens. That
            business decides to send the survey and what it asks; they are the
            &quot;controller&quot;. We only act on their instructions, so we are their
            &quot;processor&quot;. Sections 4 and 7 apply to you, and you should direct
            most requests to that business rather than to us.
          </p>
        </Callout>
      </Section>

      <Section heading="3. Data we collect about our customers">
        <p>When a founder signs up and connects their Stripe account, we store:</p>
        <List
          items={[
            <>
              <strong>Email address</strong> — used to sign you in and to send the weekly
              digest. We do not store passwords; sign-in is by emailed magic link only.
            </>,
            <>
              <strong>Your Stripe restricted API key and webhook signing secret</strong> —
              encrypted at rest with AES-256-GCM. Used only to read cancellation events and
              to look up the cancelling customer.
            </>,
            <>
              <strong>Survey customisation</strong> — the display name, logo URL and any
              custom cancellation reasons you configure.
            </>,
            <>
              <strong>A session cookie</strong> — a signed identifier that keeps you logged
              in. See section 9.
            </>,
            <>
              <strong>Sign-in tokens</strong> — stored only as a one-way hash, valid for 15
              minutes, single-use, and deleted shortly after expiry.
            </>,
          ]}
        />
      </Section>

      <Section heading="4. Data we process about churned customers">
        <p>
          When a customer cancels a subscription with a business using ChurnLens, that
          business&apos;s Stripe account notifies us and we process, on their instructions:
        </p>
        <List
          items={[
            <>Email address and name, as held in that business&apos;s Stripe account</>,
            <>The Stripe subscription identifier and the value of the cancelled subscription</>,
            <>The cancellation reason selected, and any free-text answers given</>,
            <>Whether the recipient has opted out of further survey emails</>,
          ]}
        />
        <p>
          We did not obtain this information from you directly — we received it from the
          business you cancelled with. We use it for one purpose only: to deliver that
          business&apos;s exit survey and report the results back to them. We never sell it,
          never use it for our own marketing, and never combine it across businesses.
        </p>
        <Callout>
          <p>
            <strong className="text-zinc-900 dark:text-zinc-100">Free-text answers.</strong>{' '}
            Your written answer to &quot;can you tell us a bit more?&quot; is sent to OpenAI
            to group similar responses into themes. OpenAI does not use data submitted
            through its API to train its models, and deletes it after a short abuse-monitoring
            period. Your answer to &quot;what would bring you back?&quot; is not sent to
            OpenAI.
          </p>
        </Callout>
      </Section>

      <Section heading="5. Why we process it, and our legal basis">
        <List
          items={[
            <>
              <strong>To provide the service to our customers</strong> — performance of our
              contract with them.
            </>,
            <>
              <strong>To send exit surveys to churned customers</strong> — the legitimate
              interests of the business you cancelled with, in understanding why customers
              leave. That business is responsible for establishing this basis; see section 7
              for your right to object.
            </>,
            <>
              <strong>To secure the service and prevent abuse</strong> — our legitimate
              interest in operating the service safely.
            </>,
            <>
              <strong>To meet legal obligations</strong> — where we are required to retain
              or disclose information.
            </>,
          ]}
        />
      </Section>

      <Section heading="6. Who we share data with">
        <p>
          We do not sell personal data. We share it only with the service providers below,
          each bound to process it only on our instructions:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b-2 border-zinc-200 dark:border-zinc-800">
                <th className="py-2 pr-4 font-bold text-zinc-900 dark:text-zinc-100">Provider</th>
                <th className="py-2 pr-4 font-bold text-zinc-900 dark:text-zinc-100">Purpose</th>
                <th className="py-2 font-bold text-zinc-900 dark:text-zinc-100">Location</th>
              </tr>
            </thead>
            <tbody>
              {SUB_PROCESSORS.map((sp) => (
                <tr key={sp.name} className="border-b border-zinc-100 dark:border-zinc-800/60">
                  <td className="py-3 pr-4">
                    <a href={sp.url} className="font-bold text-pink-500 dark:text-pink-400 hover:underline" target="_blank" rel="noreferrer">
                      {sp.name}
                    </a>
                  </td>
                  <td className="py-3 pr-4">{sp.purpose}</td>
                  <td className="py-3">{sp.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Stripe is not on this list.</strong> We never send data to Stripe. We read
          cancellation events from our customer&apos;s own Stripe account using a restricted
          key they provide. Stripe&apos;s handling of that data is governed by their
          agreement with that business.
        </p>
        <p>
          <strong>Polar receives account data only.</strong> Polar is the merchant of record
          for ChurnLens subscriptions, so it processes the account holder&apos;s name, email
          address and billing details. It never receives exit-survey data — no churned
          customer&apos;s name, email address or free-text answer is disclosed to it. That is
          why Polar does not appear in the sub-processor table of our{' '}
          <a href="/legal/dpa" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            Data Processing Agreement
          </a>
          , which covers only the data we process on our customers&apos; behalf.
        </p>
        <p>
          We may also disclose data where required by law, or to a successor entity in a
          merger or acquisition, in which case this policy continues to apply.
        </p>
      </Section>

      <Section heading="7. International transfers">
        <p>
          Our providers are located in the United States. Where personal data of individuals
          in the UK or European Economic Area is transferred there, the transfer relies on
          the UK International Data Transfer Addendum or the European Commission&apos;s
          Standard Contractual Clauses, as incorporated into our agreements with each
          provider.
        </p>
      </Section>

      <Section heading="8. How long we keep it">
        <List
          items={[
            <>
              <strong>Customer account data</strong> — for as long as the account is open,
              then deleted within {LEGAL.deletionWindow} of account closure.
            </>,
            <>
              <strong>Survey responses</strong> — retained for{' '}
              {LEGAL.surveyResponseRetention} from collection, or until the business that
              collected them closes their account or asks us to delete them, whichever comes
              first.
            </>,
            <>
              <strong>Opt-out records</strong> — kept indefinitely. We have to remember that
              you opted out in order to keep honouring it.
            </>,
            <>
              <strong>Sign-in tokens</strong> — deleted shortly after they expire.
            </>,
          ]}
        />
      </Section>

      <Section heading="9. Cookies">
        <p>
          We set one cookie, <code className="font-mono text-pink-600 dark:text-pink-400">churnlens_org_id</code>,
          which keeps you signed in. It is cryptographically signed, marked HttpOnly and
          Secure, and contains no personal data beyond an account identifier. It is strictly
          necessary to operate the service, so we do not ask for consent to set it.
        </p>
        <p>
          We use no analytics, advertising, or third-party tracking cookies. The exit survey
          pages set no cookies at all.
        </p>
      </Section>

      <Section heading="10. Security">
        <List
          items={[
            <>Stripe API keys and webhook secrets are encrypted at rest with AES-256-GCM.</>,
            <>Sign-in tokens are stored only as one-way hashes, expire in 15 minutes, and cannot be reused.</>,
            <>Session cookies are cryptographically signed and rejected if tampered with.</>,
            <>Survey links are signed and expire after 7 days.</>,
            <>Incoming Stripe webhooks are verified against a per-account signing secret.</>,
            <>Data is transmitted over TLS.</>,
          ]}
        />
        <p>
          No system is perfectly secure. If we become aware of a breach affecting your
          personal data, we will notify the relevant supervisory authority and affected
          individuals as required by law.
        </p>
      </Section>

      <Section heading="11. Your rights">
        <p>
          Depending on where you live, you may have the right to access, correct, delete,
          port, or restrict processing of your personal data, and to object to processing
          based on legitimate interests.
        </p>
        <Callout>
          <p className="mb-3">
            <strong className="text-zinc-900 dark:text-zinc-100">
              If you received an exit survey
            </strong>{' '}
            — the business you cancelled with controls your data. Contact them first. If you
            contact us instead, we will pass your request to them and assist them in
            responding; we are not permitted to delete their data on our own initiative.
          </p>
          <p>
            To stop receiving survey emails immediately, use the unsubscribe link at the
            bottom of the email. That takes effect at once and requires no account.
          </p>
        </Callout>
        <p>
          If you are a ChurnLens customer, email {LEGAL.privacyEmail} and we will respond
          within one month. You also have the right to complain to your local data protection
          authority.
        </p>
      </Section>

      <Section heading="12. Children">
        <p>
          ChurnLens is a business tool and is not directed at children. We do not knowingly
          collect data from anyone under 16. If you believe we have, contact us and we will
          delete it.
        </p>
      </Section>

      <Section heading="13. Changes">
        <p>
          We may update this policy. Material changes will be notified by email to account
          holders at least 14 days before taking effect. The date at the top always reflects
          the current version.
        </p>
      </Section>
    </LegalPage>
  );
}
