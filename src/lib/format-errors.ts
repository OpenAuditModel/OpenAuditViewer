/**
 * Translation of raw JSON Schema validation errors into stable, human
 * readable issues.
 *
 * Ported verbatim from conformance/src/format-errors.ts (minus the unused
 * report renderer), so that the viewer shows the SAME message and the SAME
 * JSON Pointer for an invalid file as the CLI does — a `required` failure
 * points at the missing property itself, not its parent, and duplicates are
 * collapsed.
 */
import type { ErrorObject } from "ajv";

export interface ValidationIssue {
  /** JSON Pointer to the offending location inside the event. `/` is the event root. */
  readonly path: string;
  /** Human readable explanation of the failure. */
  readonly message: string;
  /** JSON Schema keyword that produced the failure. */
  readonly keyword: string;
  /** Additional context such as the allowed values or the expected pattern. */
  readonly detail?: string;
}

function paramsOf(error: ErrorObject): Record<string, unknown> {
  return (error.params ?? {}) as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Escapes a property name so that it is a legal JSON Pointer reference token. */
function pointerSegment(property: string): string {
  return property.replaceAll("~", "~0").replaceAll("/", "~1");
}

function joinPointer(base: string, property: string | undefined): string {
  const pointer = property === undefined ? base : `${base}/${pointerSegment(property)}`;
  return pointer === "" ? "/" : pointer;
}

function describe(error: ErrorObject): { message: string; detail?: string } {
  const params = paramsOf(error);
  const fallback = error.message ?? "failed validation";

  switch (error.keyword) {
    case "required":
      return { message: `missing required property "${String(params["missingProperty"])}"` };
    case "dependentRequired":
      return {
        message: `missing property "${String(params["missingProperty"])}", which is required when "${String(params["property"])}" is present`,
      };
    case "additionalProperties":
      return {
        message: `unknown property "${String(params["additionalProperty"])}" is not permitted here`,
        detail:
          "core objects reject unknown properties; use metadata, extensions or attributes instead",
      };
    case "propertyNames":
      return {
        message: `property name "${String(params["propertyName"])}" does not follow the required naming rule`,
      };
    case "enum": {
      const allowed = Array.isArray(params["allowedValues"])
        ? (params["allowedValues"] as unknown[]).map((value) => JSON.stringify(value)).join(", ")
        : undefined;
      return {
        message: "value is not one of the permitted values",
        ...(allowed === undefined ? {} : { detail: `allowed: ${allowed}` }),
      };
    }
    case "const":
      return {
        message: "value does not equal the required constant",
        detail: `expected: ${JSON.stringify(params["allowedValue"])}`,
      };
    case "pattern":
      return {
        message: "value does not match the required pattern",
        detail: `pattern: ${String(params["pattern"])}`,
      };
    case "format":
      return {
        message: `value is not a valid "${String(params["format"])}" value`,
      };
    case "if":
      return {
        message: "value does not satisfy a conditional requirement of the schema",
        detail: "see the accompanying issues for the specific requirement",
      };
    case "not":
      return { message: "value is explicitly forbidden by the schema" };
    default:
      return { message: fallback };
  }
}

/** Converts validator errors into issues, deduplicating identical entries. */
export function toIssues(errors: readonly ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];

  for (const error of errors) {
    const params = paramsOf(error);
    const base = error.instancePath;

    // `propertyNames` failures report the offending key either on the error
    // itself (for the nested constraint that failed) or in its parameters.
    const propertyName =
      asString((error as { propertyName?: unknown }).propertyName) ??
      (error.keyword === "propertyNames" ? asString(params["propertyName"]) : undefined);

    let path: string;
    if (error.keyword === "required" || error.keyword === "dependentRequired") {
      path = joinPointer(base, asString(params["missingProperty"]));
    } else if (error.keyword === "additionalProperties") {
      path = joinPointer(base, asString(params["additionalProperty"]));
    } else {
      path = joinPointer(base, propertyName);
    }

    const { message, detail } = describe(error);
    const key = `${path}|${error.keyword}|${message}|${detail ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    issues.push({
      path,
      message,
      keyword: error.keyword,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  return issues;
}
