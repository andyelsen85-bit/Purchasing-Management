# Microsoft AD FS OpenID Connect

AD FS OIDC is the intended primary SSO method for production deployments.
Local credentials remain a restricted break-glass path, and LDAPS/Active
Directory is available when explicitly configured for directory
authentication or group mapping. Kerberos/SPNEGO is not a supported operator
login method.

InvestFlow supports the Authorization Code flow with PKCE (S256) against
Microsoft AD FS 2016, 2019, and 2022 OIDC applications. Register the exact
redirect URI shown in **Settings → Authentication → AD FS**:

`https://<InvestFlow-host>/api/auth/adfs/callback`

The value can also be set with `ADFS_REDIRECT_URI`; when omitted, InvestFlow
derives it from `appBaseUrl` (or the incoming trusted host). The AD FS issuer
is normally the authority URL ending in `/adfs`. A non-standard discovery
document can be supplied with `ADFS_DISCOVERY_URL`.

## Client registration

Use an Authorization Code OIDC application. Enable PKCE and register the
redirect URI above. A public client does not have a secret; leave the secret
blank and InvestFlow uses `none` client authentication. A confidential client
uses `client_secret_post`; the secret is authenticated-encrypted with a key
derived from `SESSION_SECRET` before it is stored. The secret and CA
certificate are never returned by the API.

Request only these scopes (or a subset that includes the mandatory `openid`):

`openid profile email`

Do **not** request `user_impersonation`; it is an Azure resource scope and is
not needed for an AD FS sign-in.

Map claims in Settings (or the `ADFS_*_CLAIM` variables). Defaults are
`preferred_username`, `email`, and `name`. AD FS deployments commonly expose
UPN as `upn`; set the username claim to `upn` when `preferred_username` is not
present. The ID token is validated by `openid-client` (issuer, audience,
signature/JWKS, nonce, and expiry) before an InvestFlow session is created.

## Configuration precedence and identities

Persisted Settings values override `ADFS_*` environment fallbacks. Omitting a
secret in a settings update preserves the existing encrypted value; sending an
empty string or `null` explicitly clears it. A custom CA must be a valid PEM
certificate. It is added to Node's normal `tls.rootCertificates`; certificate
verification is never disabled.

An identity is keyed by provider + issuer + OIDC subject. This stable mapping
is checked first. For an unmapped subject InvestFlow falls back to
case-insensitive normalized username/UPN, then email. If those hints point to
different users, sign-in fails safely rather than guessing. A new identity is
provisioned with `DEPT_USER` and no administrative role. Existing users retain
their roles and department assignments; a user with no roles cannot sign in.

## Reauthentication, logout, and deep links

`GET /api/auth/adfs/start?returnTo=/workflows/123` starts a login. The
return target must be a local path; absolute URLs, schemes, `//`, backslashes,
controls, CR/LF, and malformed encodings are rejected. It is signed into a
five-minute, HttpOnly, one-time state cookie together with nonce and PKCE
verifier. Authorization codes and tokens are never logged or persisted.

AD FS logout from the application uses the existing `/api/auth/logout`
endpoint, destroys the normal server session, and clears the
`investflow_login_method` cookie. AD FS single logout is not assumed; configure
the provider's sign-out page separately if organization policy requires global
sign-out.

## Troubleshooting

* Confirm AD FS has the OIDC application and exact redirect URI (scheme,
  host, path, and trailing slash must match).
* Verify the issuer is the issuer in the discovery document, not only a DNS
  alias. Use `ADFS_DISCOVERY_URL` only for a valid metadata path.
* For a private PKI, paste the issuing CA certificate as PEM, not a leaf key or
  private key.
* Check that the configured claim names are present in the ID token and that
  scopes include `openid`.
* A state/nonce failure generally means an expired browser flow, blocked
  cookies, or a second callback. Start a new login rather than retrying a
  callback URL.
