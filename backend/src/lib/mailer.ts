import nodemailer, { type Transporter } from "nodemailer"
import { env } from "./env.js"

/**
 * Outbound email. Today this exists for exactly one thing — the new-user
 * invitation sent from `POST /users/invite` — but is kept generic so a
 * password-reset or alert-notification mail can reuse `sendMail` later.
 *
 * Best-effort by design: nothing in this file may throw past its own
 * boundary in a way that fails the request that triggered it. A mail outage
 * must never be the reason a user couldn't be created (see lib/audit.ts for
 * the same rule applied to the audit trail).
 */

let transporter: Transporter | null | undefined

/** Whether SMTP_HOST/SMTP_USER/SMTP_PASSWORD have all been set. */
export function isMailConfigured(): boolean {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPassword)
}

function getTransporter(): Transporter | null {
  if (!isMailConfigured()) return null
  if (transporter !== undefined) return transporter
  transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: { user: env.smtpUser, pass: env.smtpPassword },
  })
  return transporter
}

export interface SendMailInput {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * Sends one email. Returns whether it went out. Deliberately swallows every
 * transport error (bad credentials, DNS failure, SMTP rejection, ...) rather
 * than rejecting — callers treat a mail outage as a log line, never as a
 * reason to fail the operation that triggered it.
 */
export async function sendMail(input: SendMailInput): Promise<boolean> {
  const t = getTransporter()
  if (!t) return false
  try {
    await t.sendMail({
      from: `${env.mailFromName} <${env.mailFromEmail}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
    return true
  } catch (err) {
    console.warn("[mailer] send failed:", err)
    return false
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export interface InviteEmailInput {
  to: string
  /** Full display name; only the first token is used as the greeting. */
  name: string
  password: string
  roleLabel: string
  venueName: string
  invitedBy: string
}

/**
 * Fifth attempt. Attempts 3 (`color-scheme: light dark` + matching media
 * query on inline styles) and 4 (the same colors moved into `<style>`
 * classes instead of inline) both still arrived light on the Gmail phone
 * app, even though 3 fixed Gmail's web client outright. That means the
 * app's rewriter isn't just checking *where* a color is declared
 * (inline vs. class) — moving it didn't help — which fits a simpler,
 * cheaper implementation than a full computed-style engine: a
 * pre-render pass that pattern-scans the raw HTML/CSS source for
 * `color:`/`background-color:` declarations and substitutes its own,
 * regardless of the modern opt-out meta tags. A few email-dev
 * write-ups on Gmail's app specifically report the same workaround this
 * version uses: remove every literal `color:`/`background-color:`
 * occurrence from the source entirely, so there is nothing matching
 * for that scan to find.
 *
 *  - Every background is a real hosted solid-color PNG
 *    (public/branding/bg-*.png, tiled — a 64x64 solid tile has no visible
 *    seams) painted via `background-image`, never `background-color`.
 *    An image has no CSS "color" for a luminance-based rewriter to grab.
 *  - Every piece of text color uses the legacy `<font color="#hex">`
 *    tag instead of CSS `color`. Different source syntax, same rendered
 *    result in every mail client that still matters.
 *  - Decorative borders are dropped rather than reintroduced as color:
 *    they were low-contrast hairlines to begin with, and keeping the
 *    experiment to one clean variable (zero `color:`/`background-color:`
 *    substrings anywhere in the document) matters more than a hairline.
 *
 * If a client's renderer truly walks computed style instead of scanning
 * source text, this changes nothing for it — background-image and
 * `<font>` still resolve to the same box-model background/color
 * properties Gmail's own dark theme would then also want to shift, so
 * there is no regression risk either way.
 *
 * That fixed the background (confirmed on the real Gmail Android app —
 * hero/card/panel all render dark), but surfaced one more thing: two text
 * colors were still going invisible — `#ffffff` and `#e5e5e5`, both near
 * white — while the mid-tones already in use (`#a3a3a3`, `#737373`, the
 * `#73bcf5` accent) rendered exactly right, confirmed in that same
 * screenshot. Gmail's app can't read an image background as "dark", so for
 * text it independently plays it safe: very light colors get defensively
 * darkened against a possibly-light canvas it can't rule out, while
 * mid-tones are left alone because they read fine against either extreme.
 * So every text color here now sits at or below `#a3a3a3` — nothing calls
 * for near-white — and lost emphasis (the role/venue callouts, the
 * heading) is recovered with weight (`<b>`, `font-weight`) instead of a
 * brighter color, since color brightness is exactly the lever Gmail's app
 * still overrides.
 */
function renderInviteHtml(input: InviteEmailInput & { firstName: string }): string {
  const { firstName, to, password, roleLabel, venueName, invitedBy } = input
  const esc = escapeHtml
  const bg = `${env.publicApiUrl}/branding`
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>You're invited to Zone Maestro</title>
</head>
<body width="100%" style="margin:0;padding:0;width:100%;background-image:url('${bg}/bg-page.png');background-repeat:repeat;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-image:url('${bg}/bg-page.png');background-repeat:repeat;">
    <tr>
      <td align="center" valign="top" style="padding:32px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;width:100%;background-image:url('${bg}/bg-card.png');background-repeat:repeat;">
          <tr>
            <td style="line-height:0;font-size:0;">
              <img src="${bg}/bg-accent.png" width="100%" height="3" alt="" style="display:block;border:0;width:100%;height:3px;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:36px 40px 28px 40px;background-image:url('${bg}/bg-hero.png');background-repeat:repeat;">
              <img src="https://zonemaestro.com/images/logo-mark.png" width="88" height="88" alt="Zone Maestro" style="display:block;border:0;width:88px;height:88px;margin:0 auto 16px auto;" />
              <img src="https://zonemaestro.com/images/logo-wordmark.png" width="220" height="40" alt="ZoneMaestro" style="display:block;border:0;width:220px;height:40px;margin:0 auto;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 40px 40px;background-image:url('${bg}/bg-card.png');background-repeat:repeat;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td align="center" style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;padding:0 0 10px 0;"><font color="#73bcf5">You're invited</font></td>
                </tr>
                <tr>
                  <td align="center" style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:28px;font-weight:400;padding:0 0 14px 0;"><font color="#a3a3a3">Welcome aboard, ${esc(firstName)}.</font></td>
                </tr>
                <tr>
                  <td align="center" style="font-family:Inter,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;padding:0 0 28px 0;">
                    <font color="#a3a3a3">${esc(invitedBy)} added you as <b><font color="#a3a3a3">${esc(roleLabel)}</font></b> at <b><font color="#a3a3a3">${esc(venueName)}</font></b>.</font>
                  </td>
                </tr>
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-image:url('${bg}/bg-panel.png');background-repeat:repeat;border-radius:12px;">
                      <tr>
                        <td style="padding:8px 24px 18px 24px;">
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                            <tr>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:12px;"><font color="#737373">Email</font></td>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;text-align:right;"><font color="#a3a3a3">${esc(to)}</font></td>
                            </tr>
                            <tr>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:12px;"><font color="#737373">Password</font></td>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;text-align:right;font-weight:600;"><font color="#73bcf5">${esc(password)}</font></td>
                            </tr>
                            <tr>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:12px;"><font color="#737373">Role</font></td>
                              <td style="padding:12px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;text-align:right;"><font color="#a3a3a3">${esc(roleLabel)}</font></td>
                            </tr>
                            <tr>
                              <td style="padding:12px 0 4px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:12px;"><font color="#737373">Property</font></td>
                              <td style="padding:12px 0 4px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;text-align:right;"><font color="#a3a3a3">${esc(venueName)}</font></td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function renderInviteText(input: InviteEmailInput & { firstName: string }): string {
  const { firstName, to, password, roleLabel, venueName, invitedBy } = input
  return [
    "You're invited to Zone Maestro",
    "",
    `Welcome aboard, ${firstName}.`,
    `${invitedBy} added you as ${roleLabel} at ${venueName}.`,
    "",
    `Email: ${to}`,
    `Password: ${password}`,
    `Role: ${roleLabel}`,
    `Property: ${venueName}`,
    "",
  ].join("\n")
}

/**
 * Sends the "you've been added" mail a new user gets when a Super Admin
 * creates their account with a known password (see routes/users.ts —
 * that's the only invite path where a real credential exists to send).
 *
 * Never throws: returns whether the mail actually went out so the caller
 * can log it, but a failure here must not fail user creation.
 */
export async function sendNewUserInviteEmail(input: InviteEmailInput): Promise<boolean> {
  const firstName = input.name.trim().split(/\s+/)[0] || input.name.trim()
  return sendMail({
    to: input.to,
    subject: `${firstName}, you're invited to Zone Maestro`,
    html: renderInviteHtml({ ...input, firstName }),
    text: renderInviteText({ ...input, firstName }),
  })
}
