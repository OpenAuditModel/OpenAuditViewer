/**
 * The profile registry, read from the pinned package.
 *
 * These are the profile definitions the canonical repository publishes, taken
 * from `@openauditmodel/cli` at the version `package.json` pins exactly. They
 * used to be copies under `src/profiles/`, kept in step by a sync script and
 * watched by a test — which worked, and was a test guarding a class of drift
 * that importing the files removes outright. The engines and the documents
 * they evaluate now come from one release by construction, so split provenance
 * is not a thing that can happen and then be caught.
 *
 * Bundling still works offline: Vite resolves these at build time, the same as
 * any other import, and nothing is fetched at run time.
 */
import type { ProfileDefinition } from "@openauditmodel/cli/conformance/profiles/types.js";

import apiAndIntegrationManagement from "@openauditmodel/cli/profiles/api-and-integration-management/profile.json";
import backupAndRecovery from "@openauditmodel/cli/profiles/backup-and-recovery/profile.json";
import customerAndAccountManagement from "@openauditmodel/cli/profiles/customer-and-account-management/profile.json";
import deploymentAndChangeManagement from "@openauditmodel/cli/profiles/deployment-and-change-management/profile.json";
import documentManagement from "@openauditmodel/cli/profiles/document-management/profile.json";
import financialTransactionManagement from "@openauditmodel/cli/profiles/financial-transaction-management/profile.json";
import identityAndAccessManagement from "@openauditmodel/cli/profiles/identity-and-access-management/profile.json";
import incidentManagement from "@openauditmodel/cli/profiles/incident-management/profile.json";
import messageBrokerManagement from "@openauditmodel/cli/profiles/message-broker-management/profile.json";
import secretsAndKeyManagement from "@openauditmodel/cli/profiles/secrets-and-key-management/profile.json";

/* JSON imports are typed structurally by TypeScript; the literal string fields
 * (severity, status) infer as plain `string`, so a cast through `unknown` is
 * unavoidable here. The definitions themselves are validated upstream against
 * profiles/profile-definition.schema.json before publication. */
const PUBLISHED_PROFILES = [
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

/** A published profile this build will not evaluate, and the version it declares. */
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

const partitioned = partitionProfiles(PUBLISHED_PROFILES);

/** The profiles this build evaluates. */
export const ALL_PROFILES: readonly ProfileDefinition[] = partitioned.supported;

/** The published profiles it refuses, for the panel to say so out loud. */
export const REFUSED_PROFILES: readonly RefusedProfile[] = partitioned.refused;

export { checkProfile } from "./engines";
export type {
  ProfileCheckResult,
  ProfileDefinition,
  ProfileFinding,
  ProfileStatus,
} from "@openauditmodel/cli/conformance/profiles/types.js";
