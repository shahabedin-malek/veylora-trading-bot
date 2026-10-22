/**
 * What a page shows when the account is signed in but is missing a permission.
 *
 * Deliberately not `notFound()` and not a blank render. Those two are confusing
 * in the same way: a 404 says the page does not exist, and an empty page says the
 * deployment is broken — when what actually happened is that one permission is
 * not granted. So the shell, the heading and the navigation stay, the body names
 * the permission (the key an administrator types, and the sentence that explains
 * it), and it says where the grant is made. The full content renders again on the
 * next request after the grant, with no code change and no restart.
 */
export function PermissionNotice({
  capability,
  reason,
  permissionKey,
}: {
  /** The sentence this surface needs, worded as a capability. */
  capability: string;
  /** The refusal itself, built once in `access-control.ts` so every surface agrees. */
  reason: string;
  /** The exact permission key the account is missing, when the refusal names one. */
  permissionKey?: string;
}) {
  return (
    <section className="data-section" aria-labelledby="permission-notice-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">PERMISSION REQUIRED</div>
          <h2 id="permission-notice-title">{capability}</h2>
        </div>
        <span className="section-state">REFUSED</span>
      </div>
      <div className="market-chart-empty" role="status">
        <strong>{reason}</strong>
        {permissionKey && (
          <span>
            Missing permission key: <code>{permissionKey}</code>
          </span>
        )}
        <span>
          Nothing is hidden and nothing crashed. An administrator grants this in Access, and this page renders its
          full content again on the next request.
        </span>
      </div>
    </section>
  );
}
