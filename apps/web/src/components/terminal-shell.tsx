import {
  Activity,
  Bot,
  ArrowLeftRight,
  BarChart3,
  ChartNoAxesCombined,
  BriefcaseBusiness,
  Database,
  LayoutDashboard,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionTopbarAction, TradingReadiness } from "@/components/session-readiness";

const navigation = [
  { label: "Overview", href: "/", icon: LayoutDashboard, key: "overview" },
  { label: "Markets", href: "/markets", icon: BarChart3, key: "markets" },
  { label: "Screener", href: "/screener", icon: ScanSearch, key: "screener" },
  { label: "Backtest", href: "/backtest", icon: ChartNoAxesCombined, key: "backtest" },
  { label: "Assistant", href: "/assistant", icon: Sparkles, key: "assistant" },
  { label: "Bot builder", href: "/bots", icon: Bot, key: "bots" },
  { label: "Trade", href: "/trade", icon: ArrowLeftRight, key: "trade" },
  { label: "Portfolio", href: "/#portfolio", icon: Wallet, key: "portfolio" },
  { label: "Activity", href: "/#activity", icon: Activity, key: "activity" },
  { label: "ChainGPT", href: "/chaingpt", icon: Sparkles, key: "chaingpt" },
  { label: "WunderTrading", href: "/wundertrading", icon: BriefcaseBusiness, key: "wundertrading" },
  { label: "Research", href: "/research", icon: Search, key: "research" },
] as const;

const adminNavigation = [
  { label: "Data admin", href: "/admin/data", icon: Database, key: "admin" },
  { label: "Risk controls", href: "/admin/risk", icon: ShieldCheck, key: "risk" },
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
  const visibleAdminNavigation = adminSections
    ? adminNavigation.filter(({ key }) => adminSections.includes(key))
    : adminNavigation;
  const visibleNavigation = adminView ? [...navigation, ...visibleAdminNavigation] : navigation;

  return (
    <div className="terminal-shell">
      <aside className="sidebar" aria-label="Application sidebar">
        <Link className="brand" href="/" aria-label="Veylora overview">
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
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}