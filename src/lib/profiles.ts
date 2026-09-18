/**
 * The vendored profile registry.
 *
 * These are copies of the profile definitions published in the canonical
 * OpenAuditModel repository (profiles/<name>/profile.json), vendored at the
 * same time as src/schema/audit-event.schema.json and subject to the same
 * staleness caveat: if a profile changes upstream, these copies do not learn
 * about it until they are re-vendored. See src/schema/README.md.
 */
import type { ProfileDefinition } from "@openauditmodel/cli/conformance/profiles/types.js";

import apiAndIntegrationManagement from "../profiles/api-and-integration-management.json";
import backupAndRecovery from "../profiles/backup-and-recovery.json";
import customerAndAccountManagement from "../profiles/customer-and-account-management.json";
import deploymentAndChangeManagement from "../profiles/deployment-and-change-management.json";
import documentManagement from "../profiles/document-management.json";
import financialTransactionManagement from "../profiles/financial-transaction-management.json";
import identityAndAccessManagement from "../profiles/identity-and-access-management.json";
import incidentManagement from "../profiles/incident-management.json";
import messageBrokerManagement from "../profiles/message-broker-management.json";
import secretsAndKeyManagement from "../profiles/secrets-and-key-management.json";

/* JSON imports are typed structurally by TypeScript; the literal string fields
 * (severity, status) infer as plain `string`, so a cast through `unknown` is
 * unavoidable here. The definitions themselves are validated upstream against
 * profiles/profile-definition.schema.json before publication. */
const VENDORED_PROFILES = [
  apiAndIntegrationManagement,
  backupAndRecovery,
  customerAndAccountManagement,
  deploymentAndChangeManagement,
  documentManagement,
  financialTransactionManagement,
  identityAndAccessManagement,
  incidentManagement,
  messageBrokerManagement,
  secretsAndKeyManagement,
] as unknown as readonly ProfileDefinition[];

/**
 * The profile-definition version this build's engines implement.
 *
 * A profile declares the rule vocabulary it is written in. The engines read the
 * rule keys they know and ignore the rest, which is the right behaviour for a
 * tool that is never handed an unknown one — and the wrong behaviour for this
 * one, because a rule this build cannot evaluate contributes no requirement and
 * the event is then reported *conforming*. A viewer quietly more permissive
 * than the CLI is a defect even when its answer looks friendlier.
 *
 * So an unknown version is refused rather than partly evaluated, and the
 * refusal is shown rather than swallowed. The parity suite asserts this
 * constant against the pinned package's own profile-definition schema, so it
 * cannot drift from what the engines actually implement.
 */
export const SUPPORTED_PROFILE_VERSION = "0.1";

/** A vendored profile this build will not evaluate, and the version it declares. */
export interface RefusedProfile {
  readonly name: string;
  readonly profileVersion: string;
}

/** Splits definitions into the ones these engines implement and the ones they refuse. */
export function partitionProfiles(definitions: readonly ProfileDefinition[]): {
  readonly supported: readonly ProfileDefinition[];
  readonly refused: readonly RefusedProfile[];
} {
  const supported: ProfileDefinition[] = [];
  const refused: RefusedProfile[] = [];

  for (const definition of definitions) {
    if (definition.profileVersion === SUPPORTED_PROFILE_VERSION) {
      supported.push(definition);
    } else {
      refused.push({ name: definition.name, profileVersion: definition.profileVersion });
    }
  }

  return { supported, refused };
}

const partitioned = partitionProfiles(VENDORED_PROFILES);

/** The profiles this build evaluates. */
export const ALL_PROFILES: readonly ProfileDefinition[] = partitioned.supported;

/** The vendored profiles it refuses, for the panel to say so out loud. */
export const REFUSED_PROFILES: readonly RefusedProfile[] = partitioned.refused;

export { checkProfile } from "./engines";
export type {
  ProfileCheckResult,
  ProfileDefinition,
  ProfileFinding,
  ProfileStatus,
} from "@openauditmodel/cli/conformance/profiles/types.js";
