# Active Directory and AD FS

This guide covers the supported identity integrations for Purchasing
Management:

1. **AD FS OIDC is the primary SSO method** for production. It uses
   Authorization Code + PKCE (S256).
2. **LDAPS or LDAP StartTLS form authentication** is available when an
   organization needs directory password authentication or AD group mapping.

The browser and API never trust a client-supplied role or department. On every
directory sign-in, the API authenticates the user, resolves the configured
groups, and applies the server-side group-to-role and group-to-department
maps. Local accounts remain a restricted break-glass path.

## 1. AD FS OIDC (primary SSO)

Register an Authorization Code OIDC application in AD FS 2016, 2019, or 2022.
Enable PKCE with S256 and register this exact callback URI:

```text
https://<InvestFlow-host>/api/auth/adfs/callback
```

Configure the provider and claims in **Settings → Authentication → AD FS**, or
provide deployment fallbacks using the `ADFS_*` variables in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `ADFS_ENABLED` | Enables the AD FS button and flow when no persisted setting overrides it. |
| `ADFS_ISSUER` / `ADFS_AUTHORITY` | The issuer/authority URL from AD FS metadata. |
| `ADFS_DISCOVERY_URL` | Optional non-standard discovery document URL. |
| `ADFS_CLIENT_ID` | Registered OIDC application/client identifier. |
| `ADFS_CLIENT_SECRET` | Optional confidential-client secret; provide via a secret manager. |
| `ADFS_REDIRECT_URI` | Optional explicit callback URI; otherwise derived from the app base URL. |
| `ADFS_SCOPES` | Space-separated scopes; `openid` is required. |
| `ADFS_USERNAME_CLAIM` | Username/UPN claim (default `preferred_username`). |
| `ADFS_EMAIL_CLAIM` | Email claim (default `email`). |
| `ADFS_DISPLAY_NAME_CLAIM` | Display-name claim (default `name`). |
| `ADFS_CA_PEM` | Optional PEM CA for a private AD FS PKI. |

Persisted Settings values take precedence over environment fallbacks. The
client secret and private CA are encrypted before storage and are never
returned by the API. Production requires an independent
`SETTINGS_ENCRYPTION_KEY`.

The ID token is accepted only after issuer, audience, signature/JWKS, nonce,
and expiry validation. The callback state is one-time, HttpOnly, and short
lived; return targets must be local paths. An identity is keyed by provider,
issuer, and OIDC subject before safe username/email matching is considered.
Newly provisioned identities receive a non-administrative role and existing
roles/departments are retained.

See [`docs/adfs-oidc.md`](../../../docs/adfs-oidc.md) for provider
registration, claim mapping, logout, and troubleshooting details.

## 2. LDAPS form authentication

Ask the directory administrator for:

| Setting | Example | Notes |
| --- | --- | --- |
| Host | `dc01.corp.example.com` | Must be reachable from the API server. |
| Port | `636` | Use `3269` for an AD global catalog over TLS where appropriate. |
| Base DN | `DC=corp,DC=example,DC=com` | Root of the user search. |
| Bind DN | `CN=svc-purchasing,OU=Service Accounts,DC=corp,DC=example,DC=com` | Read-only service identity used to search users. |
| Bind password | supplied out of band | Stored encrypted; never commit it or put it in logs. |
| Directory CA | PEM certificate chain | Required when the directory uses a private CA. |

In **Settings → LDAP**:

1. Enable LDAP and select `ldaps` (preferred) or `starttls`.
2. Enter the host, port, base DN, bind DN, and bind password.
3. Paste the issuing CA certificate as PEM when the directory is private PKI.
4. Keep certificate verification enabled in production. A temporary
   production exception requires the audited, time-boxed exception variables
   documented in `DEPLOY.md`.
5. Use the **Test connection** action, then save.

The bind password is used only to locate and authenticate the user. The
user's password is never stored by the application. LDAP search filters
contain `{username}` and the server escapes the supplied username before
substitution; do not construct filters by string concatenation.

### User filter and attributes

The Active Directory defaults are:

```text
(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))
```

The filter must contain `{username}`. A deployment may use a scoped OU or
UPN-aware filter, for example:

```text
(&(objectCategory=person)(objectClass=user)
  (|(sAMAccountName={username})(userPrincipalName={username})))
```

The default attributes are `sAMAccountName`, `displayName`, `mail`, and
`memberOf`. They can be changed for a compatible directory from the LDAP
settings page.

## 3. Group-to-role and department mapping

Open **Settings → LDAP → AD group mapping**:

- **Group → Role** maps a case-insensitive group key or CN substring to
  `ADMIN`, `FINANCIAL_ALL`, `FINANCIAL_INVOICE`, `FINANCIAL_PAYMENT`,
  `DEPT_MANAGER`, `DEPT_USER`, `GT_INVEST`, `READ_ONLY_DEPT`, or
  `READ_ONLY_ALL`.
- **Group → Department code** maps a directory group to a department code
  already defined in **Settings → Departments**.

When a role map is configured, it is authoritative at every sign-in. A user
with no mapped role is denied access. When a department map is configured, it
is also authoritative and removed memberships are revoked at the next sign-in.
A user must have an applicable role and department scope (unless the role is
all-departments).

Active Directory nested groups are expanded server-side using the matching
rule-in-chain capability when available, with a bounded membership traversal
fallback. Verify the resulting roles and departments through the admin audit
log rather than granting privileges in the browser.

## 4. Connectivity and smoke tests

Run these from the API host, using an approved temporary test identity:

```bash
openssl s_client -connect dc01.corp.example.com:636 \
  -CAfile /path/to/customer-ca.pem -showcerts < /dev/null

ldapsearch -H ldaps://dc01.corp.example.com:636 \
  -D 'CN=svc-purchasing,OU=Service Accounts,DC=corp,DC=example,DC=com' \
  -W -b 'DC=corp,DC=example,DC=com' \
  '(sAMAccountName=alice)' dn memberOf
```

The TLS test should report `Verify return code: 0 (ok)`. Then use the login
form with the **Use LDAP / Active Directory** option, and confirm that the
audit record and effective roles/departments match the configured maps.

For AD FS, use the **Sign in with AD FS** button and verify the exact callback
URI, issuer, claims, and PKCE registration if the flow fails. Do not place
provider tokens, passwords, or client secrets in issue reports or logs.

## 5. Rotation and operations

- Rotate the directory bind password in AD, update it in Settings, and test
  the next sign-in. The value is not displayed back to the browser.
- Replace a directory CA PEM in Settings before the old certificate expires.
- Keep `SETTINGS_ENCRYPTION_KEY` stable and rotate it only through a planned
  decrypt-and-reencrypt procedure.
- Review group maps and directory memberships whenever a role or department
  changes.
- Keep AD FS redirect URIs, scopes, claim names, and relying-party
  configuration under change control.
- Keep `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, and provider secrets out of
  source control and routine logs.
