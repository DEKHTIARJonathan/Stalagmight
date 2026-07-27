/**
 * Deep links into the SpeleoDB web app for the currently open remote project.
 *
 * The `/private/project/<id>/` route (and its `revisions/` + `permissions/user/`
 * sub-pages) is confirmed against the SpeleoDB server source, so the id is the
 * only variable part.
 */

/** Sub-pages we deep-link to; anything else uses the project root. */
export type SpeleoWebPage = 'revisions' | 'permissions/user';

/**
 * Build the web URL for a project, or `null` when we cannot form one we are
 * allowed to open.
 *
 * Two refusals, both deliberate:
 * - no project id: there is nothing to link to.
 * - an endpoint that is not http(s): the Tauri `opener:default` capability only
 *   permits those two schemes, so a link we build from anything else could only
 *   fail at click time. Returning null lets the caller disable the affordance
 *   instead of offering a dead button.
 *
 * Trailing slashes are stripped from the endpoint the same way the Rust client
 * does (`trim_end_matches('/')`), so a configured "https://host/" and
 * "https://host" produce the same URL.
 */
export function speleoProjectUrl(
  endpoint: string | null | undefined,
  projectId: string | null | undefined,
  page?: SpeleoWebPage,
): string | null {
  const id = (projectId ?? '').trim();
  if (id === '') return null;
  const base = (endpoint ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  const root = `${base}/private/project/${encodeURIComponent(id)}/`;
  return page ? `${root}${page}/` : root;
}
