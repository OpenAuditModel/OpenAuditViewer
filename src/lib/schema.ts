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
 * Errors are mapped through the same format-errors translation the CLI
 * uses, so an invalid file shows the same message and the same JSON Pointer
 * here as it does under `openauditmodel validate`.
 *
 * Ajv recurses the instance; a value nested a few thousand levels deep
 * overflows the stack. `JSON.parse` imposes no depth limit of its own, so a
 * hostile file CAN put such a value in front of the validator — the throw
 * is caught and reported as an ordinary validation failure instead of being
 * allowed to take down whichever caller happened to validate first.
 */
import validateFn from "../schema/validate.generated.js";
import { toIssues } from "./format-errors";
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
      return [{ path: "/", message: "structure is nested too deeply to validate" }];
    }
    return [
      {
        path: "/",
        message: `the validator failed unexpectedly: ${(cause as Error).message}`,
      },
    ];
  }
  if (valid) {
    return [];
  }
  return toIssues(validateFn.errors).map((issue) => ({
    path: issue.path,
    message: issue.detail === undefined ? issue.message : `${issue.message} (${issue.detail})`,
  }));
}
