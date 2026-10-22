import { getDevelopmentDatabaseDescription } from "@/lib/dev-mode/database-target";
import { getDevelopmentDiagnosticsForMode } from "@/lib/dev-mode/env-diagnostics";

/**
 * Development-only banner naming the database in use.
 *
 * It renders nothing outside development, and it only ever shows variable
 * *names* — never a value, a key or a connection string. A missing required
 * value is named here so a page that could not fetch something has an obvious
 * place to look.
 */
export function DevDatabaseBanner() {
  const database = getDevelopmentDatabaseDescription();
  const diagnostics = getDevelopmentDiagnosticsForMode();
  if (!database || !diagnostics) return null;

  const missing = diagnostics.missingRequired;

  return (
    <aside className="dev-banner" aria-label="Development database and configuration">
      <div className="dev-banner__row">
        <span className="dev-banner__tag">DEVELOPMENT</span>
        <span className="dev-banner__item">
          <strong>DATABASE</strong>
          {database.kind === "local-sqlite-file"
            ? `local SQLite file · ${database.label}`
            : database.kind === "remote"
              ? `NOT LOCAL · ${database.label}`
              : database.label}
          {database.source === "development-default" && " · from the development default"}
          {database.source === "none" && database.kind !== "unconfigured" && " · from no variable"}
        </span>
        <span className="dev-banner__item">
          <strong>PAPER STORE</strong>process-local
        </span>
      </div>

      {missing.length > 0 && (
        <p className="dev-banner__warning" role="status">
          Missing required development variables: {missing.join(", ")}
        </p>
      )}

      <details className="dev-banner__details">
        <summary>
          Configuration names ({diagnostics.variables.filter((item) => item.present).length}/
          {diagnostics.variables.length} set) — values are never shown
        </summary>
        <ul className="dev-banner__list">
          {diagnostics.variables.map((variable) => (
            <li key={variable.name}>
              <code>{variable.name}</code>
              <span className={variable.present ? "is-set" : "is-missing"}>
                {variable.present ? "set" : "missing"}
              </span>
              <span className="dev-banner__purpose">{variable.purpose}</span>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
