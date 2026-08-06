/**
 * Rule evaluation.
 *
 * Ported verbatim from conformance/src/profiles/evaluate-rule.ts.
 *
 * Evaluation reads values and compares them. It never executes anything from a
 * profile definition, never builds a function, never interprets an expression
 * and never reaches outside the event it was given. Every check below is a
 * presence test, a JSON type test or a strict scalar equality.
 */
import {
  concatPointer,
  isPresent,
  matchesMetadataType,
  jsonTypeOf,
  resolvePointer,
} from "./resolve-pointer";
import type { Condition, ProfileFinding, ProfileRule, RuleSeverity } from "./types";

const METADATA_POINTER = "/metadata";

/** Default severity for a rule that does not declare one. */
export const DEFAULT_RULE_SEVERITY: RuleSeverity = "error";

/**
 * Whether a rule's condition holds.
 *
 * A condition is one path compared for equality against one scalar. When the
 * path is absent the condition does **not** hold, so a conditional requirement
 * contributes nothing rather than firing on missing data. That is deterministic
 * and it is also the safer direction: a profile that demanded approval whenever
 * it could not tell whether a role was privileged would fail every event that
 * omitted the flag, including events the rule was never meant to govern.
 */
export function conditionHolds(event: unknown, condition: Condition): boolean {
  const resolved = resolvePointer(event, condition.path);
  if (!resolved.found) {
    return false;
  }
  return Object.is(resolved.value, condition.equals);
}

function finding(
  ruleId: string,
  path: string,
  message: string,
  severity: RuleSeverity,
): ProfileFinding {
  return { ruleId, path, message, severity };
}

export interface RuleEvaluation {
  readonly applied: boolean;
  readonly errors: readonly ProfileFinding[];
  readonly warnings: readonly ProfileFinding[];
}

/**
 * Evaluates one rule against one event.
 *
 * `applied` is false when the rule's condition did not hold; the rule still
 * counts as matched, because it governs the event, but it contributed no
 * requirements.
 */
export function evaluateRule(event: unknown, rule: ProfileRule): RuleEvaluation {
  if (rule.when !== undefined && !conditionHolds(event, rule.when)) {
    return { applied: false, errors: [], warnings: [] };
  }

  const severity = rule.severity ?? DEFAULT_RULE_SEVERITY;
  const failures: ProfileFinding[] = [];
  const warnings: ProfileFinding[] = [];

  for (const pointer of rule.requiredPaths ?? []) {
    if (!isPresent(resolvePointer(event, pointer))) {
      failures.push(
        finding(rule.id, pointer, "required by the profile, but absent or empty", severity),
      );
    }
  }

  for (const requirement of rule.requiredMetadata ?? []) {
    const pointer = concatPointer(METADATA_POINTER, requirement.path);
    const resolved = resolvePointer(event, pointer);

    if (!isPresent(resolved)) {
      failures.push(
        finding(
          rule.id,
          pointer,
          `required metadata of type "${requirement.type}", but absent or empty`,
          severity,
        ),
      );
      continue;
    }

    if (!matchesMetadataType(resolved.value, requirement.type)) {
      failures.push(
        finding(
          rule.id,
          pointer,
          `required metadata must be of type "${requirement.type}", but is "${jsonTypeOf(resolved.value)}"`,
          severity,
        ),
      );
    }
  }

  for (const requirement of rule.requiredValues ?? []) {
    const resolved = resolvePointer(event, requirement.path);

    if (!resolved.found) {
      failures.push(
        finding(
          rule.id,
          requirement.path,
          `required by the profile to equal ${JSON.stringify(requirement.equals)}, but absent`,
          severity,
        ),
      );
      continue;
    }

    if (!Object.is(resolved.value, requirement.equals)) {
      // The expected value comes from the profile definition, not from the
      // event, so quoting it discloses nothing about the event.
      failures.push(
        finding(
          rule.id,
          requirement.path,
          `required by the profile to equal ${JSON.stringify(requirement.equals)}`,
          severity,
        ),
      );
    }
  }

  for (const pointer of rule.recommendedPaths ?? []) {
    if (!isPresent(resolvePointer(event, pointer))) {
      warnings.push(
        finding(rule.id, pointer, "recommended by the profile, but absent or empty", "warning"),
      );
    }
  }

  // A rule declared `info` or `warning` cannot fail conformance; its
  // requirement violations are reported alongside the recommendations.
  if (severity === "error") {
    return { applied: true, errors: failures, warnings };
  }
  return { applied: true, errors: [], warnings: [...failures, ...warnings] };
}
