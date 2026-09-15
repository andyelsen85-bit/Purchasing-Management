import {
  createHmac,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  customFetch,
  discovery,
  None,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type ClientAuth,
  type CustomFetch,
} from "openid-client";
import type { Request } from "express";
import type { AppSettings, AdfsConfigStored } from "./settings";
import {
  decryptSettingSecret,
  encryptSettingSecret,
  isSettingSecretEnvelope,
} from "./secret-crypto";

export const ADFS_PROVIDER = "adfs";
export const ADFS_STATE_COOKIE = "investflow_adfs_state";
export const ADFS_LOGIN_COOKIE = "investflow_login_method";
const STATE_TTL_SECONDS = 5 * 60;
const MAX_RETURN_TARGET_LENGTH = 2048;

export function adfsLoginMethodCookie(secure: boolean, maxAge = 31536000): string {
  return `${ADFS_LOGIN_COOKIE}=adfs; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearAdfsLoginMethodCookie(secure: boolean): string {
  return `${ADFS_LOGIN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export interface AdfsState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  exp: number;
}

function secretKey(): Buffer {
  return scryptSync(
    process.env.SESSION_SECRET ?? "dev-secret-change-me",
    "investflow/adfs/client-secret",
    32,
  );
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function unb64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Authenticated encryption for the optional confidential-client secret. */
export function encryptAdfsClientSecret(secret: string): string {
  return encryptSettingSecret(secret, "adfs.clientSecret");
  /*
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ciphertext)}`;
  */
}

export function decryptAdfsClientSecret(encoded: string): string | null {
  if (isSettingSecretEnvelope(encoded)) {
    try {
      return decryptSettingSecret(encoded, "adfs.clientSecret");
    } catch {
      return null;
    }
  }
  // Compatibility with the historical v1 format, which was encrypted using
  // the session signing key.
  try {
    const [, ivText, tagText, ciphertextText] = encoded.split(".");
    if (!ivText || !tagText || !ciphertextText) return null;
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), unb64url(ivText));
    decipher.setAuthTag(unb64url(tagText));
    return Buffer.concat([
      decipher.update(unb64url(ciphertextText)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Validate and normalize a PEM CA without ever weakening TLS validation. */
export function validateCaPem(pem: string): string {
  const normalized = pem.trim();
  if (!normalized || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(normalized)) {
    throw new Error("CA must contain a PEM certificate");
  }
  try {
    // X509Certificate rejects malformed, truncated, and non-certificate PEM.
    new X509Certificate(normalized);
  } catch {
    throw new Error("CA PEM certificate is invalid");
  }
  return `${normalized}\n`;
}

export function validateLocalReturnTarget(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_TARGET_LENGTH) {
    return "/";
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value) || /%0[dDaA]/.test(value)) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (
    decoded.length === 0 ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
  ) {
    return "/";
  }
  return decoded;
}

function statePayload(state: AdfsState): string {
  return b64url(JSON.stringify(state));
}

function stateSignature(payload: string): string {
  return createHmac("sha256", secretKey()).update(payload).digest("base64url");
}

/** Sign the state cookie; the cookie contains no tokens or authorization code. */
export function signAdfsState(state: AdfsState): string {
  const payload = statePayload(state);
  return `${payload}.${stateSignature(payload)}`;
}

export function verifyAdfsState(value: string | undefined, now = Math.floor(Date.now() / 1000)): AdfsState | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(stateSignature(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(unb64url(payload).toString("utf8")) as AdfsState;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.exp !== "number" ||
      parsed.exp < now ||
      validateLocalReturnTarget(parsed.returnTo) !== parsed.returnTo
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createAdfsState(returnTo: string): AdfsState {
  return {
    state: randomState(),
    nonce: randomNonce(),
    codeVerifier: randomPKCECodeVerifier(),
    returnTo: validateLocalReturnTarget(returnTo),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
}

export async function authorizationUrl(
  config: Configuration,
  state: AdfsState,
  redirectUri: string,
  scope: string,
): Promise<string> {
  const challenge = await calculatePKCECodeChallenge(state.codeVerifier);
  const url = buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope,
    state: state.state,
    nonce: state.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return url.href;
}

const discoveryCache = new Map<string, { config: Configuration; agent: Agent }>();

export function invalidateAdfsDiscoveryCache(): void {
  for (const entry of discoveryCache.values()) void entry.agent.close();
  discoveryCache.clear();
}

function caFor(settings: AppSettings): string | undefined {
  return settings.adfs?.caPem ? validateCaPem(settings.adfs.caPem) : undefined;
}

export function buildAdfsCaBundle(caPem: string): string {
  return `${tls.rootCertificates.join("\n")}\n${validateCaPem(caPem)}`;
}

export function adfsClientAuthentication(clientSecret: string | null): ClientAuth {
  return clientSecret ? ClientSecretPost(clientSecret) : None();
}

export async function getAdfsClient(
  settings: AppSettings,
  clientSecret: string | null,
): Promise<Configuration> {
  const issuer = (settings.adfs?.issuer ?? settings.adfs?.authority ?? "").trim();
  const clientId = (settings.adfs?.clientId ?? "").trim();
  if (!issuer || !clientId) throw new Error("AD FS issuer and client ID are required");
  const issuerUrl = new URL(issuer);
  if (!["https:", "http:"].includes(issuerUrl.protocol)) {
    throw new Error("AD FS issuer must use HTTP(S)");
  }
  const ca = caFor(settings);
  const discoveryUrl = settings.adfs?.discoveryUrl?.trim();
  if (discoveryUrl) {
    const metadataUrl = new URL(discoveryUrl);
    if (!["https:", "http:"].includes(metadataUrl.protocol)) {
      throw new Error("AD FS discovery URL must use HTTP(S)");
    }
  }
  const key = JSON.stringify([issuer, clientId, clientSecret ? "confidential" : "public", ca ?? "", discoveryUrl ?? ""]);
  const cached = discoveryCache.get(key);
  if (cached) return cached.config;
  const agent = new Agent({
    connect: ca
      ? { ca: buildAdfsCaBundle(ca) }
      : undefined,
  });
  const fetcher: CustomFetch = async (input, init) => {
    const url = String(input);
    // Keep openid-client's issuer validation enabled while allowing AD FS
    // deployments to publish metadata at a non-standard path.
    if (
      discoveryUrl &&
      (url.endsWith("/.well-known/openid-configuration") ||
        url.endsWith("/.well-known/oauth-authorization-server"))
    ) {
      return undiciFetch(
        discoveryUrl,
        { ...(init as unknown as Record<string, unknown>), dispatcher: agent } as never,
      ) as unknown as Response;
    }
    return undiciFetch(
      url,
      { ...(init as unknown as Record<string, unknown>), dispatcher: agent } as never,
    ) as unknown as Response;
  };
  const config = await discovery(
    issuerUrl,
    clientId,
    undefined,
    adfsClientAuthentication(clientSecret),
    { [customFetch]: fetcher },
  );
  discoveryCache.set(key, { config, agent });
  return config;
}

export interface MappedClaims {
  subject: string;
  issuer: string;
  username: string;
  email: string | null;
  displayName: string;
}

export function resolveIdentityCandidate(
  usernameUserIds: number[],
  emailUserIds: number[],
): { userId: number | null; conflict: boolean } {
  const ids = new Set([...usernameUserIds, ...emailUserIds]);
  return { userId: ids.size === 1 ? [...ids][0]! : null, conflict: ids.size > 1 };
}

export function sameExternalIdentity(
  a: { provider: string; issuer: string; subject: string },
  b: { provider: string; issuer: string; subject: string },
): boolean {
  return a.provider === b.provider && a.issuer === b.issuer && a.subject === b.subject;
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mapAdfsClaims(
  claims: Record<string, unknown>,
  issuer: string,
  cfg: AdfsConfigStored,
): MappedClaims {
  const subject = claimString(claims, "sub");
  const username =
    claimString(claims, cfg.usernameClaim ?? "preferred_username") ??
    claimString(claims, "upn") ??
    claimString(claims, "email");
  if (!subject || !username) throw new Error("Required AD FS identity claims are missing");
  const email = claimString(claims, cfg.emailClaim ?? "email");
  const displayName =
    claimString(claims, cfg.displayNameClaim ?? "name") ?? username;
  return { subject, issuer, username, email, displayName };
}

export async function exchangeAdfsCode(
  config: Configuration,
  callbackUrl: URL,
  state: AdfsState,
) {
  return authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: state.codeVerifier,
    expectedState: state.state,
    expectedNonce: state.nonce,
  });
}

export function adfsRedirectUri(req: Request, settings: AppSettings): string {
  const configured = settings.adfs?.redirectUri?.trim();
  if (configured) {
    const parsed = new URL(configured);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("AD FS redirect URI must be an HTTP(S) URL without credentials or fragment");
    }
    return parsed.href;
  }
  const base = settings.appBaseUrl?.trim() || `${req.protocol}://${req.get("host")}`;
  const parsedBase = new URL(base);
  if (!["https:", "http:"].includes(parsedBase.protocol)) {
    throw new Error("AD FS base URL must use HTTP(S)");
  }
  return `${base.replace(/\/+$/, "")}/api/auth/adfs/callback`;
}

/**
 * openid-client must validate the authorization response against the exact
 * registered redirect URI. The reverse proxy/request Host is not trusted for
 * this purpose; only the callback query is copied onto the configured URI.
 */
export function callbackUrlForRedirect(
  redirectUri: string,
  callbackSearch: string,
): URL {
  const configured = new URL(redirectUri);
  const query = callbackSearch.startsWith("?") ? callbackSearch : `?${callbackSearch}`;
  const params = new URL(`https://callback.invalid/${query}`).search;
  configured.search = params;
  configured.hash = "";
  return configured;
}

export function adfsClientSecret(settings: AppSettings): string | null {
  const config = settings.adfs ?? {};
  if (Object.prototype.hasOwnProperty.call(config, "clientSecretEncrypted")) {
    if (!config.clientSecretEncrypted) return null;
    const secret = decryptAdfsClientSecret(config.clientSecretEncrypted);
    if (secret === null) throw new Error("Stored AD FS client secret could not be decrypted");
    return secret;
  }
  const env = process.env.ADFS_CLIENT_SECRET;
  return env?.trim() || null;
}

export const isAdfsReplay = (() => {
  const consumed = new Map<string, number>();
  return (state: string, now = Math.floor(Date.now() / 1000)): boolean => {
    for (const [key, expiry] of consumed) if (expiry <= now) consumed.delete(key);
    if (consumed.has(state)) return true;
    consumed.set(state, now + STATE_TTL_SECONDS);
    return false;
  };
})();
