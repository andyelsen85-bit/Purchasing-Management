import ldap from "ldapjs";
import { logger } from "./logger";

export type LdapEncryption = "ldaps" | "starttls" | "plain";
export type LdapDirectoryType = "ad" | "generic";

export interface LdapConfig {
  enabled?: boolean | null;
  host?: string | null;
  port?: number | null;
  encryption?: LdapEncryption | null;
  directoryType?: LdapDirectoryType | null;
  baseDn?: string | null;
  bindDn?: string | null;
  bindPassword?: string | null;
  skipVerify?: boolean | null;
  caCert?: string | null;
  userFilter?: string | null;
  usernameAttribute?: string | null;
  displayNameAttribute?: string | null;
  emailAttribute?: string | null;
  groupMembershipAttribute?: string | null;
  kerberosEnabled?: boolean | null;
  servicePrincipalName?: string | null;
}

/**
 * Resolve the per-directory defaults for the search filter and the
 * attribute names. AD (`directoryType: "ad"`, the default) uses
 * `sAMAccountName` / `displayName` / `mail` / `memberOf`; generic
 * directories use the RFC 4519 names. Operators can still override any
 * field individually in Settings.
 */
function attrs(cfg: LdapConfig) {
  const isAd = (cfg.directoryType ?? "ad") === "ad";
  const presetFilter = isAd
    ? "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))"
    : "(&(objectClass=inetOrgPerson)(uid={username}))";
  return {
    userFilter: cfg.userFilter || presetFilter,
    usernameAttr: cfg.usernameAttribute || (isAd ? "sAMAccountName" : "uid"),
    displayAttr: cfg.displayNameAttribute || (isAd ? "displayName" : "cn"),
    emailAttr: cfg.emailAttribute || "mail",
    groupAttr: cfg.groupMembershipAttribute || "memberOf",
  };
}

export interface LdapAuthResult {
  ok: boolean;
  displayName?: string;
  email?: string;
  groups?: string[];
  error?: string;
}

/**
 * One row in the diagnostic trace returned by `runLdapDiagnostics`.
 *
 * `name` is a short human label ("Connect", "Bind as service account",
 * "Search user", "Bind as user", "Resolve groups"). `status` is "ok" /
 * "fail" / "skip". `detail` is free-form text shown to the operator —
 * usually the raw `ldapjs` / Node error message so they can fix the
 * config without grepping server logs.
 */
export interface LdapDiagnosticStep {
  name: string;
  status: "ok" | "fail" | "skip";
  detail?: string | null;
  durationMs?: number | null;
}

interface ResolvedTransport {
  url: string;
  encryption: LdapEncryption;
  tlsOptions: Record<string, unknown>;
}

/**
 * Pick the URL scheme + TLS options from the saved config.
 *
 * `encryption` is the operator's explicit choice; when missing (older
 * saved configs) we infer from the port (389 → starttls, anything else
 * → ldaps). The TLS object always sets `servername` for SNI — many
 * load-balanced AD setups reset the connection without it, which surfaces
 * as a useless `read ECONNRESET` from Node's TLS layer.
 */
function resolveTransport(cfg: LdapConfig): ResolvedTransport {
  const port = cfg.port ?? (cfg.encryption === "ldaps" ? 636 : 389);
  const enc: LdapEncryption =
    cfg.encryption ?? (port === 389 ? "starttls" : "ldaps");
  const scheme = enc === "ldaps" ? "ldaps" : "ldap";
  const url = `${scheme}://${cfg.host}:${port}`;
  const tlsOptions: Record<string, unknown> = {};
  if (cfg.host) tlsOptions.servername = cfg.host;
  if (cfg.skipVerify) tlsOptions.rejectUnauthorized = false;
  if (cfg.caCert) tlsOptions.ca = [cfg.caCert];
  return { url, encryption: enc, tlsOptions };
}

/**
 * Create a connected LDAP client, performing a StartTLS upgrade when
 * configured. Resolves with `{ client }` on success or `{ error }` with
 * the underlying message on failure (including TLS handshake resets).
 */
type ConnectResult =
  | { ok: true; client: ldap.Client }
  | { ok: false; error: string };

function connect(transport: ResolvedTransport): Promise<ConnectResult> {
  return new Promise((resolve) => {
    let settled = false;
    const client = ldap.createClient({
      url: transport.url,
      tlsOptions: transport.tlsOptions,
      // Don't reconnect on a hard handshake failure — we want the error
      // to bubble up immediately, not silently retry forever.
      reconnect: false,
    });
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      const msg = friendlyError(err);
      logger.warn({ err: String(err), url: transport.url }, "LDAP client error");
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: msg });
    };
    client.on("error", fail);
    client.on("connectError", fail);
    client.on("connectTimeout", () => fail(new Error("connect timeout")));

    const onReady = () => {
      if (settled) return;
      if (transport.encryption === "starttls") {
        client.starttls(transport.tlsOptions, [], (err) => {
          if (err) return fail(err);
          if (settled) return;
          settled = true;
          resolve({ ok: true, client });
        });
        return;
      }
      settled = true;
      resolve({ ok: true, client });
    };
    // ldapjs emits `connect` after the socket (and TLS, for ldaps://) is
    // ready. Some versions also expose `setupSocket`; `connect` is the
    // documented one.
    client.on("connect", onReady);
  });
}

/**
 * Translate an Active Directory bind failure into a user-actionable
 * message. AD encodes the *real* reason as `data NNN` inside the
 * "AcceptSecurityContext error" string returned over LDAP — every
 * outcome (wrong password, locked, expired, disabled, must-reset…)
 * comes back as the same generic 49 / InvalidCredentials code unless
 * we parse this sub-code.
 *
 * Returns null when no AD sub-code is recognised, so the caller can
 * fall back to a generic "Invalid credentials" message.
 */
export function explainAdBindError(raw: string): string | null {
  const m = raw.match(/data\s+([0-9a-fA-F]{2,4})/);
  if (!m) return null;
  const code = m[1].toLowerCase();
  switch (code) {
    case "525":
      return "User not found in Active Directory.";
    case "52e":
      return "Invalid credentials — the password is wrong.";
    case "530":
      return "Not permitted to sign in at this time of day (AD logon hours restriction).";
    case "531":
      return "Not permitted to sign in from this workstation (AD workstation restriction).";
    case "532":
      return "Password has expired — change it in Active Directory and try again.";
    case "533":
      return "This Active Directory account is disabled.";
    case "701":
      return "This Active Directory account has expired.";
    case "773":
      return "Password must be changed on next sign-in — reset it in AD first.";
    case "775":
      return "This Active Directory account is locked out.";
    default:
      return null;
  }
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/ECONNRESET/i.test(raw)) {
    return "LDAP connection was reset by the server. This usually means the encryption mode does not match the port (e.g. LDAPS to a plain 389 port, or StartTLS to 636).";
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "LDAP connection refused. Check the host and port, and that the directory server is reachable from this machine.";
  }
  if (/ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(raw)) {
    return "Could not reach the LDAP server (timeout). Check host, port, and firewall rules.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "LDAP host could not be resolved by DNS.";
  }
  if (/CERT|self.signed|unable to verify|altnames|hostname|TLSV1|SSL|wrong version/i.test(raw)) {
    return `LDAP TLS error: ${raw}. Verify the CA certificate, the host name in the certificate, or enable "Skip TLS verification" temporarily.`;
  }
  return `LDAP error: ${raw}`;
}

// ─── Shared nested-group resolution ──────────────────────────────────────────

/**
 * BFS over `memberOf` attributes.
 *
 * Starting from `seed` (a user's direct memberOf values), fetches each
 * group's own `memberOf` attribute and queues any parent groups not yet
 * visited, until the tree is exhausted. All discovered DNs are added to
 * `acc` in-place. Uses `client` (must be bound as a service account).
 */
async function bfsMemberOf(
  client: ldap.Client,
  seed: string[],
  acc: Set<string>,
): Promise<void> {
  const queue = [...seed];
  const visited = new Set<string>(seed);
  while (queue.length > 0) {
    const dn = queue.shift()!;
    const parents = await new Promise<string[]>((r) => {
      const out: string[] = [];
      client.search(dn, { scope: "base", attributes: ["memberOf"] }, (err, s) => {
        if (err) return r([]);
        s.on("searchEntry", (entry) => {
          for (const a of entry.pojo.attributes ?? []) {
            if (a.type === "memberOf")
              for (const v of a.values ?? []) out.push(String(v));
          }
        });
        s.on("error", () => r([]));
        s.on("end", () => r(out));
      });
    });
    for (const p of parents) {
      if (!visited.has(p)) {
        visited.add(p);
        acc.add(p);
        queue.push(p);
      }
    }
  }
}

/**
 * Resolve all transitive group memberships for `userDn`.
 *
 * Tries `LDAP_MATCHING_RULE_IN_CHAIN` (AD OID 1.2.840.113556.1.4.1941)
 * first — one server-side query that returns every group transitively.
 * Falls back to `bfsMemberOf` in three cases:
 *   1. The server returns a hard error for the OID filter.
 *   2. The server silently accepts the OID but returns zero entries —
 *      many non-AD / older-AD servers do this instead of erroring,
 *      which previously caused nested groups to be silently dropped.
 *   3. The server signals sizeLimitExceeded (status 4) — results were
 *      truncated, BFS fills in what was missed.
 *
 * Returns the union of `directGroups` and all transitively discovered
 * parent groups (deduplicated). `client` must already be bound as a
 * service account with read access to the directory.
 */
async function resolveAllGroups(
  client: ldap.Client,
  baseDn: string,
  userDn: string,
  directGroups: string[],
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const all = new Set(directGroups);
    const filter = `(member:1.2.840.113556.1.4.1941:=${userDn})`;
    client.search(
      baseDn,
      { filter, scope: "sub", attributes: ["dn"] },
      (err, search) => {
        if (err) {
          bfsMemberOf(client, directGroups, all).then(() =>
            resolve(Array.from(all)),
          );
          return;
        }
        let oidFoundAny = false;
        search.on("searchEntry", (entry) => {
          if (entry.pojo.objectName) {
            all.add(entry.pojo.objectName);
            oidFoundAny = true;
          }
        });
        search.on("error", () =>
          bfsMemberOf(client, directGroups, all).then(() =>
            resolve(Array.from(all)),
          ),
        );
        search.on("end", async (result) => {
          const status =
            (result as unknown as { status?: number })?.status ?? 0;
          if (!oidFoundAny || status === 4) {
            await bfsMemberOf(client, directGroups, all);
          }
          resolve(Array.from(all));
        });
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export async function ldapAuthenticate(
  cfg: LdapConfig,
  username: string,
  password: string,
): Promise<LdapAuthResult> {
  if (!cfg.enabled || !cfg.host || !cfg.baseDn) {
    return { ok: false, error: "LDAP not configured" };
  }
  const transport = resolveTransport(cfg);
  const conn = await connect(transport);
  if (!conn.ok) return { ok: false, error: conn.error };
  const client = conn.client;

  return new Promise<LdapAuthResult>((resolve) => {
    const finish = (r: LdapAuthResult) => {
      try {
        client.unbind();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    // RFC 4515 §3 escaping for LDAP search filter assertion values.
    const ldapEscape = (raw: string): string =>
      raw.replace(/[\\*()\u0000]/g, (ch) => {
        const map: Record<string, string> = {
          "\\": "\\5c",
          "*": "\\2a",
          "(": "\\28",
          ")": "\\29",
          "\u0000": "\\00",
        };
        return map[ch] ?? ch;
      });

    const doSearch = () => {
      const safeUsername = ldapEscape(username);
      const a = attrs(cfg);
      const filter = a.userFilter.replace(/{username}/g, safeUsername);
      // Always request `cn` as a last-resort display name fallback.
      const requested = Array.from(
        new Set(["dn", a.displayAttr, a.emailAttr, a.groupAttr, "cn"]),
      );
      client.search(
        cfg.baseDn!,
        { filter, scope: "sub", attributes: requested },
        (err, search) => {
          if (err) return finish({ ok: false, error: "LDAP search error" });
          let foundDn: string | null = null;
          let displayName = username;
          let email: string | undefined;
          const groups: string[] = [];
          search.on("searchEntry", (entry) => {
            const obj = entry.pojo;
            foundDn = obj.objectName ?? null;
            for (const at of obj.attributes ?? []) {
              if (at.type === a.displayAttr && at.values?.[0])
                displayName = String(at.values[0]);
              else if (
                at.type === "cn" &&
                at.values?.[0] &&
                displayName === username
              )
                displayName = String(at.values[0]);
              if (at.type === a.emailAttr && at.values?.[0])
                email = String(at.values[0]);
              if (at.type === a.groupAttr)
                for (const v of at.values ?? []) groups.push(String(v));
            }
          });
          search.on("error", () =>
            finish({ ok: false, error: "LDAP search failed" }),
          );
          search.on("end", async () => {
            if (!foundDn) {
              logger.warn(
                { username, baseDn: cfg.baseDn, filter, attribute: a.usernameAttr },
                "LDAP user search returned no entries",
              );
              return finish({
                ok: false,
                error: `User "${username}" not found in directory under ${cfg.baseDn} using filter ${filter}. Check that the username matches the configured "${a.usernameAttr}" attribute and that the base DN is correct.`,
              });
            }
            // Bind as the user using a fresh connection so we don't
            // disturb the bind-DN session.
            const userConn = await connect(transport);
            if (!userConn.ok)
              return finish({ ok: false, error: userConn.error });
            const userClient = userConn.client;
            userClient.bind(foundDn, password, async (bErr) => {
              try {
                userClient.unbind();
              } catch {
                /* ignore */
              }
              if (bErr) {
                const raw = (bErr as Error).message ?? String(bErr);
                const explained = explainAdBindError(raw);
                logger.warn(
                  { username, foundDn, raw },
                  "LDAP user bind rejected",
                );
                // Always include the raw directory error in the
                // response so operators (and the on-screen alert) can
                // see what AD / the LDAP server actually said —
                // otherwise every failure looks identical and is
                // impossible to triage. The friendly explanation is
                // prepended when we recognise the AD sub-code.
                const friendly =
                  explained ??
                  (/InvalidCredentials/i.test(raw)
                    ? "Invalid credentials"
                    : "LDAP bind rejected");
                return finish({
                  ok: false,
                  error: `${friendly} (DN: ${foundDn}) — raw: ${raw}`,
                });
              }
              const allGroups = await resolveAllGroups(client, cfg.baseDn!, foundDn!, groups);
              finish({ ok: true, displayName, email, groups: allGroups });
            });
          });
        },
      );
    };

    if (cfg.bindDn && cfg.bindPassword) {
      client.bind(cfg.bindDn, cfg.bindPassword, (err) => {
        if (err)
          return finish({
            ok: false,
            error: `LDAP bind error: ${err.message ?? String(err)}`,
          });
        doSearch();
      });
    } else {
      doSearch();
    }
  });
}

/**
 * Step-by-step diagnostic for the Settings → Test LDAP panel.
 *
 * Unlike `ldapAuthenticate` which collapses everything into a single
 * boolean + error string, this walks each phase of the login pipeline
 * (TCP/TLS connect → service-account bind → user search → user-bind →
 * group resolution) and records the raw underlying error for each one.
 * The UI renders the resulting list as a checklist so operators can see
 * exactly where things break (e.g. "Connect ✓, Bind ✗ — invalid
 * credentials") without digging through server logs.
 */
export async function runLdapDiagnostics(
  cfg: LdapConfig,
  username: string | null,
  password: string | null,
): Promise<{
  ok: boolean;
  stage: "bind" | "search" | "user_bind" | "complete";
  error: string | null;
  displayName: string | null;
  email: string | null;
  groups: string[];
  steps: LdapDiagnosticStep[];
}> {
  const steps: LdapDiagnosticStep[] = [];
  const t0 = (): number => Date.now();
  const since = (start: number) => Date.now() - start;

  if (!cfg.enabled || !cfg.host || !cfg.baseDn) {
    return {
      ok: false,
      stage: "bind",
      error:
        "LDAP is not enabled or host/baseDn missing in Settings — fill those in and save before testing.",
      displayName: null,
      email: null,
      groups: [],
      steps: [
        {
          name: "Configuration",
          status: "fail",
          detail: "LDAP disabled or host/baseDn missing.",
        },
      ],
    };
  }

  const transport = resolveTransport(cfg);
  const tConn = t0();
  const conn = await connect(transport);
  if (!conn.ok) {
    steps.push({
      name: `Connect (${transport.encryption.toUpperCase()} → ${transport.url})`,
      status: "fail",
      detail: conn.error,
      durationMs: since(tConn),
    });
    return {
      ok: false,
      stage: "bind",
      error: conn.error,
      displayName: null,
      email: null,
      groups: [],
      steps,
    };
  }
  steps.push({
    name: `Connect (${transport.encryption.toUpperCase()} → ${transport.url})`,
    status: "ok",
    durationMs: since(tConn),
  });
  const client = conn.client;

  const cleanup = () => {
    try {
      client.unbind();
    } catch {
      /* ignore */
    }
  };

  // ----- Bind as service account (if configured) -----
  if (cfg.bindDn && cfg.bindPassword) {
    const tBind = t0();
    const bindErr = await new Promise<string | null>((resolve) => {
      client.bind(cfg.bindDn!, cfg.bindPassword!, (err) => {
        if (err) {
          const raw = (err as Error).message ?? String(err);
          resolve(friendlyError(err) + ` — raw: ${raw}`);
        } else resolve(null);
      });
    });
    if (bindErr) {
      steps.push({
        name: `Bind as service account (${cfg.bindDn})`,
        status: "fail",
        detail: bindErr,
        durationMs: since(tBind),
      });
      cleanup();
      return {
        ok: false,
        stage: "bind",
        error: bindErr,
        displayName: null,
        email: null,
        groups: [],
        steps,
      };
    }
    steps.push({
      name: `Bind as service account (${cfg.bindDn})`,
      status: "ok",
      durationMs: since(tBind),
    });
  } else {
    steps.push({
      name: "Bind as service account",
      status: "skip",
      detail: "Bind DN/password not configured — skipping.",
    });
  }

  // ----- Search user (if username provided) -----
  if (!username) {
    cleanup();
    steps.push({
      name: "Search user",
      status: "skip",
      detail: "No test username supplied — server reachability confirmed.",
    });
    return {
      ok: true,
      stage: "bind",
      error: null,
      displayName: null,
      email: null,
      groups: [],
      steps,
    };
  }

  const a = attrs(cfg);
  const safeUsername = username.replace(/[\\*()\u0000]/g, (ch) => {
    const map: Record<string, string> = {
      "\\": "\\5c",
      "*": "\\2a",
      "(": "\\28",
      ")": "\\29",
      "\u0000": "\\00",
    };
    return map[ch] ?? ch;
  });
  const filter = a.userFilter.replace(/{username}/g, safeUsername);

  const tSearch = t0();
  const search = await new Promise<{
    ok: boolean;
    error: string | null;
    foundDn: string | null;
    displayName: string | null;
    email: string | null;
    groups: string[];
  }>((resolve) => {
    let foundDn: string | null = null;
    let displayName: string | null = null;
    let email: string | null = null;
    const groups: string[] = [];
    client.search(
      cfg.baseDn!,
      {
        filter,
        scope: "sub",
        attributes: Array.from(
          new Set(["dn", a.displayAttr, a.emailAttr, a.groupAttr, "cn"]),
        ),
      },
      (err, s) => {
        if (err) {
          resolve({
            ok: false,
            error: friendlyError(err) + ` — raw: ${(err as Error).message}`,
            foundDn: null,
            displayName: null,
            email: null,
            groups: [],
          });
          return;
        }
        s.on("searchEntry", (entry) => {
          const obj = entry.pojo;
          foundDn = obj.objectName ?? foundDn;
          for (const at of obj.attributes ?? []) {
            if (at.type === a.displayAttr && at.values?.[0])
              displayName = String(at.values[0]);
            else if (at.type === "cn" && at.values?.[0] && !displayName)
              displayName = String(at.values[0]);
            if (at.type === a.emailAttr && at.values?.[0])
              email = String(at.values[0]);
            if (at.type === a.groupAttr)
              for (const v of at.values ?? []) groups.push(String(v));
          }
        });
        s.on("error", (e) =>
          resolve({
            ok: false,
            error: friendlyError(e) + ` — raw: ${e.message}`,
            foundDn: null,
            displayName: null,
            email: null,
            groups: [],
          }),
        );
        s.on("end", () =>
          resolve({
            ok: true,
            error: null,
            foundDn,
            displayName,
            email,
            groups,
          }),
        );
      },
    );
  });

  if (!search.ok) {
    steps.push({
      name: `Search user "${username}"`,
      status: "fail",
      detail: `${search.error}\nFilter: ${filter}\nBase DN: ${cfg.baseDn}`,
      durationMs: since(tSearch),
    });
    cleanup();
    return {
      ok: false,
      stage: "search",
      error: search.error,
      displayName: null,
      email: null,
      groups: [],
      steps,
    };
  }
  if (!search.foundDn) {
    const msg = `User "${username}" not found in ${cfg.baseDn}. Filter used: ${filter}`;
    steps.push({
      name: `Search user "${username}"`,
      status: "fail",
      detail: msg,
      durationMs: since(tSearch),
    });
    cleanup();
    return {
      ok: false,
      stage: "search",
      error: msg,
      displayName: null,
      email: null,
      groups: [],
      steps,
    };
  }
  steps.push({
    name: `Search user "${username}"`,
    status: "ok",
    detail: `Found DN: ${search.foundDn} · ${search.groups.length} direct group(s)`,
    durationMs: since(tSearch),
  });

  // ----- Resolve nested groups (same OID-then-BFS as ldapAuthenticate) -----
  // Done here, before user bind, so the test page always shows the full
  // transitive group set regardless of whether a password was supplied.
  const tGroups = t0();
  const allGroups = await resolveAllGroups(
    client,
    cfg.baseDn!,
    search.foundDn!,
    search.groups,
  );
  const nested = allGroups.length - search.groups.length;
  steps.push({
    name: "Resolve groups (nested)",
    status: "ok",
    detail:
      nested > 0
        ? `${allGroups.length} total (${search.groups.length} direct + ${nested} nested)`
        : `${allGroups.length} group(s) — no additional nested groups found`,
    durationMs: since(tGroups),
  });

  // ----- Bind as user (if password provided) -----
  if (!password) {
    steps.push({
      name: "Bind as user",
      status: "skip",
      detail: "No test password — search-only probe (login flow not exercised).",
    });
    cleanup();
    return {
      ok: true,
      stage: "search",
      error: null,
      displayName: search.displayName,
      email: search.email,
      groups: allGroups,
      steps,
    };
  }

  const tUserBind = t0();
  const userConn = await connect(transport);
  if (!userConn.ok) {
    steps.push({
      name: "Bind as user",
      status: "fail",
      detail: `Could not open second connection: ${userConn.error}`,
      durationMs: since(tUserBind),
    });
    cleanup();
    return {
      ok: false,
      stage: "user_bind",
      error: userConn.error,
      displayName: search.displayName,
      email: search.email,
      groups: allGroups,
      steps,
    };
  }
  const userClient = userConn.client;
  const bindErr = await new Promise<string | null>((resolve) => {
    userClient.bind(search.foundDn!, password, (err) => {
      try {
        userClient.unbind();
      } catch {
        /* ignore */
      }
      if (err) {
        const raw = (err as Error).message ?? String(err);
        const explained = explainAdBindError(raw);
        if (explained) {
          resolve(`${explained} (DN: ${search.foundDn}) — raw: ${raw}`);
        } else if (/InvalidCredentials/i.test(raw)) {
          resolve(`Invalid credentials for ${search.foundDn} — raw: ${raw}`);
        } else {
          resolve(friendlyError(err) + ` — raw: ${raw}`);
        }
      } else resolve(null);
    });
  });
  if (bindErr) {
    steps.push({
      name: "Bind as user",
      status: "fail",
      detail: bindErr,
      durationMs: since(tUserBind),
    });
    cleanup();
    return {
      ok: false,
      stage: "user_bind",
      error: bindErr,
      displayName: search.displayName,
      email: search.email,
      groups: allGroups,
      steps,
    };
  }
  steps.push({
    name: "Bind as user",
    status: "ok",
    durationMs: since(tUserBind),
  });

  cleanup();
  return {
    ok: true,
    stage: "complete",
    error: null,
    displayName: search.displayName,
    email: search.email,
    groups: allGroups,
    steps,
  };
}

/**
 * Look up an LDAP user's groups *without* authenticating them. Used for
 * proxy-header logins and admin group-sync so we can apply the same AD
 * group → role/department mapping that LDAP sign-in uses. Requires bind
 * credentials. Returns an empty list if LDAP isn't configured or the
 * lookup fails — callers must treat that as "no mapping changes".
 *
 * Nested groups are resolved using the same OID-then-BFS strategy as
 * `ldapAuthenticate`: try LDAP_MATCHING_RULE_IN_CHAIN first, fall back
 * to client-side BFS when the server returns zero results.
 */
export async function lookupLdapGroups(
  cfg: LdapConfig,
  username: string,
): Promise<string[]> {
  if (
    !cfg.enabled ||
    !cfg.host ||
    !cfg.baseDn ||
    !cfg.bindDn ||
    !cfg.bindPassword
  ) {
    return [];
  }
  const transport = resolveTransport(cfg);
  const conn = await connect(transport);
  if (!conn.ok) return [];
  const client = conn.client;

  const finish = (v: string[]) => {
    try {
      client.unbind();
    } catch {
      /* ignore */
    }
    return v;
  };

  const safe = username.replace(/[\\*()\u0000]/g, (c) =>
    (({ "\\": "\\5c", "*": "\\2a", "(": "\\28", ")": "\\29", "\u0000": "\\00" }) as Record<string, string>)[c] ?? c,
  );
  const a = attrs(cfg);
  const filter = a.userFilter.replace(/{username}/g, safe);

  // Bind as service account
  const bindErr = await new Promise<string | null>((r) => {
    client.bind(cfg.bindDn!, cfg.bindPassword!, (err) =>
      r(err ? (err as Error).message : null),
    );
  });
  if (bindErr) return finish([]);

  // Search for the user to get their DN + direct groups
  const { foundDn, directGroups } = await new Promise<{
    foundDn: string | null;
    directGroups: string[];
  }>((r) => {
    let foundDn: string | null = null;
    const directGroups: string[] = [];
    client.search(
      cfg.baseDn!,
      { filter, scope: "sub", attributes: [a.groupAttr, "dn"] },
      (sErr, search) => {
        if (sErr) return r({ foundDn: null, directGroups: [] });
        search.on("searchEntry", (entry) => {
          foundDn = entry.pojo.objectName ?? foundDn;
          for (const at of entry.pojo.attributes ?? []) {
            if (at.type === a.groupAttr)
              for (const v of at.values ?? []) directGroups.push(String(v));
          }
        });
        search.on("error", () => r({ foundDn, directGroups }));
        search.on("end", () => r({ foundDn, directGroups }));
      },
    );
  });

  if (!foundDn) return finish(directGroups);

  const resolved = await resolveAllGroups(client, cfg.baseDn!, foundDn, directGroups);
  return finish(resolved);
}

