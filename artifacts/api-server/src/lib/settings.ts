import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type LdapEncryption = "ldaps" | "starttls" | "plain";
export type LdapDirectoryType = "ad" | "generic";

/** Defaults for a Microsoft Active Directory deployment. */
export const AD_DEFAULTS = {
  userFilter:
    "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))",
  usernameAttribute: "sAMAccountName",
  displayNameAttribute: "displayName",
  emailAttribute: "mail",
  groupMembershipAttribute: "memberOf",
} as const;

/** Defaults for a generic RFC 4519 directory (OpenLDAP, 389-DS, etc). */
export const GENERIC_DEFAULTS = {
  userFilter: "(&(objectClass=inetOrgPerson)(uid={username}))",
  usernameAttribute: "uid",
  displayNameAttribute: "cn",
  emailAttribute: "mail",
  groupMembershipAttribute: "memberOf",
} as const;

export interface LdapConfigStored {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  /**
   * Transport security mode.
   *  - `ldaps`    — implicit TLS (default, port 636).
   *  - `starttls` — plain LDAP connect on port 389 then upgrade with
   *    the StartTLS extended op.
   *  - `plain`    — no encryption. Lab/diagnostic only.
   * Older saved configs without this field are treated as `ldaps` for
   * backward compatibility.
   */
  encryption?: LdapEncryption | null;
  /**
   * Directory flavour. Drives the default filter and attribute names.
   * `ad` = Microsoft Active Directory (sAMAccountName, memberOf, …).
   * `generic` = RFC 4519 directories. Older saved configs default to `ad`
   * to preserve existing behaviour.
   */
  directoryType?: LdapDirectoryType | null;
  baseDn?: string | null;
  bindDn?: string | null;
  bindPassword?: string | null;
  skipVerify?: boolean;
  caCert?: string | null;
  /**
   * LDAP search filter used to find the user record. Must contain the
   * literal `{username}` token, which is replaced with the (escaped)
   * sign-in name. AD default:
   * `(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))`.
   */
  userFilter?: string | null;
  /** Login-name attribute (`sAMAccountName` for AD, `uid` for OpenLDAP). */
  usernameAttribute?: string | null;
  /** Attribute holding the human display name (`displayName` / `cn`). */
  displayNameAttribute?: string | null;
  /** Attribute holding the e-mail address (`mail`). */
  emailAttribute?: string | null;
  /** Multi-valued attribute listing group DNs (`memberOf` in AD). */
  groupMembershipAttribute?: string | null;
  kerberosEnabled?: boolean;
  servicePrincipalName?: string | null;
  /**
   * Optional AD group → app role mapping. Keys are case-insensitive
   * substrings matched against each `memberOf` DN (or the leftmost CN
   * component); values are app role names (`ADMIN`, `FINANCIAL_ALL`, ...).
   * Mapping is applied on every LDAP / Kerberos login so AD remains the
   * source of truth and removing a user from a group revokes the role.
   */
  groupRoleMap?: Record<string, string> | null;
  /**
   * Optional AD group → department code mapping. Same matching rules as
   * `groupRoleMap`; the matched department codes are looked up in the
   * departments table and become the user's department memberships.
   */
  groupDepartmentMap?: Record<string, string> | null;
}

export interface SmtpConfigStored {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  secure?: boolean;
  from?: string | null;
}

export interface AppSettings {
  appName: string;
  logoDataUrl?: string | null;
  /**
   * Legacy alias of `quoteThresholdStandard`. Kept in the type so existing
   * code paths (workflows.ts, the AppSettingsPanel form) continue to
   * compile; `getSettings()` keeps both fields in sync.
   */
  limitX: number;
  /**
   * First publication-tier threshold. A first quote amount strictly above
   * this value (and at or below `quoteThresholdLivreI`) flips the workflow
   * into THREE_QUOTES — three suppliers with a winning pick required.
   */
  quoteThresholdStandard: number;
  /**
   * Second threshold. Above this value the workflow is tagged LIVRE_I.
   */
  quoteThresholdLivreI: number;
  /**
   * Third threshold. Above this value the workflow is tagged LIVRE_II.
   */
  quoteThresholdLivreII: number;
  currency: string;
  certSigningEnabled: boolean;
  // Port on which the Windows signing agent listens on each
  // operator's workstation. The browser always contacts
  // http://localhost:<port>/sign, so the URL is implicit and only
  // the port (defined at agent install time) needs to be configured.
  signingAgentPort?: number | null;
  // Default retention (in days) used to pre-populate the Settings →
  // Archive panel. The archive endpoint always reads the cutoff from
  // the request body, so this is purely a UX default.
  archiveRetentionDays?: number | null;
  gtInvestRecipients: string[];
  /**
   * Configurable list of GT Invest budget position labels — picked
   * from a dropdown in section 4.4.1 of the investment request form
   * on workflow creation. Managed in Settings → GT Invest.
   */
  budgetPositions: string[];
  ldap: LdapConfigStored;
  smtp: SmtpConfigStored;
}

const DEFAULT: AppSettings = {
  appName: "Purchasing Management",
  logoDataUrl: null,
  limitX: 10000,
  quoteThresholdStandard: 10000,
  quoteThresholdLivreI: 50000,
  quoteThresholdLivreII: 200000,
  currency: "EUR",
  certSigningEnabled: false,
  signingAgentPort: 9443,
  archiveRetentionDays: 365,
  gtInvestRecipients: [],
  budgetPositions: [],
  ldap: {
    enabled: false,
    host: null,
    port: 636,
    encryption: "ldaps",
    directoryType: "ad",
    baseDn: null,
    bindDn: null,
    bindPassword: null,
    skipVerify: false,
    caCert: null,
    userFilter: AD_DEFAULTS.userFilter,
    usernameAttribute: AD_DEFAULTS.usernameAttribute,
    displayNameAttribute: AD_DEFAULTS.displayNameAttribute,
    emailAttribute: AD_DEFAULTS.emailAttribute,
    groupMembershipAttribute: AD_DEFAULTS.groupMembershipAttribute,
    kerberosEnabled: false,
    servicePrincipalName: null,
    groupRoleMap: {},
    groupDepartmentMap: {},
  },
  smtp: {
    enabled: false,
    host: null,
    port: 587,
    username: null,
    password: null,
    secure: false,
    from: null,
  },
};

export async function getSettings(): Promise<AppSettings> {
  const [row] = await db.select().from(settingsTable).limit(1);
  if (!row) {
    await db.insert(settingsTable).values({ data: DEFAULT });
    return DEFAULT;
  }
  const merged = { ...DEFAULT, ...((row.data as Partial<AppSettings>) ?? {}) };
  // Keep legacy `limitX` and the new `quoteThresholdStandard` mirrored
  // both ways so old saved settings (which only have limitX) seed the
  // new field, and new saves (which only set quoteThresholdStandard)
  // still satisfy the legacy field readers.
  if (
    merged.quoteThresholdStandard == null ||
    merged.quoteThresholdStandard === DEFAULT.quoteThresholdStandard
  ) {
    if (merged.limitX != null) merged.quoteThresholdStandard = merged.limitX;
  }
  merged.limitX = merged.quoteThresholdStandard;
  return merged;
}

/** Pure helper — derive the publication tier from a first quote amount. */
export function derivePublicationTier(
  firstAmount: number | null | undefined,
  s: Pick<
    AppSettings,
    "quoteThresholdStandard" | "quoteThresholdLivreI" | "quoteThresholdLivreII"
  >,
): "STANDARD" | "THREE_QUOTES" | "LIVRE_I" | "LIVRE_II" {
  const a = firstAmount;
  if (a == null) return "STANDARD";
  if (a > s.quoteThresholdLivreII) return "LIVRE_II";
  if (a > s.quoteThresholdLivreI) return "LIVRE_I";
  if (a > s.quoteThresholdStandard) return "THREE_QUOTES";
  return "STANDARD";
}

export function toPublicSettings(s: AppSettings) {
  return {
    appName: s.appName,
    logoDataUrl: s.logoDataUrl ?? null,
    limitX: s.limitX,
    quoteThresholdStandard: s.quoteThresholdStandard,
    quoteThresholdLivreI: s.quoteThresholdLivreI,
    quoteThresholdLivreII: s.quoteThresholdLivreII,
    currency: s.currency,
    certSigningEnabled: s.certSigningEnabled,
    signingAgentPort: s.signingAgentPort ?? null,
    archiveRetentionDays: s.archiveRetentionDays ?? null,
    gtInvestRecipients: s.gtInvestRecipients ?? [],
    budgetPositions: s.budgetPositions ?? [],
    ldap: {
      enabled: !!s.ldap?.enabled,
      host: s.ldap?.host ?? null,
      port: s.ldap?.port ?? null,
      encryption: (s.ldap?.encryption ?? "ldaps") as LdapEncryption,
      directoryType: (s.ldap?.directoryType ?? "ad") as LdapDirectoryType,
      baseDn: s.ldap?.baseDn ?? null,
      bindDn: s.ldap?.bindDn ?? null,
      bindPasswordSet: !!s.ldap?.bindPassword,
      skipVerify: !!s.ldap?.skipVerify,
      caCertSet: !!s.ldap?.caCert,
      userFilter: s.ldap?.userFilter ?? null,
      usernameAttribute: s.ldap?.usernameAttribute ?? null,
      displayNameAttribute: s.ldap?.displayNameAttribute ?? null,
      emailAttribute: s.ldap?.emailAttribute ?? null,
      groupMembershipAttribute: s.ldap?.groupMembershipAttribute ?? null,
      kerberosEnabled: !!s.ldap?.kerberosEnabled,
      servicePrincipalName: s.ldap?.servicePrincipalName ?? null,
      groupRoleMap: s.ldap?.groupRoleMap ?? {},
      groupDepartmentMap: s.ldap?.groupDepartmentMap ?? {},
    },
    smtp: {
      enabled: !!s.smtp?.enabled,
      host: s.smtp?.host ?? null,
      port: s.smtp?.port ?? null,
      username: s.smtp?.username ?? null,
      passwordSet: !!s.smtp?.password,
      secure: !!s.smtp?.secure,
      // Public field is named `fromAddress` (matches the OpenAPI schema
      // and the React form). The stored shape uses the legacy `from`
      // column name — translate it on the way out so the SMTP form
      // re-populates correctly after a save + reload.
      fromAddress: s.smtp?.from ?? null,
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export async function updateSettingsRecord(
  patch: DeepPartial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const merged: AppSettings = {
    ...current,
    ...patch,
    ldap: { ...current.ldap, ...(patch.ldap ?? {}) },
    smtp: { ...current.smtp, ...(patch.smtp ?? {}) },
  } as AppSettings;
  // If bindPassword/password/caCert is empty string in patch, treat as "unset"
  const [row] = await db.select().from(settingsTable).limit(1);
  if (!row) {
    await db.insert(settingsTable).values({ data: merged });
  } else {
    await db
      .update(settingsTable)
      .set({ data: merged })
      .where(eq(settingsTable.id, row.id));
  }
  return merged;
}
