/**
 * The v0.1 privacy rule catalogue.
 *
 * Severity and confidence are properties of the rule, not of an individual
 * finding, so that a report can be filtered predictably. Severity says how bad
 * the risk would be if the suspicion is correct; confidence says how likely the
 * suspicion is to be correct. They are deliberately independent: a field
 * literally named `password` is critical and high-confidence, while a
 * high-entropy string in an arbitrary field is medium and low-confidence.
 *
 * Thresholds and vocabularies are hard-coded in v0.1. Configuration is a future
 * design question; see decisions/0007-deterministic-privacy-linting.md.
 */
import type { Confidence, Severity } from "./types";

export interface RuleDefinition {
  readonly id: string;
  readonly name: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly category: string;
  readonly message: string;
  readonly recommendation: string;
}

function rule(definition: RuleDefinition): RuleDefinition {
  return definition;
}

export const RULES = {
  PROHIBITED_CREDENTIAL_FIELD: rule({
    id: "OAM-PRIV-001",
    name: "prohibited-credential-field",
    severity: "critical",
    confidence: "high",
    category: "credential-field-name",
    message: "A property name associated with credentials carries a non-empty value.",
    recommendation:
      "Remove the value. Record only the fact of the operation, or a non-sensitive identifier for the credential.",
  }),

  AUTHORIZATION_HEADER_VALUE: rule({
    id: "OAM-PRIV-002",
    name: "authorization-header-value",
    severity: "critical",
    confidence: "high",
    category: "credential-shaped-value",
    message: "A value is shaped like an authorization header credential.",
    recommendation:
      "Never record authorization headers. Record the authentication method and outcome instead.",
  }),

  PRIVATE_KEY_MATERIAL: rule({
    id: "OAM-PRIV-003",
    name: "private-key-material",
    severity: "critical",
    confidence: "high",
    category: "credential-shaped-value",
    message: "A value contains a marker used by private key material.",
    recommendation:
      "Remove the key material. Record a key identifier that cannot be used to reconstruct the key.",
  }),

  JWT_TOKEN: rule({
    id: "OAM-PRIV-010",
    name: "jwt-token",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message:
      "A value is structured as a JSON Web Token: three segments whose header and payload decode to JSON objects.",
    recommendation:
      "Remove the token. Record the subject identifier and the authentication method instead. Validity was not checked.",
  }),

  AWS_ACCESS_KEY_ID: rule({
    id: "OAM-PRIV-011",
    name: "aws-access-key-id",
    severity: "high",
    confidence: "high",
    category: "known-token-format",
    message:
      "A value matches the published shape of a cloud access key identifier. An identifier alone is not a complete credential.",
    recommendation:
      "Remove the identifier, or record a non-sensitive reference to the principal it belongs to.",
  }),

  GITHUB_TOKEN: rule({
    id: "OAM-PRIV-012",
    name: "github-token",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message: "A value matches a published personal access token prefix.",
    recommendation: "Remove the token and rotate it. Validity was not checked.",
  }),

  GITLAB_TOKEN: rule({
    id: "OAM-PRIV-013",
    name: "gitlab-token",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message: "A value matches a published personal access token prefix.",
    recommendation: "Remove the token and rotate it. Validity was not checked.",
  }),

  SLACK_TOKEN: rule({
    id: "OAM-PRIV-014",
    name: "slack-token",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message: "A value matches a published messaging platform token prefix.",
    recommendation: "Remove the token and rotate it. Validity was not checked.",
  }),

  PAYMENT_SECRET_KEY: rule({
    id: "OAM-PRIV-015",
    name: "payment-secret-key",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message: "A value matches a published secret API key prefix.",
    recommendation: "Remove the key and rotate it. Validity was not checked.",
  }),

  CLOUD_API_KEY: rule({
    id: "OAM-PRIV-016",
    name: "cloud-api-key",
    severity: "critical",
    confidence: "high",
    category: "known-token-format",
    message: "A value matches a published API key prefix.",
    recommendation: "Remove the key and rotate it. Validity was not checked.",
  }),

  URL_USERINFO: rule({
    id: "OAM-PRIV-030",
    name: "url-userinfo",
    severity: "critical",
    confidence: "high",
    category: "url",
    message: "A URL embeds user information, which commonly carries a password.",
    recommendation:
      "Remove the credentials from the URL. Record the location without any embedded user information.",
  }),

  EVIDENCE_REFERENCE_QUERY: rule({
    id: "OAM-PRIV-031",
    name: "evidence-reference-query",
    severity: "medium",
    confidence: "medium",
    category: "url",
    message:
      "An evidence reference carries a query string or fragment, which may hold signed access parameters, identifiers or search terms.",
    recommendation:
      "Store a stable, access-controlled reference without embedded parameters. A query string is not always sensitive; review this one.",
  }),

  CONNECTION_STRING_WITH_CREDENTIALS: rule({
    id: "OAM-PRIV-040",
    name: "connection-string-with-credentials",
    severity: "critical",
    confidence: "high",
    category: "connection-string",
    message: "A value is shaped like a connection string that carries a password.",
    recommendation: "Remove the connection string and rotate the credential it exposes.",
  }),

  CONNECTION_STRING_WITHOUT_CREDENTIALS: rule({
    id: "OAM-PRIV-041",
    name: "connection-string-without-credentials",
    severity: "low",
    confidence: "medium",
    category: "connection-string",
    message:
      "A value is shaped like a connection string. No credential was detected in it; it may still disclose internal infrastructure.",
    recommendation:
      "Record a logical name for the system rather than a connection string. This is not reported as a credential.",
  }),

  HIGH_ENTROPY_TOKEN_CANDIDATE: rule({
    id: "OAM-PRIV-050",
    name: "high-entropy-token-candidate",
    severity: "medium",
    confidence: "low",
    category: "heuristic",
    message:
      "A value is long, has no whitespace and has high character entropy, which is consistent with a token or key.",
    recommendation:
      "Confirm what this value is. Many high-entropy values are legitimate identifiers; this rule is a heuristic and is expected to produce false positives.",
  }),

  OVERSIZED_UNFILTERED_VALUE: rule({
    id: "OAM-PRIV-060",
    name: "oversized-unfiltered-value",
    severity: "medium",
    confidence: "medium",
    category: "minimization",
    message: "A value is large enough to suggest that an object was captured rather than selected.",
    recommendation:
      "Record the fields the audit purpose requires. Prefer changed field names, hashes or references over whole objects.",
  }),

  RAW_PAYLOAD_FIELD: rule({
    id: "OAM-PRIV-061",
    name: "raw-payload-field",
    severity: "high",
    confidence: "high",
    category: "minimization",
    message:
      "A property name associated with raw request, response or message bodies is populated.",
    recommendation:
      "Do not capture whole payloads. Record selected, named fields, or a reference to the payload held under its own controls.",
  }),
} as const satisfies Record<string, RuleDefinition>;

/** Every rule, ordered by identifier, for documentation and tests. */
export const ALL_RULES: readonly RuleDefinition[] = Object.values(RULES).sort((left, right) =>
  left.id.localeCompare(right.id, "en"),
);
