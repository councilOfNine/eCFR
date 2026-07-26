# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Preferred: use GitHub's private vulnerability reporting — the **Security** tab on this
repository, then **Report a vulnerability**. It creates a private thread with the maintainers and
needs no coordination beforehand.

<!-- TODO(maintainer): add a real contact address (and optionally a PGP key fingerprint) before
     making this repository public. Do not leave a placeholder in a published SECURITY.md — a
     reporter who cannot find a private channel will eventually use a public one. -->

If private reporting is unavailable, email **[TODO: MAINTAINER CONTACT ADDRESS]**.

Please include: what you found, the steps to reproduce it, the impact you think it has, and any
proof-of-concept. If you would like credit in the fix, say so and how you would like to be named.

### What to expect

This is a small volunteer project, so response times are best-effort rather than contractual:

|                              | Target                                        |
| ---------------------------- | --------------------------------------------- |
| Acknowledgement              | within 3 business days                        |
| Initial assessment           | within 7 business days                        |
| Fix or documented mitigation | depends on severity; we will keep you updated |

We will tell you when a fix ships and credit you unless you prefer otherwise. We do not run a
bug bounty and cannot offer payment.

## Supported versions

Only the currently deployed site and the `master` branch are supported. There are no maintenance
branches and no backports.

## Scope

**In scope**

- The API Worker (`apps/api`): authentication, API key handling, quota enforcement, the `/diff`
  route.
- The site (`apps/web`).
- The sync pipeline and CI workflows (`scripts/`, `.github/workflows/`), including anything that
  could exfiltrate a Cloudflare token or poison the published data.
- The published data itself: if you can make this project publish a number it did not measure, or
  attribute regulation to the wrong agency, we treat that as a security issue. Integrity of the
  measurements is the product.
- Anything that leaks API-key material or a registered account's email address. Note that the
  nightly open-data export deliberately excludes `api_account`, `api_key` and `api_usage_day`; if
  you find any of that data in a public export, please report it immediately.

**Out of scope**

- Vulnerabilities in <https://www.ecfr.gov> or any other government system. Report those to the
  operators of those systems, not here.
- The accuracy of the underlying regulatory text. We reproduce what eCFR publishes; corrections
  to the law belong upstream. A _derived measurement_ being wrong is a data bug — use the "Data
  looks wrong" issue template, publicly, since it is not a security matter.
- Denial of service by simply exceeding the public rate limits. The limits are the mitigation.
  A way to _bypass_ them is in scope.
- Missing security headers or best-practice findings with no demonstrated impact, and output from
  automated scanners without a working proof-of-concept.
- Social engineering of maintainers, and physical attacks.

## Notes for researchers

- Please test against your own local deployment where you can — `pnpm db:reset && pnpm dev:web`
  gets you a full working instance from committed fixtures, with no network access required.
- Do not run automated scanners against ecfr.gov through this project. It is a public government
  service with a token-bucket rate limiter, and hammering it on our behalf harms a third party.
- Do not access, modify, or exfiltrate other users' data. If you encounter personal data during
  testing, stop and tell us.

We will not pursue legal action against anyone acting in good faith under this policy.
