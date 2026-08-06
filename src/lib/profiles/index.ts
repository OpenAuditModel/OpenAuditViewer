/**
 * The vendored profile registry.
 *
 * These are copies of the profile definitions published in the canonical
 * OpenAuditModel repository (profiles/<name>/profile.json), vendored at the
 * same time as src/schema/audit-event.schema.json and subject to the same
 * staleness caveat: if a profile changes upstream, these copies do not learn
 * about it until they are re-vendored. See src/schema/README.md.
 */
import type { ProfileDefinition } from "./types";

import apiAndIntegrationManagement from "../../profiles/api-and-integration-management.json";
import backupAndRecovery from "../../profiles/backup-and-recovery.json";
import customerAndAccountManagement from "../../profiles/customer-and-account-management.json";
import deploymentAndChangeManagement from "../../profiles/deployment-and-change-management.json";
import documentManagement from "../../profiles/document-management.json";
import financialTransactionManagement from "../../profiles/financial-transaction-management.json";
import identityAndAccessManagement from "../../profiles/identity-and-access-management.json";
import incidentManagement from "../../profiles/incident-management.json";
import messageBrokerManagement from "../../profiles/message-broker-management.json";
import secretsAndKeyManagement from "../../profiles/secrets-and-key-management.json";

/* JSON imports are typed structurally by TypeScript; the literal string fields
 * (severity, status) infer as plain `string`, so a cast through `unknown` is
 * unavoidable here. The definitions themselves are validated upstream against
 * profiles/profile-definition.schema.json before publication. */
export const ALL_PROFILES: readonly ProfileDefinition[] = [
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

export { checkProfile } from "./check-profile";
export type { ProfileCheckResult, ProfileDefinition, ProfileFinding, ProfileStatus } from "./types";
