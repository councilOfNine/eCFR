/**
 * Route-definition helpers.
 *
 * Every documented route declares the same error responses. Spelling them out per route would
 * be forty copies of the same block and, in practice, forty chances for one of them to drift.
 */

import type { z } from '@hono/zod-openapi';
import { TIERS } from '../constants/config.js';
import type { ApiTier } from '../enums.js';
import { ErrorOut } from '../schemas.js';

export function jsonBody(schema: z.ZodType, description: string) {
  return { content: { 'application/json': { schema } }, description };
}

const errorResponse = (description: string) => jsonBody(ErrorOut, description);

/**
 * The errors any authenticated route can produce.
 *
 * 429 is documented on every route because it is the one a client will actually hit, and a
 * client that has not read about it will retry immediately and hit it again.
 */
export const commonErrors = {
  400: errorResponse('Malformed request. `error.details.issues` names the offending fields.'),
  401: errorResponse('Missing, malformed, revoked, or unverified API key.'),
  429: errorResponse(
    'Burst limit or daily quota exceeded. `error.details.limiter` says which, and `RateLimit-*` headers say where you stand.',
  ),
  500: errorResponse('Unexpected failure. Quote `error.request_id` if you report it.'),
} as const;

export const withNotFound = {
  ...commonErrors,
  404: errorResponse('No such resource.'),
} as const;

/**
 * Clamp a requested page size to the caller's tier.
 *
 * Clamping rather than rejecting: a caller who asks for 500 rows on the anonymous tier wants
 * data, and a 400 teaches them nothing a smaller page would not. The actual size comes back
 * in `page.limit`, so the response is self-describing.
 */
export function clampLimit(requested: number, tier: ApiTier): number {
  return Math.min(requested, TIERS[tier].maxPageSize);
}

/** `has_more` is not modelled in core's `Page`; derive it where a caller needs it. */
export function pageMeta(limit: number, offset: number, total: number) {
  return { limit, offset, total };
}
