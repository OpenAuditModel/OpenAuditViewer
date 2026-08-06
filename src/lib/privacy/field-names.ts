/**
 * Property-name registries.
 *
 * Matching is **exact after normalization**, never substring. Substring
 * matching is what makes name-based linters unusable: `passwordPolicy`,
 * `secretRotationEnabled`, `tokenCount`, `authorizationDecision` and
 * `cookieConsent` are all legitimate audit fields that a substring rule would
 * flag, and a rule that cries wolf is a rule that gets switched off.
 *
 * Normalization removes only case and the separators that the same concept is
 * spelled with in different systems: `clientSecret`, `client_secret`,
 * `client-secret` and `Client.Secret` are one name.
 */

/** Lower-cases a property name and removes `-`, `_`, `.` and spaces. */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_. ]/g, "");
}

/**
 * Property names whose value is a credential by definition. A field with one of
 * these names has no non-sensitive interpretation.
 */
export const PROHIBITED_CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Passwords
  "password",
  "passwd",
  "pwd",
  "passphrase",
  // Generic secrets
  "secret",
  "clientsecret",
  "secretkey",
  "credential",
  "credentials",
  // Tokens
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  // Keys
  "apikey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  // Transport credentials
  "connectionstring",
  "authorization",
  "proxyauthorization",
  "sessioncookie",
  "cookie",
  "setcookie",
]);

/**
 * Property names that carry whole request, response or message bodies. These
 * are prohibited by specification/privacy.md §2 from being captured
 * automatically, and a populated field with one of these names is evidence that
 * they were.
 */
export const RAW_PAYLOAD_FIELD_NAMES: ReadonlySet<string> = new Set([
  "requestbody",
  "responsebody",
  "rawrequest",
  "rawresponse",
  "httpbody",
  "messagepayload",
  "messagebody",
  "brokerpayload",
  "databaserow",
  "fullrecord",
]);

/**
 * Names that are not credentials by themselves but that make a high-entropy
 * value more suspicious. Used only to raise the confidence of the entropy rule
 * from `low` to `medium`; never to raise a finding on its own.
 */
export const SUSPICIOUS_FIELD_NAME_HINTS: ReadonlySet<string> = new Set([
  "token",
  "key",
  "secretvalue",
  "credentialvalue",
  "auth",
  "authvalue",
  "signature",
  "nonce",
  "salt",
  "seed",
  "apitoken",
  "accesskey",
  "secretaccesskey",
]);

/**
 * The names a property should be tested under.
 *
 * Extension keys are reverse-domain namespaced, so the field name is the final
 * dot-separated segment: `com.example.audit.password` names a password, and
 * normalizing the whole key would fold the namespace into it and hide that.
 * Both forms are therefore tested. Because matching stays exact, a key ending in
 * `.passwordPolicy` is still not a password.
 */
function candidateNames(name: string): string[] {
  const candidates = [normalizeFieldName(name)];

  const lastDot = name.lastIndexOf(".");
  if (lastDot > 0 && lastDot < name.length - 1) {
    candidates.push(normalizeFieldName(name.slice(lastDot + 1)));
  }

  return candidates;
}

function matchesAny(registry: ReadonlySet<string>, name: string): boolean {
  return candidateNames(name).some((candidate) => registry.has(candidate));
}

export function isProhibitedCredentialFieldName(name: string): boolean {
  return matchesAny(PROHIBITED_CREDENTIAL_FIELD_NAMES, name);
}

export function isRawPayloadFieldName(name: string): boolean {
  return matchesAny(RAW_PAYLOAD_FIELD_NAMES, name);
}

export function isSuspiciousFieldName(name: string): boolean {
  return matchesAny(SUSPICIOUS_FIELD_NAME_HINTS, name);
}
