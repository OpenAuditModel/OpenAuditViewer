/**
 * Privacy linting of a single audit event.
 *
 * Ported from conformance/src/privacy/lint-event.ts, adapted only in how
 * schema validation is invoked: the original takes an injectable
 * `EventValidator`, since the CLI validates against whatever schema path the
 * caller resolved. This app has exactly one schema (src/schema/), so it calls
 * `validateEvent` from ../schema directly instead of threading a validator
 * through every call site.
 *
 * The linter is deterministic, local and read-only. It resolves nothing,
 * fetches nothing, opens no referenced file, sends nothing anywhere and never
 * modifies or redacts an event. It reports suspicions about the values it was
 * given. No finding ever carries the value that produced it.
 */
import { validateEvent as validateAgainstSchema } from "../schema";
import {
  isProhibitedCredentialFieldName,
  isRawPayloadFieldName,
  isSuspiciousFieldName,
} from "./field-names";
import { isHighEntropyTokenCandidate } from "./entropy";
import { isRedactionPlaceholder } from "./safe-formats";
import {
  containsPrivateKeyMaterial,
  matchKnownTokenFormat,
  matchesAuthorizationHeader,
} from "./token-patterns";
import { analyzeConnectionString, analyzeUrl, isDataSystemScheme } from "./url-analysis";
import { exceededSignals, profileValue } from "./size-analysis";
import { ALL_RULES, RULES, type RuleDefinition } from "./rules";
import { readPath, traverse } from "./traverse";
import { SEVERITY_ORDER, type EventLintResult, type PrivacyFinding } from "./types";

export interface LintOptions {
  /** Validate against the canonical schema first. Defaults to true. */
  readonly validateSchema?: boolean;
}

interface Root {
  readonly path: string;
  readonly value: unknown;
}

function deepRoots(event: unknown): Root[] {
  const roots: Root[] = [];
  const add = (path: string, value: unknown): void => {
    if (value !== undefined) {
      roots.push({ path, value });
    }
  };

  add("/metadata", readPath(event, ["metadata"]));
  add("/extensions", readPath(event, ["extensions"]));
  add("/actor/attributes", readPath(event, ["actor", "attributes"]));
  add("/subject/attributes", readPath(event, ["subject", "attributes"]));
  add("/resource/attributes", readPath(event, ["resource", "attributes"]));
  add("/change/before", readPath(event, ["change", "before"]));
  add("/change/after", readPath(event, ["change", "after"]));

  const related = readPath(event, ["relatedResources"]);
  if (Array.isArray(related)) {
    for (const [index, entry] of related.entries()) {
      add(`/relatedResources/${index}/attributes`, readPath(entry, ["attributes"]));
    }
  }

  return roots;
}

function scalarLocations(event: unknown): Root[] {
  const locations: Root[] = [];
  const add = (path: string, value: unknown): void => {
    if (typeof value === "string") {
      locations.push({ path, value });
    }
  };

  add("/event/summary", readPath(event, ["event", "summary"]));
  add("/event/error/message", readPath(event, ["event", "error", "message"]));
  add("/reason/text", readPath(event, ["reason", "text"]));
  add("/reason/reference", readPath(event, ["reason", "reference"]));
  add("/request/route", readPath(event, ["request", "route"]));
  add("/authorization/reason", readPath(event, ["authorization", "reason"]));
  add("/delegation/reason", readPath(event, ["delegation", "reason"]));

  return locations;
}

function sizeRoots(event: unknown): Root[] {
  return deepRoots(event).filter((root) => root.value !== null && typeof root.value === "object");
}

function evidenceReferences(event: unknown): Root[] {
  const evidence = readPath(event, ["evidence"]);
  if (!Array.isArray(evidence)) {
    return [];
  }

  const references: Root[] = [];
  for (const [index, entry] of evidence.entries()) {
    const reference = readPath(entry, ["reference"]);
    if (typeof reference === "string") {
      references.push({ path: `/evidence/${index}/reference`, value: reference });
    }
  }
  return references;
}

/**
 * True when a value under a credential-named property is itself a credential.
 * A **scalar** under a name like `password` is the credential; a
 * **container** is a descriptor and is traversed instead of flagged whole.
 */
function isCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !isRedactionPlaceholder(value);
  }
  return typeof value === "number";
}

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") {
    return false;
  }
  if (typeof value === "string") {
    return !isRedactionPlaceholder(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function finding(rule: RuleDefinition, path: string, overrides: Partial<PrivacyFinding> = {}) {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    confidence: rule.confidence,
    category: rule.category,
    path,
    message: rule.message,
    recommendation: rule.recommendation,
    ...overrides,
  } satisfies PrivacyFinding;
}

const RULES_BY_ID = new Map(ALL_RULES.map((rule) => [rule.id, rule]));

function valueFindings(value: string, path: string, key: string | undefined): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  if (matchesAuthorizationHeader(value)) {
    findings.push(finding(RULES.AUTHORIZATION_HEADER_VALUE, path));
  }

  if (containsPrivateKeyMaterial(value)) {
    findings.push(finding(RULES.PRIVATE_KEY_MATERIAL, path));
  }

  const tokenRuleId = matchKnownTokenFormat(value);
  if (tokenRuleId !== undefined) {
    const rule = RULES_BY_ID.get(tokenRuleId);
    if (rule !== undefined) {
      findings.push(finding(rule, path));
    }
  }

  const connection = analyzeConnectionString(value);
  if (connection === "credentialed") {
    findings.push(finding(RULES.CONNECTION_STRING_WITH_CREDENTIALS, path));
  } else if (connection === "uncredentialed") {
    findings.push(finding(RULES.CONNECTION_STRING_WITHOUT_CREDENTIALS, path));
  }

  const url = analyzeUrl(value);
  if (url?.hasUserinfo === true && !isDataSystemScheme(url.scheme)) {
    findings.push(finding(RULES.URL_USERINFO, path));
  }

  if (findings.length === 0 && isHighEntropyTokenCandidate(value)) {
    findings.push(
      finding(RULES.HIGH_ENTROPY_TOKEN_CANDIDATE, path, {
        confidence: key !== undefined && isSuspiciousFieldName(key) ? "medium" : "low",
      }),
    );
  }

  return findings;
}

function nameFindings(key: string, value: unknown, path: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  if (isProhibitedCredentialFieldName(key) && isCredentialValue(value)) {
    findings.push(finding(RULES.PROHIBITED_CREDENTIAL_FIELD, path));
  }
  if (isRawPayloadFieldName(key) && isPopulated(value)) {
    findings.push(finding(RULES.RAW_PAYLOAD_FIELD, path));
  }

  return findings;
}

function evidenceFindings(value: string, path: string): PrivacyFinding[] {
  const url = analyzeUrl(value);

  if (url !== undefined) {
    if (url.hasQuery || url.hasFragment) {
      return [finding(RULES.EVIDENCE_REFERENCE_QUERY, path)];
    }
    return [];
  }

  if (value.includes("?") || value.includes("#")) {
    return [finding(RULES.EVIDENCE_REFERENCE_QUERY, path)];
  }
  return [];
}

function severityRank(finding: PrivacyFinding): number {
  const index = SEVERITY_ORDER.indexOf(finding.severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Lints one event and returns its findings, most severe first. */
export function lintEvent(
  event: unknown,
  label: string,
  options: LintOptions = {},
): EventLintResult {
  const eventId =
    typeof readPath(event, ["id"]) === "string" ? (readPath(event, ["id"]) as string) : undefined;
  const identity = eventId === undefined ? {} : { eventId };

  if (options.validateSchema !== false) {
    const issues = validateAgainstSchema(event);
    if (issues.length > 0) {
      const shown = issues.slice(0, 5).map((issue) => `${issue.path}  ${issue.message}`);
      return {
        label,
        ...identity,
        status: "schema-invalid",
        findings: [],
        schemaIssues:
          issues.length > shown.length
            ? [...shown, `and ${issues.length - shown.length} further schema issues`]
            : shown,
      };
    }
  }

  const collected: PrivacyFinding[] = [];

  for (const root of deepRoots(event)) {
    traverse(root.value, root.path, ({ path, key, value }) => {
      if (key !== undefined) {
        collected.push(...nameFindings(key, value, path));
      }
      if (typeof value === "string") {
        collected.push(...valueFindings(value, path, key));
      }
    });
  }

  for (const location of scalarLocations(event)) {
    collected.push(...valueFindings(location.value as string, location.path, undefined));
  }

  for (const reference of evidenceReferences(event)) {
    collected.push(...evidenceFindings(reference.value as string, reference.path));
    collected.push(...valueFindings(reference.value as string, reference.path, undefined));
  }

  for (const root of sizeRoots(event)) {
    const signals = exceededSignals(profileValue(root.value));
    if (signals.length > 0) {
      collected.push(
        finding(RULES.OVERSIZED_UNFILTERED_VALUE, root.path, {
          message: `${RULES.OVERSIZED_UNFILTERED_VALUE.message} Signals: ${signals.join("; ")}.`,
        }),
      );
    }
  }

  const seen = new Set<string>();
  const findings = collected
    .filter((entry) => {
      const key = `${entry.ruleId}|${entry.path}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((entry) => ({ ...entry, ...identity }))
    .sort((left, right) => {
      const bySeverity = severityRank(left) - severityRank(right);
      if (bySeverity !== 0) {
        return bySeverity;
      }
      const byPath = left.path.localeCompare(right.path, "en");
      return byPath === 0 ? left.ruleId.localeCompare(right.ruleId, "en") : byPath;
    });

  return {
    label,
    ...identity,
    status: findings.length === 0 ? "clean" : "findings",
    findings,
    schemaIssues: [],
  };
}
