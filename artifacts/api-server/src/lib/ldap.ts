import ldap from "ldapjs";
import { logger } from "./logger";

export interface LdapConfig {
  enabled?: boolean | null;
  host?: string | null;
  port?: number | null;
  baseDn?: string | null;
  bindDn?: string | null;
  bindPassword?: string | null;
  skipVerify?: boolean | null;
  caCert?: string | null;
  userFilter?: string | null;
  kerberosEnabled?: boolean | null;
  servicePrincipalName?: string | null;
}

export interface LdapAuthResult {
  ok: boolean;
  displayName?: string;
  email?: string;
  groups?: string[];
  error?: string;
}

export async function ldapAuthenticate(
  cfg: LdapConfig,
  username: string,
  password: string,
): Promise<LdapAuthResult> {
  if (!cfg.enabled || !cfg.host || !cfg.baseDn) {
    return { ok: false, error: "LDAP not configured" };
  }
  const port = cfg.port ?? 636;
  const url = `ldaps://${cfg.host}:${port}`;

  const tlsOptions: Record<string, unknown> = {};
  if (cfg.skipVerify) tlsOptions.rejectUnauthorized = false;
  if (cfg.caCert) tlsOptions.ca = [cfg.caCert];

  return new Promise<LdapAuthResult>((resolve) => {
    const client = ldap.createClient({ url, tlsOptions });
    client.on("error", (err) => {
      logger.warn({ err: String(err) }, "LDAP client error");
      resolve({ ok: false, error: "LDAP connection error" });
    });

    const finish = (r: LdapAuthResult) => {
      try {
        client.unbind();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const doSearch = () => {
      const filter = (cfg.userFilter || "(sAMAccountName={username})").replace(
        /{username}/g,
        username,
      );
      client.search(
        cfg.baseDn!,
        {
          filter,
          scope: "sub",
          attributes: ["dn", "displayName", "mail", "memberOf", "cn"],
        },
        (err, search) => {
          if (err) return finish({ ok: false, error: "LDAP search error" });
          let foundDn: string | null = null;
          let displayName = username;
          let email: string | undefined;
          const groups: string[] = [];
          search.on("searchEntry", (entry) => {
            const obj = entry.pojo;
            foundDn = obj.objectName ?? null;
            for (const a of obj.attributes ?? []) {
              if (a.type === "displayName" && a.values?.[0])
                displayName = String(a.values[0]);
              if (a.type === "cn" && a.values?.[0] && displayName === username)
                displayName = String(a.values[0]);
              if (a.type === "mail" && a.values?.[0])
                email = String(a.values[0]);
              if (a.type === "memberOf")
                for (const v of a.values ?? []) groups.push(String(v));
            }
          });
          search.on("error", () =>
            finish({ ok: false, error: "LDAP search failed" }),
          );
          search.on("end", () => {
            if (!foundDn)
              return finish({ ok: false, error: "User not found" });
            // Bind as the user
            const userClient = ldap.createClient({ url, tlsOptions });
            userClient.on("error", () =>
              finish({ ok: false, error: "LDAP user bind error" }),
            );
            userClient.bind(foundDn, password, (bErr) => {
              try {
                userClient.unbind();
              } catch {
                /* ignore */
              }
              if (bErr)
                return finish({ ok: false, error: "Invalid credentials" });
              finish({ ok: true, displayName, email, groups });
            });
          });
        },
      );
    };

    if (cfg.bindDn && cfg.bindPassword) {
      client.bind(cfg.bindDn, cfg.bindPassword, (err) => {
        if (err) return finish({ ok: false, error: "LDAP bind error" });
        doSearch();
      });
    } else {
      doSearch();
    }
  });
}
