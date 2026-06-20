/**
 * Plain HTML email templates (M7). Kept dependency-free (no React Email) so the
 * app builds offline. Each function returns a ready-to-send HTML string.
 */

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Smart CRM";

/** Minimal, email-client-safe HTML shell. */
function layout(title: string, inner: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
            <tr><td style="font-size:18px;font-weight:600;padding-bottom:16px;">${escapeHtml(title)}</td></tr>
            <tr><td style="font-size:14px;line-height:1.6;color:#334155;">${inner}</td></tr>
            <tr><td style="font-size:12px;color:#94a3b8;padding-top:24px;">— ${escapeHtml(APP_NAME)}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a>`;
}

/** Escape text for use in HTML body content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export function verifyEmail(opts: { url: string; name?: string | null }): { subject: string; html: string } {
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi there,";
  const html = layout(
    "Confirm your email",
    `<p>${greeting}</p>
     <p>Please confirm your email address to finish setting up your account.</p>
     <p style="padding:12px 0;">${button(opts.url, "Verify email")}</p>
     <p style="color:#94a3b8;">Or paste this link into your browser:<br/>${escapeHtml(opts.url)}</p>`,
  );
  return { subject: `Confirm your ${APP_NAME} email`, html };
}

export function passwordReset(opts: { url: string; name?: string | null }): { subject: string; html: string } {
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi there,";
  const html = layout(
    "Reset your password",
    `<p>${greeting}</p>
     <p>We received a request to reset your password. This link expires in 1 hour.</p>
     <p style="padding:12px 0;">${button(opts.url, "Reset password")}</p>
     <p style="color:#94a3b8;">If you didn't request this, you can safely ignore this email.<br/>${escapeHtml(opts.url)}</p>`,
  );
  return { subject: `Reset your ${APP_NAME} password`, html };
}

export function genericMessage(opts: { subject: string; body: string }): { subject: string; html: string } {
  // Preserve author line breaks; escape everything else.
  const paragraphs = opts.body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return { subject: opts.subject, html: layout(opts.subject, paragraphs) };
}
