import {
  Activity,
  Bot,
  Store,
  ArrowLeftRight,
  BarChart3,
  ChartNoAxesCombined,
  BriefcaseBusiness,
  Code2,
  Coins,
  Cpu,
  Database,
  LayoutDashboard,
  ListChecks,
  LifeBuoy,
  Receipt,
  ScanSearch,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { OnboardingProgress, SessionTopbarAction, TradingReadiness } from "@/components/session-readiness";

const navigation = [
  { label: "Overview", href: "/terminal", icon: LayoutDashboard, key: "overview" },
  { label: "Onboarding", href: "/onboarding", icon: ListChecks, key: "onboarding" },
  { label: "Markets", href: "/markets", icon: BarChart3, key: "markets" },
  { label: "Screener", href: "/screener", icon: ScanSearch, key: "screener" },
  { label: "Backtest", href: "/backtest", icon: ChartNoAxesCombined, key: "backtest" },
  { label: "Assistant", href: "/assistant", icon: Sparkles, key: "assistant" },
  { label: "Bot builder", href: "/bots", icon: Bot, key: "bots" },
  { label: "Marketplace", href: "/marketplace", icon: Store, key: "marketplace" },
  { label: "Trade", href: "/trade", icon: ArrowLeftRight, key: "trade" },
  { label: "Account", href: "/account", icon: Coins, key: "account" },
  { label: "Portfolio", href: "/terminal#portfolio", icon: Wallet, key: "portfolio" },
  { label: "Activity", href: "/terminal#activity", icon: Activity, key: "activity" },
  { label: "ChainGPT", href: "/chaingpt", icon: Sparkles, key: "chaingpt" },
  { label: "WunderTrading", href: "/wundertrading", icon: BriefcaseBusiness, key: "wundertrading" },
  { label: "Research", href: "/research", icon: Search, key: "research" },
  { label: "Pricing", href: "/pricing", icon: Receipt, key: "pricing" },
  { label: "API docs", href: "/docs/api", icon: Code2, key: "api" },
] as const;

const adminNavigation = [
  { label: "Console", href: "/admin", icon: LayoutDashboard, key: "console" },
  { label: "Support", href: "/admin/support", icon: LifeBuoy, key: "support" },
  { label: "Audit trail", href: "/admin/audit", icon: ScrollText, key: "audit" },
  { label: "Data admin", href: "/admin/data", icon: Database, key: "admin" },
  { label: "Risk controls", href: "/admin/risk", icon: ShieldCheck, key: "risk" },
  { label: "Fees", href: "/admin/fees", icon: Receipt, key: "fees" },
  { label: "AI models", href: "/admin/models", icon: Cpu, key: "models" },
  { label: "Access", href: "/admin/access", icon: UsersRound, key: "access" },
] as const;

type NavigationKey = (typeof navigation)[number]["key"] | (typeof adminNavigation)[number]["key"];
type AdminNavigationKey = (typeof adminNavigation)[number]["key"];

export function TerminalShell({
  active,
  section,
  children,
  adminView = false,
  adminSections,
}: {
  active: NavigationKey;
  section: string;
  children: ReactNode;
  adminView?: boolean;
  adminSections?: readonly AdminNavigationKey[];
}) {
  // The console is the admin home: every admin page links back to it, even the
  // older pages that predate it and list only their own section keys.
  const visibleAdminNavigation = adminSections
    ? adminNavigation.filter(({ key }) => key === "console" || adminSections.includes(key))
    : adminNavigation;
  const visibleNavigation = adminView ? [...navigation, ...visibleAdminNavigation] : navigation;

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="terminal-shell">
      <aside className="sidebar" aria-label="Application sidebar">
        <Link className="brand" href="/terminal" aria-label="Veylora overview">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">veylora</span>
          <span className="brand-edition">TERMINAL</span>
        </Link>

        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {visibleNavigation.map(({ label, href, icon: Icon, key }) => (
            <Link
              aria-current={active === key ? "page" : undefined}
              className={`primary-nav__link${active === key ? " is-active" : ""}`}
              href={href}
              key={key}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {active === key && <span className="nav-indicator" aria-hidden="true" />}
            </Link>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-label">SESSION</div>
          <OnboardingProgress />
          <TradingReadiness />
          <div className="sidebar-version">{adminView ? "PRIVATE DATA" : "PUBLIC DATA"}</div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>VEYLORA</span>
            <span className="breadcrumb-separator">/</span>
            <span>{section}</span>
          </div>
          <div className="topbar-status">
            <span className="state-dot state-dot--muted" aria-hidden="true" />
            <span>{adminView ? "INTERNAL ADMIN DATA" : "PUBLIC MARKET DATA"}</span>
            <SessionTopbarAction />
          </div>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
      </div>
    </>
  );
}