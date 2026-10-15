export const SITE_PERMISSION_CATALOG = [
  { key: "admin.data.read", label: "Read project data catalog", availability: "ACTIVE" },
  { key: "risk.policy.manage", label: "Manage global risk policy", availability: "ACTIVE" },
  { key: "crm.support.read", label: "Read customer support records", availability: "PLANNED" },
  { key: "crm.support.manage", label: "Manage customer support records", availability: "PLANNED" },
  { key: "payments.read", label: "Read payment operations", availability: "PLANNED" },
  { key: "payments.operate", label: "Operate payment workflows", availability: "PLANNED" },
] as const;

export type SitePermissionKey = (typeof SITE_PERMISSION_CATALOG)[number]["key"];
export type ActiveSitePermissionKey = Extract<(typeof SITE_PERMISSION_CATALOG)[number], { availability: "ACTIVE" }>["key"];

export function isSitePermissionKey(value: unknown): value is SitePermissionKey {
  return typeof value === "string" && SITE_PERMISSION_CATALOG.some((permission) => permission.key === value);
}

export function isActiveSitePermissionKey(value: unknown): value is ActiveSitePermissionKey {
  return typeof value === "string" && SITE_PERMISSION_CATALOG.some(
    (permission) => permission.key === value && permission.availability === "ACTIVE",
  );
}