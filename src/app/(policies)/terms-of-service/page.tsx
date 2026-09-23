import type { Metadata } from "next"
import Link from "next/link"
import { ContactLink, PolicyHeader, Section } from "../policy-parts"

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of the ZoneMaestro music management portal.",
}

export default function TermsOfServicePage() {
  return (
    <article>
      <PolicyHeader title="Terms of Service" />

      <p className="text-[15px] leading-relaxed text-gray-400">
        These Terms of Service govern your use of ZoneMaestro, the cloud portal used to manage music across venues:
        uploading and organizing a music library, building playlists and schedules, syncing music to Windows
        MusicServers at each location, and monitoring and controlling playback zones. By signing in, you agree to these
        terms. If you use ZoneMaestro on behalf of an organization, you confirm you are authorized to do so.
      </p>

      <Section title="1. Accounts and access">
        <p>
          ZoneMaestro accounts are created by invitation from an administrator. There is no public sign-up. Access is
          based on your assigned role (for example organization administrator, location manager or viewer), and you
          may only use the parts of the portal your role allows.
        </p>
        <ul>
          <li>Keep your password confidential and do not share your account.</li>
          <li>Tell your administrator or us promptly if you suspect unauthorized access.</li>
          <li>You are responsible for actions taken under your account.</li>
        </ul>
      </Section>

      <Section title="2. Your organization and its content">
        <p>
          Your organization keeps ownership of the music files, playlists, schedules, venue details and other content
          it adds to ZoneMaestro. You give us permission to store, process, transmit and cache that content only as
          needed to run the service, including copying music to your paired MusicServers.
        </p>
        <p>
          <strong>Music licensing.</strong> Unless your agreement with us expressly says otherwise, ZoneMaestro does
          not provide music licenses. You are responsible for holding every right and license needed to upload, store
          and publicly perform the music you play through ZoneMaestro, including public performance licenses required
          where your venues operate.
        </p>
      </Section>

      <Section title="3. MusicServers and venue equipment">
        <p>
          Venue playback runs on MusicServer software installed on computers you control. You are responsible for that
          equipment, its network connection, and pairing it with the correct location. Pairing codes and server
          credentials must be kept private. MusicServers keep a local cache so they can continue playing if the
          connection to the cloud drops.
        </p>
      </Section>

      <Section title="4. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>upload content you do not have the right to use, or that is unlawful or harmful;</li>
          <li>access data belonging to another organization, or try to bypass roles and permissions;</li>
          <li>probe, disrupt or overload the service, or reverse-engineer it except where the law allows;</li>
          <li>use ZoneMaestro in breach of any applicable law.</li>
        </ul>
      </Section>

      <Section title="5. Features that depend on third parties">
        <p>
          Prayer Mode pauses music at prayer times calculated by the AlAdhan Prayer Times API from your venue&apos;s
          location. These times depend on an external service and your chosen calculation method, so they are
          provided as a convenience and may not always be exact.
        </p>
      </Section>

      <Section title="6. Service availability and changes">
        <p>
          We work to keep ZoneMaestro available and secure, but we do not guarantee uninterrupted or error-free
          operation. We may update, improve or change features over time. Plans, fees and any service levels are set out
          in your organization&apos;s agreement with us.
        </p>
      </Section>

      <Section title="7. Suspension and termination">
        <p>
          We may suspend or disable access that breaches these terms or puts the service or other customers at risk.
          Administrators can remove users, venues and servers at any time. When an organization stops using ZoneMaestro,
          its data is handled as described in our{" "}
          <Link
            href="/privacy-policy"
            className="rounded-sm text-gray-300 underline decoration-gray-600 underline-offset-2 transition-colors hover:text-white hover:decoration-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34b4f5]/50"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section title="8. Disclaimers and liability">
        <p>
          To the extent permitted by law, ZoneMaestro is provided &ldquo;as is&rdquo;, and we are not liable for
          indirect or consequential losses, lost revenue, or losses caused by venue equipment, internet outages, or
          content you upload. Nothing in these terms limits liability that cannot be limited by law.
        </p>
      </Section>

      <Section title="9. Changes to these terms">
        <p>
          We may update these Terms of Service from time to time. The date at the top shows the latest version.
          Continuing to use ZoneMaestro after a change means you accept the updated terms.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          Questions about these terms can be sent to <ContactLink />.
        </p>
      </Section>
    </article>
  )
}
