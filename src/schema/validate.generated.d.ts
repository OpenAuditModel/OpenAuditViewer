import type { ErrorObject } from "ajv";

/** Precompiled validator for audit-event.schema.json. See tools/generate-validator.mjs. */
declare const validate: {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
};

export default validate;
export { validate };
