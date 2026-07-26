/**
 * The email seam.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 *  NOT WIRED UP. Verification emails are NOT delivered. `LoggingMailer` writes the message to
 *  the Worker log and returns success, which is enough to develop and test the whole
 *  registration flow and is not enough to run it in production.
 *
 *  To finish: implement `Mailer` over Cloudflare Email Service (a `send_email` binding in
 *  wrangler.jsonc plus a verified sender domain with SPF/DKIM/DMARC), and swap the instance
 *  constructed in src/index.ts. Nothing else changes — the routes depend on this interface,
 *  not on a provider.
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The interface is narrow on purpose. This API sends exactly one kind of message, so a
 * general-purpose template/attachment/threading abstraction would be scaffolding for
 * requirements that do not exist.
 */

import {
  MAILER_NOT_CONFIGURED_MESSAGE,
  REDACTED_PLACEHOLDER,
  WITHHELD_PLACEHOLDER,
} from './constants/messages.js';
import { isConfidentialEnvironment } from './enums.js';

export interface VerificationEmail {
  to: string;
  /** The plaintext token. It exists in memory for the length of this call and nowhere else. */
  token: string;
  /** Absolute URL the recipient can click, if a web verification page is configured. */
  verifyUrl: string | null;
  expiresAt: string;
}

export interface Mailer {
  sendVerification(message: VerificationEmail): Promise<void>;
}

/**
 * Development/no-op implementation.
 *
 * Logs the token so a developer can complete verification locally. This is safe precisely
 * because it is loud: `MAILER_NOT_CONFIGURED` in a production log is a visible defect, whereas
 * a silently swallowed send is a registration flow that appears to work and never does.
 *
 * In any environment other than development the token itself is withheld from the log —
 * Worker logs are readable by anyone with dashboard access, and a verification token mints an
 * API key.
 */
export class LoggingMailer implements Mailer {
  constructor(private readonly environment: string) {}

  // Not `async`: this implementation only logs, so there is nothing to await. A real Mailer
  // will have an `await` in here; the Promise return type is the interface, not this body.
  sendVerification(message: VerificationEmail): Promise<void> {
    const isDev = !isConfidentialEnvironment(this.environment);
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'MAILER_NOT_CONFIGURED',
        message: MAILER_NOT_CONFIGURED_MESSAGE,
        to: redactEmail(message.to),
        expires_at: message.expiresAt,
        // Only in local development. See the class comment.
        token: isDev ? message.token : WITHHELD_PLACEHOLDER,
        verify_url: isDev ? message.verifyUrl : WITHHELD_PLACEHOLDER,
      }),
    );
    return Promise.resolve();
  }
}

/**
 * `a***@example.org`. Enough to recognise your own address in a log, not enough for the log
 * to become a mailing list.
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return REDACTED_PLACEHOLDER;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}
