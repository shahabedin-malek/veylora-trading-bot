import Link from "next/link";
import type { ReactNode } from "react";
import {
  CONSOLE_HREF,
  LEGAL_NAVIGATION,
  NOT_STATEMENTS,
  OPERATOR_CONTACT,
  OPERATOR_NAME,
  PUBLIC_NAVIGATION,
  SIGN_IN_HREF,
} from "@/lib/public/site";

/**
 * The chrome every public page shares.
 *
 * It is deliberately separate from `TerminalShell`: the console's sidebar names thirteen
 * surfaces that need a session, and a visitor looking for terms of use should not be shown a
 * navigation where two thirds of the links end at a sign-in page. Two shells, two audiences, one
 * visual language.
 *
 * The footer states what the product is not on every page, so the negative claims travel with
 * whatever page is being read rather than living once on a page nobody opens.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="public-header">
        <Link className="public-brand" href="/" aria-label={`${OPERATOR_NAME} home`}>
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="public-brand__name">{OPERATOR_NAME.toLowerCase()}</span>
        </Link>
        <nav className="public-nav" aria-label="Public pages">
          {PUBLIC_NAVIGATION.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="public-header__actions">
          <Link className="public-link-quiet" href={SIGN_IN_HREF}>
            Sign in
          </Link>
          <Link className="public-button" href={CONSOLE_HREF}>
            Open the console
          </Link>
        </div>
      </header>

      <main className="public-main" id="main-content">
        {children}
      </main>

      <footer className="public-footer">
        <div className="public-footer__top">
          <div>
            <p className="public-footer__operator">{OPERATOR_NAME}</p>
            <p className="public-footer__note">{NOT_STATEMENTS[0]}</p>
          </div>
          <nav className="public-footer__nav" aria-label="Legal and help">
            {LEGAL_NAVIGATION.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="public-footer__note">
          Every figure on the pricing and status pages is read from the code that produces it at the moment
          the page is requested. To reach a person, use {OPERATOR_CONTACT}.
        </p>
      </footer>
    </div>
  );
}
