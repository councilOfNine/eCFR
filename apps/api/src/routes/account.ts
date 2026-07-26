/**
 * Registration and key management.
 *
 * Design points worth stating because they are all deliberate:
 *
 *   - Registration ALWAYS returns the same body, whether the address is new, already pending,
 *     or already active. Otherwise the endpoint is an account-enumeration oracle: anyone could
 *     ask "does alice@agency.gov have an API key here?" and get an answer.
 *
 *   - There is no password and no session. A key IS the credential for managing keys. An
 *     account that has lost every key recovers by registering the same address again, which
 *     re-arms verification. That is a smaller attack surface than a password reset flow, and
 *     the recovery path is documented on the route rather than being folklore.
 *
 *   - The plaintext secret exists in one response and nowhere else. It is not logged, not
 *     stored, and there is no endpoint that can show it a second time.
 */

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { generateKey, generateVerifyToken, sha256Hex, timingSafeEqual } from '../auth/keys.js';
import { MAX_KEYS_PER_ACCOUNT, VERIFY_TOKEN_TTL_SECONDS, verifyUrl } from '../constants/config.js';
import {
  ACCOUNT_NOT_ACTIVE_MESSAGE,
  ACCOUNT_ROUTE_NEEDS_KEY_MESSAGE,
  ADMIN_ROUTE_NOT_FOUND_MESSAGE,
  EXPIRED_VERIFY_TOKEN_MESSAGE,
  FIRST_KEY_LABEL,
  INVALID_VERIFY_TOKEN_MESSAGE,
  KEY_SHOWN_ONCE_WARNING,
  keyLimitReachedMessage,
  NO_ACCOUNT_FOR_ADDRESS_MESSAGE,
  NO_ACTIVE_KEY_MESSAGE,
  registrationAcceptedMessage,
  SUSPENDED_CANNOT_ACTIVATE_MESSAGE,
} from '../constants/messages.js';
import {
  consumeVerifyToken,
  countActiveKeys,
  getAccountByEmail,
  getAccountById,
  insertKey,
  type KeyRow,
  listKeys,
  revokeKey,
  setAccountTier,
  upsertPendingAccount,
} from '../db/accounts.js';
import {
  AccountStatus,
  ErrorCode,
  isConfidentialEnvironment,
  KeyTier,
  PrincipalKind,
} from '../enums.js';
import type { AppEnv } from '../env.js';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.js';
import type { Mailer } from '../mailer.js';
import {
  type ApiKeyOut,
  ApiKeyWithSecretOut,
  CreateKeyBody,
  GrantTierBody,
  GrantTierOut,
  KeyIdParam,
  KeyListOut,
  RegisterBody,
  RegisterOut,
  RevokeOut,
  VerifyBody,
} from '../schemas.js';
import { commonErrors, withNotFound } from './shared.js';

const registerRoute = createRoute({
  method: 'post',
  path: '/account/register',
  tags: ['Account'],
  summary: 'Request an API key',
  description:
    'Sends a verification token to the address you give. POST it back to /v1/account/verify to ' +
    'activate the account and receive your first key. Registering an address that already has ' +
    'an account simply re-sends a token — that is also how you recover if you lose every key. ' +
    'The response is identical either way, on purpose.',
  request: { body: { content: { 'application/json': { schema: RegisterBody } } } },
  responses: {
    202: {
      content: { 'application/json': { schema: RegisterOut } },
      description: 'Accepted. A token has been sent if the address can receive one.',
    },
    ...commonErrors,
  },
});

const verifyRoute = createRoute({
  method: 'post',
  path: '/account/verify',
  tags: ['Account'],
  summary: 'Verify an email and receive the first key',
  description:
    'Single-use: the token is cleared as it is consumed. The `secret` in the response is the ' +
    'only time the full key is ever transmitted.',
  request: { body: { content: { 'application/json': { schema: VerifyBody } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: ApiKeyWithSecretOut } },
      description: 'Account activated and a key issued.',
    },
    ...commonErrors,
  },
});

const listKeysRoute = createRoute({
  method: 'get',
  path: '/account/keys',
  tags: ['Account'],
  summary: 'List your keys',
  description:
    'Suffixes only. The secrets are not stored, so they cannot be shown again by any means.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { content: { 'application/json': { schema: KeyListOut } }, description: 'Your keys.' },
    ...commonErrors,
  },
});

const createKeyRoute = createRoute({
  method: 'post',
  path: '/account/keys',
  tags: ['Account'],
  summary: 'Mint another key',
  description: `Up to ${MAX_KEYS_PER_ACCOUNT} active keys per account. New keys inherit the tier of the key you authenticated with.`,
  security: [{ ApiKeyAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateKeyBody } } } },
  responses: {
    201: {
      content: { 'application/json': { schema: ApiKeyWithSecretOut } },
      description: 'Key created. This is the only response that contains the secret.',
    },
    ...commonErrors,
  },
});

const revokeKeyRoute = createRoute({
  method: 'delete',
  path: '/account/keys/{id}',
  tags: ['Account'],
  summary: 'Revoke a key',
  description:
    'Takes effect on the next request. The key row is kept, not deleted, so its usage history ' +
    'survives — which is exactly what you want to look at after revoking a key in a hurry.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: KeyIdParam },
  responses: {
    200: { content: { 'application/json': { schema: RevokeOut } }, description: 'Revoked.' },
    ...withNotFound,
  },
});

/**
 * Operator-only tier grant.
 *
 * `hide: true` keeps it out of the public reference — not as a security measure (the secret is
 * the security measure) but because an admin endpoint in a public API reference is noise for
 * every reader who cannot use it. When `ADMIN_TOKEN` is unset the route answers 404, so an
 * unconfigured deployment has no privileged surface at all rather than one guarded by an
 * empty-string comparison.
 */
const grantTierRoute = createRoute({
  method: 'post',
  path: '/account/tier',
  hide: true,
  tags: ['Account'],
  summary: 'Operator: move an account to another tier',
  request: { body: { content: { 'application/json': { schema: GrantTierBody } } } },
  responses: {
    200: { content: { 'application/json': { schema: GrantTierOut } }, description: 'Applied.' },
    ...withNotFound,
  },
});

export function registerAccountRoutes(app: OpenAPIHono<AppEnv>, mailer: Mailer): void {
  app.openapi(grantTierRoute, async (c) => {
    const configured = c.env.ADMIN_TOKEN;
    const presented = c.req.header('x-admin-token') ?? '';

    // Hash both sides before comparing so the comparison is over fixed-length strings, and an
    // unconfigured deployment cannot be unlocked by sending an empty header.
    if (!configured || !timingSafeEqual(await sha256Hex(presented), await sha256Hex(configured))) {
      throw notFound(ADMIN_ROUTE_NOT_FOUND_MESSAGE);
    }

    const { email, tier } = c.req.valid('json');
    const account = await getAccountByEmail(c.env.DB, email.trim().toLowerCase());
    if (!account) throw notFound(NO_ACCOUNT_FOR_ADDRESS_MESSAGE);

    const updated = await setAccountTier(c.env.DB, account.id, tier);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'tier_granted',
        account_id: account.id,
        tier,
        keys_updated: updated,
      }),
    );

    return c.json({ account_id: account.id, tier, keys_updated: updated }, 200);
  });

  app.openapi(registerRoute, async (c) => {
    const body = c.req.valid('json');
    const email = body.email.trim().toLowerCase();
    const now = new Date();
    const token = await generateVerifyToken();
    const expiresAt = new Date(now.getTime() + VERIFY_TOKEN_TTL_SECONDS * 1000);

    await upsertPendingAccount(c.env.DB, {
      id: crypto.randomUUID(),
      email,
      organization: body.organization ?? null,
      intendedUse: body.intended_use ?? null,
      verifyTokenHash: token.hash,
      now: now.toISOString(),
    });

    await mailer.sendVerification({
      to: email,
      token: token.plaintext,
      verifyUrl: verifyUrl(c.env.SITE_ORIGIN, token.plaintext),
      expiresAt: expiresAt.toISOString(),
    });

    const isProduction = isConfidentialEnvironment(c.env.ENVIRONMENT);

    return c.json(
      {
        status: 'verification_sent' as const,
        message: registrationAcceptedMessage(email, Math.round(VERIFY_TOKEN_TTL_SECONDS / 3600)),
        // Returned in local development only, so the flow is testable without a mail server.
        // Gated on the deployed environment rather than on a debug flag, because a debug flag
        // is a thing somebody eventually turns on in production.
        dev_token: isProduction ? null : token.plaintext,
      },
      202,
    );
  });

  app.openapi(verifyRoute, async (c) => {
    const { token } = c.req.valid('json');
    const now = new Date();
    const account = await consumeVerifyToken(c.env.DB, await sha256Hex(token), now.toISOString());

    if (!account) {
      throw badRequest(INVALID_VERIFY_TOKEN_MESSAGE);
    }
    if (account.status !== AccountStatus.Active) {
      throw new ApiError({
        status: 403,
        code: ErrorCode.Forbidden,
        message: SUSPENDED_CANNOT_ACTIVATE_MESSAGE,
      });
    }

    // Age check happens after consumption: an expired token is still single-use, so a leaked
    // old token cannot be replayed once someone has tried it.
    if (account.verify_sent_at) {
      const age = now.getTime() - new Date(account.verify_sent_at).getTime();
      if (age > VERIFY_TOKEN_TTL_SECONDS * 1000) {
        throw badRequest(EXPIRED_VERIFY_TOKEN_MESSAGE, { sent_at: account.verify_sent_at });
      }
    }

    const key = await generateKey();
    await insertKey(c.env.DB, {
      id: key.id,
      accountId: account.id,
      hash: key.hash,
      suffix: key.suffix,
      label: FIRST_KEY_LABEL,
      tier: KeyTier.Registered,
      createdAt: now.toISOString(),
    });

    return c.json(
      {
        id: key.id,
        label: FIRST_KEY_LABEL,
        tier: KeyTier.Registered,
        suffix: key.suffix,
        created_at: now.toISOString(),
        last_used_at: null,
        revoked_at: null,
        secret: key.plaintext,
        warning: KEY_SHOWN_ONCE_WARNING,
      },
      200,
    );
  });

  app.openapi(listKeysRoute, async (c) => {
    const principal = requireKeyPrincipal(c.get('principal'));
    const rows = await listKeys(c.env.DB, principal.accountId);
    return c.json({ data: rows.map(toKeyOut) }, 200);
  });

  app.openapi(createKeyRoute, async (c) => {
    const principal = requireKeyPrincipal(c.get('principal'));
    const { label } = c.req.valid('json');

    const account = await getAccountById(c.env.DB, principal.accountId);
    if (account?.status !== AccountStatus.Active) {
      throw unauthorized(ACCOUNT_NOT_ACTIVE_MESSAGE);
    }

    const active = await countActiveKeys(c.env.DB, principal.accountId);
    if (active >= MAX_KEYS_PER_ACCOUNT) {
      throw new ApiError({
        status: 403,
        code: ErrorCode.Forbidden,
        message: keyLimitReachedMessage(active, MAX_KEYS_PER_ACCOUNT),
        details: { active, max: MAX_KEYS_PER_ACCOUNT },
      });
    }

    const now = new Date().toISOString();
    const key = await generateKey();
    await insertKey(c.env.DB, {
      id: key.id,
      accountId: principal.accountId,
      hash: key.hash,
      suffix: key.suffix,
      label: label ?? null,
      // Inherit rather than default: an elevated account minting a key should not silently
      // get a registered-tier one and spend an afternoon wondering why the quota is low.
      tier: principal.tier,
      createdAt: now,
    });

    return c.json(
      {
        id: key.id,
        label: label ?? null,
        tier: principal.tier,
        suffix: key.suffix,
        created_at: now,
        last_used_at: null,
        revoked_at: null,
        secret: key.plaintext,
        warning: KEY_SHOWN_ONCE_WARNING,
      },
      201,
    );
  });

  app.openapi(revokeKeyRoute, async (c) => {
    const principal = requireKeyPrincipal(c.get('principal'));
    const { id } = c.req.valid('param');

    const revoked = await revokeKey(c.env.DB, principal.accountId, id, new Date().toISOString());
    if (!revoked) {
      // Same response whether the key belongs to someone else or does not exist: telling the
      // difference would let a caller probe for other accounts' key ids.
      throw notFound(NO_ACTIVE_KEY_MESSAGE, { id });
    }

    return c.json({ status: 'revoked' as const, id }, 200);
  });
}

function toKeyOut(row: KeyRow) {
  return {
    id: row.id,
    label: row.label,
    tier: row.tier,
    suffix: row.key_suffix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  } satisfies Record<keyof (typeof ApiKeyOut)['shape'], unknown>;
}

/**
 * Narrow the principal for the key-management routes.
 *
 * `requireKey` middleware has already rejected anonymous callers, so this is a type narrowing
 * rather than a check — but it throws rather than asserting, because a middleware ordering
 * mistake should produce a 401, not a runtime property access on undefined.
 */
function requireKeyPrincipal(principal: AppEnv['Variables']['principal']) {
  if (principal.kind !== PrincipalKind.Key) {
    throw unauthorized(ACCOUNT_ROUTE_NEEDS_KEY_MESSAGE);
  }
  return principal;
}
