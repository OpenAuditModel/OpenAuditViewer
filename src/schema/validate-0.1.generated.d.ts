import type { ErrorObject } from "ajv";

/** Precompiled validator for audit-event schema 0.1. See tools/generate-validator.mjs. */
declare const validate: {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
};

export default validate;
export { validate };
