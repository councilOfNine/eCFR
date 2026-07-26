/**
 * Regenerate `src/data/generated/api-endpoints.json` from apps/api's route definitions.
 *
 * WHY THIS EXISTS
 *
 * /api used to carry a hand-typed endpoint table. It advertised `GET /v1/structure/{title}`,
 * which has never existed (the route is `GET /v1/titles/{n}/structure`), it advertised
 * `GET /v1/shared-jurisdiction` for what is actually `GET /v1/overlap`, and it omitted four
 * endpoints that do exist. A docs page that lists endpoints a reader cannot call is worse than
 * no list at all on a project whose entire premise is that its published figures are checkable.
 *
 * WHY THE TYPESCRIPT AST AND NOT AN IMPORT
 *
 * The obvious approach — import apps/api's Hono app and call `getOpenAPI31Document()` — would
 * make the site's build depend on the API Worker's module graph resolving and evaluating in
 * Node. That is a runtime dependency between two separately deployed applications, and it would
 * mean an unrelated edit in apps/api could fail the site build at import time. Instead this
 * reads the route files as source and pulls the object literals out of the `createRoute({...})`
 * calls. `method`, `path`, `summary` and `tags` are plain string literals in every route in
 * apps/api; nothing here evaluates a single line of that code.
 *
 * The `typescript` package is already a devDependency of apps/web (astro check uses it), so
 * this adds no install.
 *
 * FAILURE BEHAVIOUR
 *
 * Loud, not silent. If apps/api's routes cannot be found or a route is missing `method`/`path`,
 * this exits non-zero and the build stops. The one tolerated case is apps/api being absent
 * entirely (a sparse checkout), where the committed JSON is left in place with a warning —
 * because failing a site build over a directory that was never checked out helps nobody.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, '../../api/src/routes');
const OUT_FILE = join(HERE, '../src/data/generated/api-endpoints.json');

/** Everything in apps/api/src/routes is mounted under this prefix by apps/api/src/index.ts. */
const MOUNT_PREFIX = '/v1';

/** One row of the /api endpoint table. The shape /api's frontmatter re-declares and renders. */
interface ApiEndpoint {
  method: string;
  path: string;
  summary: string;
  /** First OpenAPI tag, used as the table's section heading. */
  group: string;
}

/** The whole generated file, comment field included so the JSON explains itself. */
interface EndpointManifest {
  _comment: string;
  source_sha256: string;
  endpoints: ApiEndpoint[];
}

if (!existsSync(ROUTES_DIR)) {
  console.warn(
    `gen-api-endpoints: ${ROUTES_DIR} not found; leaving the committed endpoint list untouched.`,
  );
  process.exit(0);
}

/** The `name: ...` property assignment on an object literal, if any. */
function findProp(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  for (const prop of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === name
    ) {
      return prop;
    }
  }
  return undefined;
}

/**
 * Read one string-literal property off an object literal. Returns null when the property is
 * absent; throws when it is present but is not a plain literal, because a computed value here
 * means this extractor has silently stopped seeing the truth.
 */
function stringProp(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  where: string,
): string | null {
  const prop = findProp(objectLiteral, name);
  if (prop === undefined) return null;
  if (
    !ts.isStringLiteral(prop.initializer) &&
    !ts.isNoSubstitutionTemplateLiteral(prop.initializer)
  ) {
    throw new Error(
      `${where}: \`${name}\` is not a plain string literal. This extractor only reads literals; ` +
        'either simplify the route definition or teach scripts/gen-api-endpoints.ts to read it.',
    );
  }
  return prop.initializer.text;
}

function boolProp(objectLiteral: ts.ObjectLiteralExpression, name: string): boolean {
  const prop = findProp(objectLiteral, name);
  if (prop === undefined) return false;
  return prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function firstStringInArrayProp(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): string | null {
  const prop = findProp(objectLiteral, name);
  if (prop === undefined || !ts.isArrayLiteralExpression(prop.initializer)) return null;
  const first = prop.initializer.elements[0];
  return first !== undefined && ts.isStringLiteral(first) ? first.text : null;
}

const files = (await readdir(ROUTES_DIR)).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
);
files.sort();

const endpoints: ApiEndpoint[] = [];
/** Hashed so a change in apps/api that this extractor did not notice is still visible in a diff. */
const sourceHash = createHash('sha256');

for (const file of files) {
  const full = join(ROUTES_DIR, file);
  const source = await readFile(full, 'utf8');
  sourceHash.update(`${file}\n${source}`);

  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createRoute' &&
      node.arguments.length === 1
    ) {
      const literal = node.arguments[0];
      if (literal !== undefined && ts.isObjectLiteralExpression(literal)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const where = `apps/api/src/routes/${file}:${line}`;

        // `hide: true` keeps a route out of the OpenAPI document. It must stay out of the public
        // endpoint table too — /account/tier is an operator-only escalation path.
        if (boolProp(literal, 'hide')) return;

        const method = stringProp(literal, 'method', where);
        const path = stringProp(literal, 'path', where);
        if (method === null || path === null) {
          throw new Error(`${where}: createRoute() with no literal \`method\`/\`path\`.`);
        }

        endpoints.push({
          method: method.toUpperCase(),
          path: `${MOUNT_PREFIX}${path}`,
          summary: stringProp(literal, 'summary', where) ?? '',
          group: firstStringInArrayProp(literal, 'tags') ?? 'Other',
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

if (endpoints.length === 0) {
  throw new Error(
    `gen-api-endpoints: found no createRoute() calls under ${ROUTES_DIR}. apps/api has changed ` +
      'shape and this extractor no longer sees its routes — fix it rather than shipping an ' +
      'empty endpoint table.',
  );
}

for (const endpoint of endpoints) {
  if (endpoint.summary === '') {
    throw new Error(`gen-api-endpoints: ${endpoint.method} ${endpoint.path} has no summary.`);
  }
}

// Stable order: by group, then path, then method, so the JSON diff shows real changes only.
endpoints.sort(
  (a, b) =>
    a.group.localeCompare(b.group) ||
    a.path.localeCompare(b.path) ||
    a.method.localeCompare(b.method),
);

const payload: EndpointManifest = {
  _comment:
    'GENERATED by apps/web/scripts/gen-api-endpoints.ts from apps/api/src/routes/*.ts. Do not ' +
    'edit by hand — `pnpm --filter @ecfr-atlas/web build` regenerates it.',
  source_sha256: sourceHash.digest('hex'),
  endpoints,
};

await mkdir(dirname(OUT_FILE), { recursive: true });
const next = `${JSON.stringify(payload, null, 2)}\n`;
const previous = existsSync(OUT_FILE) ? await readFile(OUT_FILE, 'utf8') : null;
if (previous !== next) {
  await writeFile(OUT_FILE, next, 'utf8');
  console.log(`gen-api-endpoints: wrote ${endpoints.length} endpoints (changed).`);
} else {
  console.log(`gen-api-endpoints: ${endpoints.length} endpoints, unchanged.`);
}
