import Link from 'next/link';
import LegalPage, { Section, List, Callout } from '@/components/LegalPage';
import { LEGAL } from '@/lib/legal';

export const metadata = {
  title: 'Terms of Service — ChurnLens',
  description: 'The agreement between ChurnLens and the businesses that use it.',
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro="The agreement between you and ChurnLens. Section 7 matters most — it covers your responsibilities for the emails we send to your customers."
    >
      <Section heading="1. Agreement">
        <p>
          These Terms are between {LEGAL.entity}, {LEGAL.entityDescription}, of{' '}
          {LEGAL.postalAddress} (&quot;ChurnLens&quot;, &quot;we&quot;) and the individual or
          entity using the service (&quot;you&quot;). By creating an account or using
          ChurnLens you accept these Terms. If you are agreeing on behalf of a company, you
          confirm you have authority to bind it.
        </p>
        <p>
          Our{' '}
          <Link href="/legal/privacy" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/legal/dpa" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
            Data Processing Agreement
          </Link>{' '}
          form part of these Terms.
        </p>
      </Section>

      <Section heading="2. What the service does">
        <p>
          ChurnLens connects to your Stripe account, detects subscription cancellations,
          emails the cancelling customer a short exit survey, and reports the responses back
          to you through a dashboard, an optional weekly digest, and — on paid plans —
          AI-generated groupings of common themes.
        </p>
        <p>
          We may change, add or remove features. If we materially reduce functionality you
          are paying for, we will give reasonable notice and you may cancel for a pro-rata
          refund of any prepaid period.
        </p>
      </Section>

      <Section heading="3. Your account">
        <p>
          You must give accurate information and keep your account secure. Sign-in is by
          emailed magic link, so anyone with access to your email inbox can access your
          account — secure your inbox accordingly. You are responsible for all activity under
          your account. Tell us promptly at {LEGAL.supportEmail} if you suspect unauthorised
          access.
        </p>
        <p>
          You must be at least 18 and must not be barred from receiving our services under
          applicable law.
        </p>
      </Section>

      <Section heading="4. Your data stays yours">
        <p>
          You own the data you bring to ChurnLens and the survey responses collected on your
          behalf (&quot;Your Data&quot;). You grant us a limited, non-exclusive licence to
          host, process and transmit Your Data solely to provide the service to you and as
          set out in the Data Processing Agreement.
        </p>
        <p>
          We do not use Your Data to train our own models, do not sell it, and do not combine
          it with other customers&apos; data. We may use aggregated, fully anonymised
          statistics that cannot identify you or any individual to improve and describe the
          service.
        </p>
      </Section>

      <Section heading="5. Acceptable use">
        <p>You agree not to:</p>
        <List
          items={[
            <>Use ChurnLens to send anything other than genuine exit surveys to your own former customers.</>,
            <>Add promotional, marketing, or sales content to survey questions or custom cancellation reasons.</>,
            <>Upload a Stripe key belonging to an account you do not control.</>,
            <>Attempt to access another customer&apos;s data, probe or disrupt the service, or circumvent rate limits.</>,
            <>Use the service to collect special category data (health, political opinions, and similar) or payment card details.</>,
            <>Resell or white-label the service without our written agreement.</>,
          ]}
        />
        <Callout>
          <p>
            <strong className="text-zinc-900 dark:text-zinc-100">Why the marketing rule matters.</strong>{' '}
            A genuine customer survey is generally not treated as direct marketing, which is
            what allows these emails to be sent without prior consent. Adding promotional
            content can change that classification and expose both of us to liability under
            marketing and electronic communications laws. This is a hard rule, not a
            preference.
          </p>
        </Callout>
      </Section>

      <Section heading="6. Plans, fees and cancellation">
        <p>
          Paid plans are billed in advance on a recurring basis at the price shown when you
          subscribe. Fees exclude taxes unless stated otherwise. You can cancel at any time
          from your account; cancellation takes effect at the end of the current billing
          period and we do not provide pro-rata refunds for partial periods except where
          section 2 applies or the law requires it.
        </p>
        <p>
          Free plans are limited to the allowance published on our pricing page and may be
          changed or withdrawn with notice. If payment fails we may suspend paid features
          after reasonable notice.
        </p>
      </Section>

      <Section heading="7. Your responsibilities to your own customers">
        <Callout>
          <p className="mb-3">
            This is the most important section of these Terms. ChurnLens emails{' '}
            <strong className="text-zinc-900 dark:text-zinc-100">your</strong> former
            customers on{' '}
            <strong className="text-zinc-900 dark:text-zinc-100">your</strong> instruction.
            In data protection terms you are the controller and we are your processor. That
            allocation of responsibility is not merely formal — it determines who answers to
            a regulator.
          </p>
          <p>
            By connecting your Stripe account and enabling surveys, you instruct us to
            contact the individuals whose details are in that account when they cancel.
          </p>
        </Callout>
        <p>You confirm and agree that:</p>
        <List
          items={[
            <>
              You have a lawful basis to contact your former customers for this purpose, and
              have carried out any assessment your jurisdiction requires (for example a
              legitimate interests assessment under UK or EU data protection law).
            </>,
            <>
              Your own privacy notice tells your customers that their data may be shared with
              a service provider for the purpose of post-cancellation feedback, and is
              accessible to them.
            </>,
            <>
              You will not instruct us to contact anyone who has objected, opted out, or
              otherwise asked not to be contacted.
            </>,
            <>
              You will respond to data subject requests from your own customers, and we will
              assist you as set out in the Data Processing Agreement.
            </>,
            <>
              You will keep survey content non-promotional, as required by section 5.
            </>,
          ]}
        />
        <p>
          We maintain the compliance elements of the survey email — sender identification,
          our postal address, and a working one-click unsubscribe — and these cannot be
          removed or overridden through survey customisation. Unsubscribes are honoured
          immediately and permanently for the customer and business concerned.
        </p>
      </Section>

      <Section heading="8. Third-party services">
        <p>
          ChurnLens depends on Stripe, and on the providers listed in our Privacy Policy. We
          are not responsible for those services&apos; availability or acts. Your use of
          Stripe is governed by your agreement with Stripe. If you revoke the API key you
          gave us, the service will stop working.
        </p>
      </Section>

      <Section heading="9. Availability and disclaimer">
        <p>
          We work to keep ChurnLens available but do not commit to a specific uptime level.
          The service is provided &quot;as is&quot; and &quot;as available&quot;. To the
          fullest extent permitted by law we disclaim all implied warranties, including
          merchantability, fitness for a particular purpose, and non-infringement.
        </p>
        <p>
          AI-generated themes are produced by an automated language model and may be
          inaccurate, incomplete, or misleading. They are a summarising aid, not business
          advice, and you should not rely on them as the sole basis for a decision.
        </p>
      </Section>

      <Section heading="10. Limitation of liability">
        <p>
          To the fullest extent permitted by law, neither party is liable for indirect,
          incidental, special, consequential or punitive damages, or for lost profits,
          revenue, data or goodwill, even if advised of the possibility.
        </p>
        <p>
          Our total aggregate liability arising out of or relating to these Terms is limited
          to the greater of (a) the fees you paid us in the 12 months before the event giving
          rise to the claim, or (b) 100 units of the currency in which you are billed.
        </p>
        <p>
          Nothing here limits liability for death or personal injury caused by negligence,
          fraud or fraudulent misrepresentation, or any liability that cannot lawfully be
          limited. Some jurisdictions do not allow certain exclusions, so parts of this
          section may not apply to you.
        </p>
      </Section>

      <Section heading="11. Indemnity">
        <p>
          You will defend, indemnify and hold harmless ChurnLens against any third-party
          claim, and any resulting loss, liability, damages, fine, penalty or reasonable legal
          cost, arising out of or relating to:
        </p>
        <List
          items={[
            <>
              your breach of section 5 (acceptable use) or section 7 (responsibilities to
              your own customers);
            </>,
            <>
              your lack of a lawful basis, adequate privacy notice, or valid instruction for
              contacting the individuals we email on your behalf;
            </>,
            <>
              the content of any survey question, custom cancellation reason, display name or
              logo you configure;
            </>,
            <>Your Data, and any claim that it infringes or misappropriates a third-party right.</>,
          ]}
        />
        <p>
          We will notify you promptly of any claim, give you control of the defence (except
          that you may not settle in a way that imposes obligations on us without our
          consent), and provide reasonable cooperation at your expense.
        </p>
      </Section>

      <Section heading="12. Suspension and termination">
        <p>
          You may close your account at any time. We may suspend or terminate your access
          with notice if you materially breach these Terms, or immediately where continued
          access presents a legal or security risk.
        </p>
        <p>
          On termination we stop processing and delete Your Data — including survey responses
          collected on your behalf — within {LEGAL.deletionWindow}, except where we must
          retain it by law and except for opt-out records, which we keep so that suppression
          continues to be honoured. You may export your data before closing your account, and
          on request within the deletion window.
        </p>
      </Section>

      <Section heading="13. Changes to these Terms">
        <p>
          We may update these Terms. Material changes will be notified by email at least 14
          days before they take effect. Continuing to use ChurnLens after that constitutes
          acceptance. If you object, you may cancel before the change takes effect and
          receive a pro-rata refund of any prepaid period.
        </p>
      </Section>

      <Section heading="14. Governing law">
        <p>
          These Terms are governed by the laws of {LEGAL.jurisdiction}, without regard to
          conflict of laws rules, and the parties submit to the exclusive jurisdiction of{' '}
          {LEGAL.courts}. If you are a consumer, you keep the benefit of any mandatory
          protections of your country of residence.
        </p>
      </Section>

      <Section heading="15. General">
        <p>
          If any provision is unenforceable, the rest remains in effect. Our failure to
          enforce a provision is not a waiver. You may not assign these Terms without our
          consent; we may assign them to a successor in a merger or acquisition. These Terms,
          with the Privacy Policy and Data Processing Agreement, are the entire agreement
          between us and supersede prior discussions. There are no third-party beneficiaries.
        </p>
      </Section>
    </LegalPage>
  );
}
