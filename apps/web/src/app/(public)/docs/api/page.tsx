import type { Metadata } from "next";
import { DepthText } from "@/components/depth-text";
import {
  API_DOCS_PATH,
  API_INTRODUCTION,
  API_PLACEHOLDER_KEY,
  API_RATE_LIMIT_DEFAULT,
  API_RATE_LIMIT_HEADERS,
  MCP_CLIENT_CONFIG,
  MCP_ONBOARDING,
  MCP_PACKAGE_SCRIPT,
  documentedRoutes,
  documentedScopes,
} from "@/lib/api/docs";
import { API_TOOLS } from "@/lib/api/tools";

/**
 * The public API reference (phase 32).
 *
 * Every route, scope, query field and body example below comes from the same registry the
 * `/api/v1` handler dispatches from. There is no hand-written endpoint list to keep in step.
 * The only credential shown is the placeholder `vyl_replace_me`; the page has no access to a
 * real key and nowhere to put one.
 */

export const metadata: Metadata = {
  title: "API and MCP — Veylora",
  description: "Scoped REST endpoints and an MCP server for the Veylora account.",
};

export default function ApiDocsPage() {
  const routes = documentedRoutes();
  const scopes = documentedScopes();

  return (
    <>
      <section className="page-heading" aria-labelledby="api-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            DEVELOPER <span className="eyebrow-separator">/</span> V1 API
          </div>
          <h1 id="api-title"><DepthText text="API & MCP" /></h1>
          <p>
            Scoped keys, a documented read surface and an MCP server over the same routes. Keys are
            issued in the owner&apos;s admin session; this page is public and carries placeholders only.
          </p>
        </div>
        <span className="section-state">BEARER / V1</span>
      </section>

      <section className="data-section" aria-labelledby="api-start-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">BASE URL</div>
            <h2 id="api-start-title">/api/v1</h2>
          </div>
          <span className="section-state">DOCS FROM THE ROUTES</span>
        </div>
        <div className="api-docs-intro">
          {API_INTRODUCTION.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
        <dl className="api-docs-facts">
          <div>
            <dt>Authentication</dt>
            <dd><code>Authorization: Bearer {API_PLACEHOLDER_KEY}</code></dd>
          </div>
          <div>
            <dt>Default allowance</dt>
            <dd>{API_RATE_LIMIT_DEFAULT} requests / minute / key</dd>
          </div>
          <div>
            <dt>Rate headers</dt>
            <dd><code>{API_RATE_LIMIT_HEADERS.join(" · ")}</code></dd>
          </div>
          <div>
            <dt>Key issuing</dt>
            <dd>Signed-in owner at <a href="/admin/access">/admin/access</a>; the key is shown once.</dd>
          </div>
        </dl>
      </section>

      <section className="data-section" aria-labelledby="api-scopes-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">AUTHORIZATION</div>
            <h2 id="api-scopes-title">Scopes</h2>
          </div>
          <span className="section-state">OPT-IN PER KEY</span>
        </div>
        <ul className="api-docs-scopes">
          {scopes.map(({ scope, detail }) => (
            <li key={scope}>
              <code>{scope}</code>
              <span>{detail}</span>
            </li>
          ))}
        </ul>
        <p className="policy-disclaimer">
          The trade scope is bound to one dedicated agent account. A request that names another account is
          refused with <code>AGENT_ACCOUNT_SCOPE</code> and written to the audit trail. No key reaches the
          owner&apos;s main account by default.
        </p>
      </section>

      <section className="data-section" aria-labelledby="api-routes-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">REFERENCE</div>
            <h2 id="api-routes-title">Routes</h2>
          </div>
          <span className="section-state">{routes.length} ROUTES</span>
        </div>
        <div className="api-docs-routes">
          {routes.map((route) => (
            <article className="api-docs-route" key={`${route.method} ${route.fullPath}`}>
              <header>
                <span className={`api-docs-method api-docs-method--${route.method.toLowerCase()}`}>{route.method}</span>
                <code className="api-docs-path">{route.fullPath}</code>
                <span className="api-docs-scope">{route.scope}</span>
              </header>
              <h3>{route.summary}</h3>
              <p>{route.description}</p>

              {route.query.length > 0 && (
                <div className="api-docs-fields">
                  <h4>Query</h4>
                  <dl>
                    {route.query.map((field) => (
                      <div key={field.name}>
                        <dt><code>{field.name}</code> <small>{field.type}</small></dt>
                        <dd>{field.description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {route.body && route.body.length > 0 && (
                <div className="api-docs-fields">
                  <h4>Body</h4>
                  <dl>
                    {route.body.map((field) => (
                      <div key={field.name}>
                        <dt>
                          <code>{field.name}</code> <small>{field.type}{field.required ? " · required" : ""}</small>
                        </dt>
                        <dd>{field.description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <pre className="api-docs-code" aria-label={`Example request for ${route.fullPath}`}>{route.curl}</pre>
            </article>
          ))}
        </div>
      </section>

      <section className="data-section" aria-labelledby="api-mcp-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">MCP / STDIO</div>
            <h2 id="api-mcp-title">Connect an agent</h2>
          </div>
          <span className="section-state">{API_TOOLS.length} TYPED TOOLS</span>
        </div>
        <p>
          The MCP server runs in the same workspace, speaks JSON-RPC over stdio and opens no port. Its tools
          call the REST handlers above, so scope checks, validation and refusals are the same code.
        </p>
        <ol className="api-docs-steps">
          {MCP_ONBOARDING.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <pre className="api-docs-code" aria-label="MCP client configuration">{MCP_CLIENT_CONFIG}</pre>
        <p className="policy-disclaimer">
          From <code>apps/web</code>, the server command is <code>{MCP_PACKAGE_SCRIPT}</code>. A key that is
          revoked, expired or missing a scope is refused on the next tool call; restarting the client is not
          required.
        </p>
        <div className="market-history-table-wrap">
          <table className="market-history-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Scope</th>
                <th scope="col">Route</th>
              </tr>
            </thead>
            <tbody>
              {API_TOOLS.map((tool) => (
                <tr key={tool.name}>
                  <td><code>{tool.name}</code></td>
                  <td>{tool.scope}</td>
                  <td><code>{tool.route.method} /api/v1{tool.route.path}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="policy-disclaimer">
        This page is generated from <code>{API_DOCS_PATH}</code>&apos;s route registry. Its examples contain no
        credential: every key is <code>{API_PLACEHOLDER_KEY}</code>.
      </p>
    </>
  );
}
