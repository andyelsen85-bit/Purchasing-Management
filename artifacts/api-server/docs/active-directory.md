# Pointing the app at a customer Active Directory

This document explains how to wire the Purchasing Management app to a real
Active Directory for both LDAPS form login and silent Kerberos / SPNEGO
single sign-on.

What hot-reloads vs. what needs a server restart:

- **Hot-reloaded** (no restart): everything saved through **Settings →
  LDAP** — host, port, base/bind DN, bind password, CA cert, skip-verify
  toggle, Kerberos enable, SPN, user filter, and group → role /
  department mapping. The auth backend reads the persisted settings on
  every sign-in (`getSettings()` runs inside both `POST /api/auth/login`
  and `GET /api/auth/negotiate`), so saving the LDAP tab is enough to
  roll out a config change to the next user that signs in.
- **Requires restart / redeploy**: the host-level Kerberos prerequisites
  in §4 — installing `libkrb5` and the optional `kerberos` npm package,
  changes to `/etc/krb5.conf`, and the `KRB5_KEYTAB` / `KRB5_SPN`
  environment variables. These are read once at process start (env
  vars) or by the dynamically-loaded native module, so the API server
  needs to be restarted after any of them change. Replacing the keytab
  *file* on disk does **not** require a restart — see §6.

---

## 1. Prerequisites on the customer side

Ask the customer's AD administrator for the following. None of these are
secrets the app generates — they all come from their directory.

| Field | Example | Notes |
| --- | --- | --- |
| LDAPS host | `dc01.corp.example.com` | A domain controller reachable from the app server on TCP/636. |
| LDAPS port | `636` | Default LDAPS. `3269` for the global catalog over TLS. |
| Base DN | `DC=corp,DC=example,DC=com` | Root of the user search. May also be an OU like `OU=Employees,DC=corp,…`. |
| Service / bind account | `CN=svc-purchasing,OU=Service Accounts,DC=corp,…` | A read-only account used to look up users by `sAMAccountName`. Plain user works; "managed service account" works too. |
| Bind password | `••••••••` | Stored encrypted-at-rest in the app's settings table. |
| AD CA certificate (PEM) | `-----BEGIN CERTIFICATE-----…` | Required when the DC's LDAPS cert is signed by a private/internal CA. |
| Kerberos realm | `CORP.EXAMPLE.COM` | Upper-case DNS name of the AD domain. |
| Service Principal Name | `HTTP/purchasing.corp.example.com@CORP.EXAMPLE.COM` | The SPN that the app will present to clients during the SPNEGO handshake. |

The AD admin must register the SPN against the service account, e.g.:

```powershell
setspn -S HTTP/purchasing.corp.example.com svc-purchasing
```

---

## 2. Filling in **Settings → LDAP**

Sign in as an `ADMIN` user, open **Settings → LDAP**, and fill in:

1. **LDAP enabled** — toggle on.
2. **Host** — the domain controller hostname (must match the cert's CN/SAN).
3. **Port** — `636` for LDAPS, `3269` for global catalog.
4. **Base DN** — the search root (typically the domain DN).
5. **Bind DN** — the full DN of the read-only service account.
6. **Bind password** — paste once. Re-saving with this field empty keeps
   the previously stored password (the value is never sent back to the
   browser; the form just shows whether one is set).
7. **Skip TLS verification** — leave **off** in production. Only useful
   for a one-off connectivity smoke test against a self-signed test DC.
8. **CA certificate (PEM)** — paste the full PEM chain that signed the
   DC's LDAPS certificate. Same "leave empty to keep" semantics as the
   bind password.
9. **Enable Kerberos / GSSAPI** — toggle on if you want silent SSO from
   domain-joined Windows clients.
10. **Service principal name** — the SPN registered in step 1
    (e.g. `HTTP/purchasing.corp.example.com`).

Hit **Save**. The next sign-in attempt will use the new config.

### Optional user filter

The default user filter is `(sAMAccountName={username})`, which matches
the typed username against the AD logon name. To accept email addresses
or to scope the search to a specific OU, set a custom filter via the API
(`PATCH /api/settings` with `ldap.userFilter`). Some customer-friendly
examples:

```
(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))
(|(sAMAccountName={username})(userPrincipalName={username}))
```

The `{username}` placeholder is RFC 4515-escaped before substitution, so
operators don't have to worry about LDAP injection.

---

## 3. Mapping AD groups to roles and departments

Open **Settings → LDAP** → **AD group mapping** panel.

- **Group → Role**: each row maps a group key (substring or CN) to one
  of the app roles (`ADMIN`, `FINANCIAL_ALL`, `FINANCIAL_INVOICE`,
  `FINANCIAL_PAYMENT`, `DEPT_MANAGER`, `DEPT_USER`, `GT_INVEST`,
  `READ_ONLY_DEPT`, `READ_ONLY_ALL`). A user always gets `DEPT_USER` as
  a baseline.
- **Group → Department code**: maps an AD group to a department `code`
  defined in **Settings → Departments**.

The mapping is **authoritative on every sign-in** — removing a user from
a mapped AD group will revoke the corresponding role/department on
their next login. Manual department assignments survive only for
tenants that have not configured a group→department map at all.

### Nested group resolution

The backend uses Active Directory's `LDAP_MATCHING_RULE_IN_CHAIN`
(`1.2.840.113556.1.4.1941`) to walk the entire group tree server-side
in a single search. So if `alice` is in `CN=PurchasingApprovers` and
`PurchasingApprovers` is in `CN=PurchasingAdmins`, mapping
`PurchasingAdmins → ADMIN` is enough — alice picks up `ADMIN` even
though she is only directly in the leaf group.

If the DC refuses the extended match (rare; some appliances do), the
app falls back to a client-side BFS over `memberOf`. Both paths return
the same flattened group list.

---

## 4. Setting up Kerberos / SPNEGO on the app server

Kerberos requires native bits that we don't ship in the default image.

### 4a. Install the Kerberos library

```bash
# Ubuntu / Debian
apt-get install -y libkrb5-3 libkrb5-dev krb5-user

# RHEL / Rocky
dnf install -y krb5-libs krb5-workstation krb5-devel

# Then, in the api-server package:
pnpm --filter @workspace/api-server add kerberos
```

The `kerberos` npm package is loaded **dynamically** at request time —
if it is missing, the `/api/auth/negotiate` endpoint returns
`501 Kerberos native module is not installed on this server` instead
of crashing the process. So the LDAP form login keeps working in
environments where Kerberos cannot be built.

### 4b. Provision `/etc/krb5.conf`

```ini
[libdefaults]
  default_realm = CORP.EXAMPLE.COM
  rdns = false
  dns_lookup_kdc = true

[realms]
  CORP.EXAMPLE.COM = {
    kdc = dc01.corp.example.com
    admin_server = dc01.corp.example.com
  }

[domain_realm]
  .corp.example.com = CORP.EXAMPLE.COM
  corp.example.com = CORP.EXAMPLE.COM
```

### 4c. Drop the keytab and tell the app where to find it

The AD admin produces the keytab on a domain-joined Windows machine:

```powershell
ktpass -princ HTTP/purchasing.corp.example.com@CORP.EXAMPLE.COM `
       -mapuser CORP\svc-purchasing `
       -pass * `
       -ptype KRB5_NT_PRINCIPAL `
       -crypto AES256-SHA1 `
       -out purchasing.keytab
```

Copy `purchasing.keytab` to the app server (e.g. `/etc/krb5.keytab`),
restrict it to the service user (`chmod 600`), and expose its path via
the `KRB5_KEYTAB` environment variable (`KRB5_SPN` is optional — if
unset the app uses the SPN from Settings):

```
KRB5_KEYTAB=/etc/krb5.keytab
KRB5_SPN=HTTP/purchasing.corp.example.com
```

The `/api/auth/negotiate` endpoint refuses to start the SPNEGO exchange
unless **both** `KRB5_KEYTAB` is set and `kerberosEnabled` is on with
an SPN — so a half-configured deployment fails closed with a clear
error instead of silently falling back to forms.

### 4d. Configure browsers (intranet zone)

For browsers to send a Negotiate token automatically:

- **Chrome / Edge (Windows)** — add the app's hostname to **Internet
  Options → Security → Local intranet → Sites → Advanced**.
- **Firefox** — set `network.negotiate-auth.trusted-uris` to the app's
  hostname in `about:config`.
- **macOS** — run `kinit user@CORP.EXAMPLE.COM` to obtain a TGT first,
  then Safari/Chrome will participate in the handshake.

The login page silently calls `GET /api/auth/negotiate` once on load.
If the browser has a TGT and the host is trusted, the user is signed in
without ever seeing the form. Otherwise the form falls through.

---

## 5. Smoke testing the configuration

1. **LDAPS connectivity** (from the app server):

   ```bash
   openssl s_client -connect dc01.corp.example.com:636 \
                    -CAfile /path/to/customer-ca.pem -showcerts < /dev/null
   ```

   You should see `Verify return code: 0 (ok)`.

2. **Bind smoke test**:

   ```bash
   ldapsearch -H ldaps://dc01.corp.example.com:636 \
              -D 'CN=svc-purchasing,OU=Service Accounts,DC=corp,DC=example,DC=com' \
              -W -b 'DC=corp,DC=example,DC=com' \
              '(sAMAccountName=alice)' dn memberOf
   ```

   It should return alice's DN and `memberOf` list.

3. **Form login**: open the app, flip **Use LDAP / Active Directory** on,
   sign in as `alice` with her domain password.

4. **Group mapping**: in **Settings → Audit log** or via direct DB
   inspection, confirm alice's `roles` and `departmentIds` reflect the
   mapping.

5. **Silent SSO**: from a domain-joined workstation, open the app's URL
   in a browser configured per §4d. The login page should flash
   "Trying single sign-on…" and land on the dashboard without prompting.

   If it falls back to the form, check the server logs for the
   `Kerberos negotiation failed` message — typical causes:
   - SPN mismatch between keytab and DNS hostname
   - Clock skew > 5 minutes between the app server and the DC
   - Browser hostname not in the trusted intranet list

---

## 6. Rotating credentials / certificates

- **Bind password** — change it in AD, paste the new value in
  **Settings → LDAP**, save. No restart.
- **CA certificate** — paste the new PEM into the CA cert box, save.
  Existing in-flight LDAP connections are unaffected; the next login
  uses the new chain.
- **Keytab** — replace the file on disk. The `kerberos` library reads
  the keytab on every `initializeServer` call, so a new keytab is
  picked up by the next negotiate request without restart.

---

## 7. Troubleshooting reference

| Symptom | Likely cause |
| --- | --- |
| `LDAP connection error` | Firewall / DNS / wrong port. Try `openssl s_client` first. |
| `LDAP bind error` | Bind DN typo, locked-out service account, or expired password. |
| `Invalid credentials` (form) | The user's typed password is wrong, *or* the user's account is disabled. The bind succeeds but the user-DN bind fails. |
| `User not found` | `userFilter` doesn't match — usually a base-DN scoping issue. |
| `Kerberos backend not configured` | Either `KRB5_KEYTAB` env var is missing or **Kerberos enabled** is off. |
| `Kerberos native module is not installed` | `pnpm add kerberos` was never run, or the build failed because libkrb5-dev is missing. |
| `Kerberos negotiation failed: …` | Clock skew, SPN mismatch, or stale keytab. Run `kinit -kt /etc/krb5.keytab HTTP/host@REALM` on the app server to verify the keytab is valid. |
| Roles don't update after AD group change | Group mapping is empty in Settings, or the group key doesn't match the group's CN/DN. The match is a case-insensitive substring on either the full DN or the leftmost CN. |
