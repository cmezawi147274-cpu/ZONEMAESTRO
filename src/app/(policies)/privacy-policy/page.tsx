import type { Metadata } from "next"
import { ContactLink, PolicyHeader, Section } from "../policy-parts"

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How the ZoneMaestro music management portal collects, uses and protects information.",
}

export default function PrivacyPolicyPage() {
  return (
    <article>
      <PolicyHeader title="Privacy Policy" />

      <p className="text-[15px] leading-relaxed text-gray-400">
        This Privacy Policy explains what information ZoneMaestro collects when your organization uses it to manage
        music across its venues, how that information is used, and the choices available to you.
      </p>

      <Section title="1. Information we collect">
        <ul>
          <li>
            <strong>Account details:</strong> your name, email address, role, assigned organization or location, and
            when you last signed in. Passwords are stored only as salted hashes, never in readable form.
          </li>
          <li>
            <strong>Organization and venue details:</strong> organization name and contact person, location names,
            addresses, countries and time zones.
          </li>
          <li>
            <strong>Music and playback content:</strong> uploaded audio files and their details (title, artist, album,
            genre), playlists, schedules, zone settings, equalizer presets and Prayer Mode settings.
          </li>
          <li>
            <strong>MusicServer data:</strong> server name, software version, operating system, IP address, CPU,
            memory and disk usage, cache status, logs, and a reported time zone and location used for scheduling and
            prayer times.
          </li>
          <li>
            <strong>Activity and security records:</strong> sign-ins, sign-outs, failed sign-in attempts, commands
            sent to zones, and administrative changes, including the IP address and browser details of the person who
            made them.
          </li>
        </ul>
      </Section>

      <Section title="2. How we use it">
        <ul>
          <li>to sign you in and apply the permissions of your role;</li>
          <li>to store your music library and sync it to your paired MusicServers;</li>
          <li>to run schedules, Prayer Mode and remote playback controls;</li>
          <li>to show server health, alerts and activity on the dashboard;</li>
          <li>to keep the service secure, investigate problems and keep an audit trail.</li>
        </ul>
        <p>We do not sell your information and we do not use it for advertising.</p>
      </Section>

      <Section title="3. Emails">
        <p>
          ZoneMaestro sends an invitation email when an administrator creates your account. We do not send marketing
          emails or newsletters.
        </p>
      </Section>

      <Section title="4. Cookies and browser storage">
        <p>
          We use one essential cookie to keep you signed in, and your browser&apos;s local storage to hold your session,
          your display preference and cached Prayer Mode times. We do not use advertising or analytics cookies or
          third-party trackers.
        </p>
      </Section>

      <Section title="5. Sharing with third parties">
        <p>
          Information is shared only as needed to run ZoneMaestro: with the hosting infrastructure that runs the
          service, and, when Prayer Mode is enabled, with the AlAdhan Prayer Times API, which receives only a
          venue&apos;s coordinates, time zone and calculation method. No names or email addresses are sent. We may also
          disclose information where the law requires it.
        </p>
      </Section>

      <Section title="6. How long we keep it">
        <ul>
          <li>MusicServer logs: 30 days.</li>
          <li>Activity history, completed zone commands and acknowledged alerts: 90 days.</li>
          <li>Security audit records: about 13 months (400 days).</li>
          <li>Expired sign-in tokens are deleted automatically.</li>
          <li>
            Account, venue and music data: while your organization uses ZoneMaestro, or until an administrator deletes
            it.
          </li>
        </ul>
      </Section>

      <Section title="7. Security">
        <p>
          Connections to ZoneMaestro are encrypted with HTTPS. Passwords, sign-in tokens and MusicServer credentials are
          stored as hashes, access is limited by role and organization, and MusicServers only connect outward to the
          cloud. No system is perfectly secure, but we work to protect your information.
        </p>
      </Section>

      <Section title="8. Your choices and rights">
        <p>
          You can ask to access, correct or delete your personal information. Many changes can be made by your
          organization&apos;s administrator, who manages user accounts. Depending on where you are, you may have other
          rights under data protection law, including the right to complain to a supervisory authority.
        </p>
      </Section>

      <Section title="9. Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. The date at the top shows the latest version.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          For privacy questions or requests, contact <ContactLink />.
        </p>
      </Section>
    </article>
  )
}
