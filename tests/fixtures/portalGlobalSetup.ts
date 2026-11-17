/**
 * Portal suite global setup (Task 30). Only when `PORTAL_E2E=1`: builds this
 * branch's frontend once and serves it, with `vercel.json`'s rewrites, on a
 * FIXED origin — `http://127.0.0.1:${PORTAL_FRONTEND_PORT:-4173}` — because
 * the local backend's CORS allow-list has to name it exactly
 * (`CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173`, tests/README.md). Every
 * spec in the run (portal, axe, access-control) then uses that origin as
 * `BASE_URL` (playwright.config.ts). With `PORTAL_E2E` unset that part is a
 * no-op.
 *
 * In every run it first signs each TEST_* account in once (see
 * fixtures/sessionCache.ts). Under PORTAL_E2E the accounts are seeded by the
 * workflow before Playwright starts, so they exist by then.
 */
import path from 'node:path';
import { buildAndServeFrontend } from './buildAndServeFrontend';
import { archiveEarlierRuns, ensureInferredPlatePairs } from './portal';
import { signInTestAccountsOnce } from './accounts';

export default async function portalGlobalSetup() {
  // Every run, portal or not: sign each TEST_* account in once and cache the
  // session (fixtures/sessionCache.ts), so the suite stays under the
  // backend's /auth/login throttle. Accounts without env vars are skipped,
  // so the credential-free jobs are unaffected.
  await signInTestAccountsOnce();
  if (process.env.PORTAL_E2E !== '1') return undefined;
  // A long-lived local harness DB keeps every earlier run's signups under N
  // Style; partner A's dashboard loads per-property counts for each of them,
  // which slows (and times out) the partner-side specs run after run.
  archiveEarlierRuns();
  // The apartment register route reads a table the portal subset schema lacks; once, not per worker.
  ensureInferredPlatePairs();
  const port = Number(process.env.PORTAL_FRONTEND_PORT ?? 4173);
  const server = await buildAndServeFrontend(path.resolve(__dirname, '../../frontend'), { port });
  process.env.PORTAL_FRONTEND_ORIGIN = server.origin;
  return async () => { await server.close(); };
}
