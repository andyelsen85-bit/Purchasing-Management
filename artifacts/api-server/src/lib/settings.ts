import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface LdapConfigStored {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  baseDn?: string | null;
  bindDn?: string | null;
  bindPassword?: string | null;
  skipVerify?: boolean;
  caCert?: string | null;
  kerberosEnabled?: boolean;
  servicePrincipalName?: string | null;
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
  limitX: number;
  currency: string;
  certSigningEnabled: boolean;
  signingAgentUrl?: string | null;
  gtInvestRecipients: string[];
  ldap: LdapConfigStored;
  smtp: SmtpConfigStored;
}

const DEFAULT: AppSettings = {
  appName: "Purchasing Management",
  logoDataUrl: null,
  limitX: 10000,
  currency: "EUR",
  certSigningEnabled: false,
  signingAgentUrl: null,
  gtInvestRecipients: [],
  ldap: {
    enabled: false,
    host: null,
    port: 636,
    baseDn: null,
    bindDn: null,
    bindPassword: null,
    skipVerify: false,
    caCert: null,
    kerberosEnabled: false,
    servicePrincipalName: null,
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
  return { ...DEFAULT, ...((row.data as Partial<AppSettings>) ?? {}) };
}

export function toPublicSettings(s: AppSettings) {
  return {
    appName: s.appName,
    logoDataUrl: s.logoDataUrl ?? null,
    limitX: s.limitX,
    currency: s.currency,
    certSigningEnabled: s.certSigningEnabled,
    signingAgentUrl: s.signingAgentUrl ?? null,
    gtInvestRecipients: s.gtInvestRecipients ?? [],
    ldap: {
      enabled: !!s.ldap?.enabled,
      host: s.ldap?.host ?? null,
      port: s.ldap?.port ?? null,
      baseDn: s.ldap?.baseDn ?? null,
      bindDn: s.ldap?.bindDn ?? null,
      bindPasswordSet: !!s.ldap?.bindPassword,
      skipVerify: !!s.ldap?.skipVerify,
      caCertSet: !!s.ldap?.caCert,
      kerberosEnabled: !!s.ldap?.kerberosEnabled,
      servicePrincipalName: s.ldap?.servicePrincipalName ?? null,
    },
    smtp: {
      enabled: !!s.smtp?.enabled,
      host: s.smtp?.host ?? null,
      port: s.smtp?.port ?? null,
      username: s.smtp?.username ?? null,
      passwordSet: !!s.smtp?.password,
      secure: !!s.smtp?.secure,
      from: s.smtp?.from ?? null,
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
