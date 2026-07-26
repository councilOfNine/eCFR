/**
 * R2 over the S3 API, with SigV4 signed by hand.
 *
 * The pipeline is a Node process, not a Worker, so it has no R2 binding. The S3 API is the
 * supported alternative. Signing is ~80 lines of `node:crypto` and is written out here rather
 * than pulled from `@aws-sdk/client-s3`, which would add roughly 15 MB of dependency to a job
 * whose entire interaction with S3 is PUT and HEAD.
 *
 * Region is always `auto` for R2 and the endpoint is account-scoped.
 */

import { createHash, createHmac } from 'node:crypto';

import type { R2Config } from './config.js';
import type { Logger } from './log.js';

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, and S3's canonical
 * request requires them escaped — a key containing an apostrophe would otherwise produce a
 * signature mismatch that reads like a credentials problem.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Object keys are path-like; each segment is encoded, the separators are not. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function sign(
  config: R2Config,
  method: string,
  key: string,
  body: Buffer,
  extraHeaders: Record<string, string>,
): SignedRequest {
  const url = new URL(`${config.endpoint}/${config.bucket}/${encodeKey(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  // Lowercase every name up front. The canonical request and the Authorization header must
  // agree exactly on both the names and their order, so there is only one map.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders)) headers[name.toLowerCase()] = value;
  headers.host = url.host;
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((h) => `${h}:${(headers[h] ?? '').trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    '', // no query string on PUT/HEAD of an object
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
    '\n',
  );

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), REGION), SERVICE),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers.authorization = `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: url.toString(), headers };
}

export interface ObjectSink {
  put(key: string, body: Buffer | string, contentType: string): Promise<number>;
  readonly writes: number;
  readonly bytes: number;
}

export class R2Client implements ObjectSink {
  #config: R2Config;
  #log: Logger;
  writes = 0;
  bytes = 0;

  constructor(config: R2Config, log: Logger) {
    this.#config = config;
    this.#log = log.child('r2');
  }

  /** Returns the byte length written, so callers can record a measured size. */
  async put(key: string, body: Buffer | string, contentType: string): Promise<number> {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const { url, headers } = sign(this.#config, 'PUT', key, payload, {
      'content-type': contentType,
      'content-length': String(payload.byteLength),
    });

    // Three attempts. R2 PUTs fail transiently under load and the alternative to retrying is
    // failing a five-minute corpus render on one 500.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { method: 'PUT', headers, body: payload });
        if (response.ok) {
          this.writes += 1;
          this.bytes += payload.byteLength;
          return payload.byteLength;
        }
        lastError = new Error(`R2 PUT ${key} -> HTTP ${response.status} ${await response.text()}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    this.#log.error('R2 PUT failed after 3 attempts', { key });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * Stand-in used when R2 credentials are absent.
 *
 * A contributor running the pipeline locally still needs the render stage to plan, split and
 * budget-check exactly as it would in CI — those are the parts that can fail the build. What
 * they do not need is a bucket. Sizes are still measured, so the manifest is real.
 */
export class NullObjectSink implements ObjectSink {
  writes = 0;
  bytes = 0;

  put(_key: string, body: Buffer | string, _contentType: string): Promise<number> {
    const length = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body, 'utf8');
    this.writes += 1;
    this.bytes += length;
    return Promise.resolve(length);
  }
}
