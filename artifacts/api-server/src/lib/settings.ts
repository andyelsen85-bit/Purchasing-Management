import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptAdfsClientSecret, invalidateAdfsDiscoveryCache } from "./adfs";

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
  senderName?: string | null;
  skipTlsVerify?: boolean;
}

export interface AdfsConfigStored {
  enabled?: boolean;
  displayName?: string | null;
  issuer?: string | null;
  /** Alias accepted for AD FS terminology; issuer takes precedence. */
  authority?: string | null;
  discoveryUrl?: string | null;
  clientId?: string | null;
  clientSecretEncrypted?: string | null;
  redirectUri?: string | null;
  scopes?: string | null;
  usernameClaim?: string | null;
  emailClaim?: string | null;
  displayNameClaim?: string | null;
  caPem?: string | null;
  /** Internal precedence markers; never exposed by toPublicSettings. */
  __clientSecretExplicit?: boolean;
  __caPemExplicit?: boolean;
}

/**
 * Per-event automatic notification toggles. ALL DEFAULT OFF — the user
 * opts in per event in Settings → Notifications. The per-rule emails
 * configured for `VALIDATING_SERVICES` (notification_rules table) keep
 * their own per-rule recipients but only fire when `validatingServices`
 * is true here.
 */
export interface NotificationEventToggles {
  /** Workflow advanced to a new step — notify creator + role recipients. */
  stepAdvance?: boolean;
  /** Workflow rejected / closed. */
  reject?: boolean;
  /** GT Invest committee decision recorded. */
  gtInvestDecision?: boolean;
  /** Entering VALIDATING_SERVICES — per-rule recipient emails. */
  validatingServices?: boolean;
}

export interface NotificationConfigStored {
  /** Master switch. When false, no automatic emails are queued at all. */
  enabled?: boolean;
  events?: NotificationEventToggles;
}

export interface AppSettings {
  appName: string;
  logoDataUrl?: string | null;
  /**
   * Public base URL of the web app (e.g. `https://purchasing.chdn.lu`).
   * Used to build clickable workflow links in notification emails so
   * recipients can open the right page in one click. Optional — when
   * blank, notification emails omit links. Trailing slashes are
   * tolerated; the email builder normalises them.
   */
  appBaseUrl?: string | null;
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
  // Shared bearer token generated during agent installation.
  // Returned to authenticated browser clients so they can include it
  // in the Authorization header when calling http://localhost:<port>/sign.
  signingAgentToken?: string | null;
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
  /**
   * Configurable list of Livre I exception labels — picked in
   * section 4.1.2 of the investment request form when the user
   * chooses "Procédure d'exception Livre I" at tier 2.
   */
  livreIExceptions: string[];
  /**
   * Configurable list of Livre II exception labels — picked in
   * section 4.1.4 of the investment request form when the amount
   * falls into tier 3.
   */
  livreIIExceptions: string[];
  /**
   * Cost centres for the N° AA step. Pre-importable from Excel
   * (Settings → N° AA → Import).
   */
  kostenstelleList: string[];
  /**
   * Site list for the N° AA step (e.g. Ettelbruck, Wiltz).
   */
  siteList: string[];
  /**
   * Amortisation rate (%) values selectable in the N° AA entry form.
   */
  tauxAmortissementList: number[];
  /**
   * VAT rate (%) values selectable in the N° AA entry form.
   */
  tauxTvaList: number[];
  ldap: LdapConfigStored;
  adfs: AdfsConfigStored;
  smtp: SmtpConfigStored;
  /**
   * How many minutes between automated notification batch sends.
   * Defaults to 15. Admin-configurable from the SMTP settings tab.
   */
  notificationIntervalMinutes: number;
  /**
   * ISO timestamp of the last time the notification batch was flushed.
   * Null until the first flush. Used to compute the countdown to the
   * next send shown in the Settings page.
   */
  notificationLastSentAt: string | null;
  /**
   * Per-event opt-in for automatic workflow notifications. The master
   * switch (`enabled`) gates everything; the per-event flags then
   * decide which categories of email actually queue. ALL DEFAULT OFF.
   */
  notifications: NotificationConfigStored;
}

const DEFAULT: AppSettings = {
  appName: "InvestFlow",
  logoDataUrl: null,
  appBaseUrl: null,
  limitX: 10000,
  quoteThresholdStandard: 10000,
  quoteThresholdLivreI: 50000,
  quoteThresholdLivreII: 200000,
  currency: "EUR",
  certSigningEnabled: false,
  signingAgentPort: 9443,
  signingAgentToken: null,
  archiveRetentionDays: 365,
  gtInvestRecipients: [],
  budgetPositions: [],
  livreIExceptions: [
    "Offres irrégulières/inacceptables ou absence d’offres (avec urgence ou après seconde procédure)",
    "Recherche, expérimentation, étude ou développement",
    "Impossibilité de fixer les prix à l’avance (nature/aléas du marché)",
    "Absence de concurrence (raisons techniques, artistiques, scientifiques ou droits exclusifs)",
    "Urgence impérieuse imprévisible non imputable au pouvoir adjudicateur",
    "Répétition de travaux ou services similaires (marché initial + max 3 ans)",
    "Livraisons complémentaires du fournisseur initial (compatibilité technique)",
    "Fournitures cotées en bourse des matières premières",
    "Prix soustraits à la concurrence ou services à tarif officiel",
    "Je ne sais pas",
  ],
  kostenstelleList: [],
  siteList: ["Ettelbruck", "Wiltz"],
  tauxAmortissementList: [10, 20, 25, 33.33, 50],
  tauxTvaList: [0, 3, 8, 14, 17],
  livreIIExceptions: [
    "Aucune offre / aucune offre appropriée / aucune demande appropriée après procédure ouverte ou restreinte",
    "Œuvre d’art ou performance artistique unique",
    "Absence de concurrence pour raisons techniques",
    "Protection de droits d’exclusivité (ex : propriété intellectuelle)",
    "Urgence impérieuse imprévisible non imputable au CHdN",
    "Fournitures : recherche, expérimentation ou développement",
    "Fournitures : livraisons complémentaires du fournisseur initial (compatibilité technique – max ± 3 ans)",
    "Fournitures : cotées en bourse des matières premières",
    "Fournitures : achats à conditions particulièrement avantageuses (faillite, liquidation…)",
  ],
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
  adfs: {},
  smtp: {
    enabled: false,
    host: null,
    port: 587,
    username: null,
    password: null,
    secure: false,
    from: null,
    senderName: null,
    skipTlsVerify: false,
  },
  notificationIntervalMinutes: 15,
  notificationLastSentAt: null,
  notifications: {
    enabled: false,
    events: {
      stepAdvance: false,
      reject: false,
      gtInvestDecision: false,
      validatingServices: false,
    },
  },
};

export type NotificationEventKey = keyof NotificationEventToggles;

/**
 * Returns true when the master switch is on AND the named event is
 * enabled. All call sites that queue an automatic email must guard
 * with this helper. Reads the latest settings from the DB each call
 * (cheap — single row) so toggle changes take effect immediately.
 */
export async function isNotificationEventEnabled(
  key: NotificationEventKey,
): Promise<boolean> {
  const s = await getSettings();
  const n = s.notifications;
  if (!n?.enabled) return false;
  return !!n.events?.[key];
}

export async function getSettings(): Promise<AppSettings> {
  const envAdfs: AdfsConfigStored = {
    enabled: /^(1|true|yes)$/i.test(process.env.ADFS_ENABLED ?? ""),
    displayName: process.env.ADFS_DISPLAY_NAME ?? "AD FS",
    issuer: process.env.ADFS_ISSUER ?? process.env.ADFS_AUTHORITY ?? null,
    authority: process.env.ADFS_AUTHORITY ?? null,
    discoveryUrl: process.env.ADFS_DISCOVERY_URL ?? null,
    clientId: process.env.ADFS_CLIENT_ID ?? null,
    redirectUri: process.env.ADFS_REDIRECT_URI ?? null,
    scopes: process.env.ADFS_SCOPES ?? "openid profile email",
    usernameClaim: process.env.ADFS_USERNAME_CLAIM ?? "preferred_username",
    emailClaim: process.env.ADFS_EMAIL_CLAIM ?? "email",
    displayNameClaim: process.env.ADFS_DISPLAY_NAME_CLAIM ?? "name",
    caPem: process.env.ADFS_CA_PEM ?? null,
  };
  const [row] = await db.select().from(settingsTable).limit(1);
  if (!row) {
    const initial = { ...DEFAULT, adfs: envAdfs };
    await db.insert(settingsTable).values({ data: initial });
    return initial;
  }
  const merged = { ...DEFAULT, ...((row.data as Partial<AppSettings>) ?? {}) };
  const savedAdfs = ((row.data as Partial<AppSettings>)?.adfs ?? {}) as AdfsConfigStored;
  merged.adfs = { ...envAdfs, ...savedAdfs };
  merged.adfs.__clientSecretExplicit =
    Object.prototype.hasOwnProperty.call(savedAdfs, "clientSecretEncrypted");
  merged.adfs.__caPemExplicit = Object.prototype.hasOwnProperty.call(savedAdfs, "caPem");
  // `authority` is an accepted AD FS alias. A persisted alias must override
  // an ADFS_ISSUER fallback rather than being shadowed by it.
  if (!Object.prototype.hasOwnProperty.call(savedAdfs, "issuer") && savedAdfs.authority) {
    merged.adfs.issuer = savedAdfs.authority;
  }
  // Migrate only the two historical built-in labels; operator-customized
  // branding must remain untouched.
  if (merged.appName === "Purchasing Management" || merged.appName === "Gestion des Achats") {
    merged.appName = "InvestFlow";
    await db.update(settingsTable).set({ data: merged }).where(eq(settingsTable.id, row.id));
  }
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
  const hasStoredAdfsSecret =
    !!s.adfs?.__clientSecretExplicit ||
    Object.prototype.hasOwnProperty.call(s.adfs ?? {}, "clientSecretEncrypted");
  const hasStoredAdfsCa = !!s.adfs?.__caPemExplicit;
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
    signingAgentToken: s.signingAgentToken ?? null,
    archiveRetentionDays: s.archiveRetentionDays ?? null,
    gtInvestRecipients: s.gtInvestRecipients ?? [],
    budgetPositions: s.budgetPositions ?? [],
    livreIExceptions: s.livreIExceptions ?? [],
    livreIIExceptions: s.livreIIExceptions ?? [],
    kostenstelleList: s.kostenstelleList ?? [],
    siteList: s.siteList ?? [],
    tauxAmortissementList: s.tauxAmortissementList ?? [],
    tauxTvaList: s.tauxTvaList ?? [],
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
    adfs: {
      enabled: !!s.adfs?.enabled,
      displayName: s.adfs?.displayName ?? "AD FS",
      issuer: s.adfs?.issuer ?? s.adfs?.authority ?? null,
      authority: s.adfs?.authority ?? null,
      discoveryUrl: s.adfs?.discoveryUrl ?? null,
      clientId: s.adfs?.clientId ?? null,
      clientSecretSet: hasStoredAdfsSecret
        ? !!s.adfs?.clientSecretEncrypted
        : !!process.env.ADFS_CLIENT_SECRET,
      redirectUri: s.adfs?.redirectUri ?? null,
      scopes: s.adfs?.scopes ?? "openid profile email",
      usernameClaim: s.adfs?.usernameClaim ?? "preferred_username",
      emailClaim: s.adfs?.emailClaim ?? "email",
      displayNameClaim: s.adfs?.displayNameClaim ?? "name",
      caPemSet: hasStoredAdfsCa ? !!s.adfs?.caPem : !!process.env.ADFS_CA_PEM,
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
      senderName: s.smtp?.senderName ?? null,
      skipTlsVerify: !!s.smtp?.skipTlsVerify,
    },
    notificationIntervalMinutes: s.notificationIntervalMinutes ?? 15,
    notificationLastSentAt: s.notificationLastSentAt ?? null,
    notifications: {
      enabled: !!s.notifications?.enabled,
      events: {
        stepAdvance: !!s.notifications?.events?.stepAdvance,
        reject: !!s.notifications?.events?.reject,
        gtInvestDecision: !!s.notifications?.events?.gtInvestDecision,
        validatingServices: !!s.notifications?.events?.validatingServices,
      },
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export async function updateSettingsRecord(
  patch: DeepPartial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const rawAdfs = patch.adfs as (AdfsConfigStored & { clientSecret?: string | null }) | undefined;
  let adfsPatch: AdfsConfigStored | undefined;
  if (rawAdfs) {
    adfsPatch = { ...rawAdfs };
    for (const key of ["issuer", "authority", "discoveryUrl", "redirectUri"] as const) {
      const value = adfsPatch[key];
      if (value) {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error(`Invalid AD FS ${key}`);
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error(`AD FS ${key} must use HTTP(S)`);
        }
      }
    }
    if (adfsPatch.scopes) {
      const scopes = Array.from(
        new Set(adfsPatch.scopes.split(/\s+/).filter(Boolean).concat("openid")),
      );
      adfsPatch.scopes = scopes.join(" ");
    }
    if (Object.prototype.hasOwnProperty.call(rawAdfs, "clientSecret")) {
      const supplied = rawAdfs.clientSecret;
      delete (adfsPatch as { clientSecret?: string | null }).clientSecret;
      adfsPatch.clientSecretEncrypted =
        supplied === null || supplied === "" || supplied === undefined
          ? null
          : encryptAdfsClientSecret(supplied);
    }
  }
  const merged: AppSettings = {
    ...current,
    ...patch,
    ldap: { ...current.ldap, ...(patch.ldap ?? {}) },
    adfs: { ...current.adfs, ...(adfsPatch ?? {}) },
    smtp: { ...current.smtp, ...(patch.smtp ?? {}) },
    notifications: {
      ...current.notifications,
      ...(patch.notifications ?? {}),
      events: {
        ...current.notifications?.events,
        ...(patch.notifications?.events ?? {}),
      },
    },
  } as AppSettings;
  if (rawAdfs && Object.prototype.hasOwnProperty.call(rawAdfs, "clientSecret")) {
    merged.adfs.__clientSecretExplicit = true;
  }
  if (rawAdfs && Object.prototype.hasOwnProperty.call(rawAdfs, "caPem")) {
    merged.adfs.__caPemExplicit = true;
  }
  if (rawAdfs && Object.prototype.hasOwnProperty.call(rawAdfs, "caPem")) {
    const pem = rawAdfs.caPem;
    if (pem) {
      // Validation is intentionally performed before writing settings.
      const { validateCaPem } = await import("./adfs");
      validateCaPem(pem);
    }
  }
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
  if (rawAdfs) invalidateAdfsDiscoveryCache();
  return merged;
}
