/**
 * Validates a parsed event against the vendored canonical OpenAuditModel
 * schema. See src/schema/README.md for provenance.
 *
 * The validator is PRECOMPILED at build time (tools/generate-validator.mjs)
 * rather than compiled from the schema at startup. Ajv builds validators
 * with `new Function`, which the app's Content-Security-Policy forbids —
 * and weakening the policy to allow runtime code generation, in an app
 * whose whole job is opening untrusted files, would be the wrong trade.
 * Precompiling also keeps the Ajv compiler out of the shipped bundle.
 *
 * Errors are mapped through the same format-errors translation the CLI uses and
 * are returned in the same shape, so an invalid file reports the same JSON
 * Pointer, the same wording and the same detail here as it does under
 * `openauditmodel validate`. How an issue is laid out on screen is the detail
 * panel's business, not this function's: narrowing it here is what made the two
 * disagree in the first place.
 *
 * Ajv recurses the instance; a value nested a few thousand levels deep
 * overflows the stack. `JSON.parse` imposes no depth limit of its own, so a
 * hostile file CAN put such a value in front of the validator — the throw
 * is caught and reported as an ordinary validation failure instead of being
 * allowed to take down whichever caller happened to validate first.
 */
import validateFn from "../schema/validate.generated.js";
import { toIssues } from "@openauditmodel/cli/conformance/format-errors.js";
import type { ValidationIssue } from "./types";

export function validateEvent(event: unknown): ValidationIssue[] {
  let valid: boolean;
  try {
    valid = validateFn(event);
  } catch (cause) {
    // Only a stack overflow is attributable to the document. Anything else
    // is a defect in this app, and saying "nested too deeply" about it would
    // send whoever reads the report looking at their data instead of at us.
    if (cause instanceof RangeError) {
      return [
        { path: "/", message: "structure is nested too deeply to validate", keyword: "reader" },
      ];
    }
    return [
      {
        path: "/",
        message: `the validator failed unexpectedly: ${(cause as Error).message}`,
        keyword: "reader",
      },
    ];
  }
  if (valid) {
    return [];
  }
  return toIssues(validateFn.errors);
}
