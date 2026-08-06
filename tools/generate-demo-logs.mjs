/**
 * Generates the demo dataset under `demo-logs/`: mock audit logs from several
 * fictional applications, arranged so that every part of the viewer has
 * something to show — schema validation including deliberate failures,
 * privacy findings, sealed and deliberately broken integrity chains, profile
 * conformance and violations, change diffs, and shared trace/correlation ids.
 *
 * Every value in this data is invented. The credential-shaped strings are
 * chosen to be recognisable as fake (AWS's documented example key, "Fake-"
 * prefixes) so that a reader is never left wondering whether a real secret
 * was committed. Chains are sealed with the app's own digest code, so an
 * "intact" chain in the UI is a genuine RFC 8785 + SHA-256 verification
 * rather than a fixture that happens to match.
 *
 * Deterministic: fixed timestamps and identifiers, so regenerating produces
 * byte-identical files, and the self-checks at the end assert the dataset
 * still exercises what it claims to.
 *
 *   npm run demo-logs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calculateDigest } from "../src/lib/integrity/digest.ts";
import { parseFile } from "../src/lib/parse.ts";
import { verifyChains } from "../src/lib/integrity/chain.ts";
import { ALL_PROFILES, checkProfile } from "../src/lib/profiles/index.ts";

const OUT_DIR = join(import.meta.dirname, "..", "demo-logs");
mkdirSync(OUT_DIR, { recursive: true });

// Shared trace context: one trace flowing gateway -> payments -> notifier,
// and a second trace for a failed payment. 32 lowercase hex per W3C.
const TRACE_CHECKOUT = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const TRACE_FAILED_PAYMENT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const CORRELATION_CHECKOUT = "ord-2026-081234";
const CORRELATION_FAILED = "ord-2026-081299";

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `d3m0${String(idCounter).padStart(4, "0")}-aaaa-4bbb-8ccc-${String(idCounter).padStart(12, "0")}`;
}

function baseEvent(overrides) {
  return {
    specVersion: "0.1",
    id: nextId(),
    ...overrides,
  };
}

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Seals a chain in place: sets previousHash links, then hash per member. */
async function sealChain(events) {
  let previousHash;
  for (const event of events) {
    if (previousHash !== undefined) {
      event.integrity.previousHash = previousHash;
    }
    const hash = await calculateDigest(event, event.integrity.hashAlgorithm);
    event.integrity.hash = hash;
    previousHash = hash;
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. api-gateway.jsonl — API/integration profile: conforming + violating
// ---------------------------------------------------------------------------
const gateway = [
  baseEvent({
    time: "2026-08-05T09:12:04.101Z",
    event: {
      name: "api-key.create",
      category: "api-and-integration-management",
      outcome: "success",
      summary: "Partner API key issued for warehouse integration",
    },
    actor: { type: "user", id: "usr-ops-11", displayName: "Demo Operator" },
    resource: { type: "api-key", id: "key-7781", ownerId: "team-integrations" },
    application: { name: "api-gateway", environment: "production", version: "3.4.1" },
    authentication: { method: "mfa", mfa: true },
    authorization: { decision: "allow", policy: "integration-admin" },
    reason: { text: "Warehouse partner onboarding, ticket INT-2210" },
    request: { correlationId: "int-onboard-2210", traceId: TRACE_CHECKOUT },
    metadata: {
      integration: {
        type: "partner-api",
        credentialReference: "vault://keys/partner/7781",
        provider: "warehouse-co",
      },
    },
  }),
  baseEvent({
    time: "2026-08-05T09:14:22.480Z",
    event: {
      name: "api-key.rotate",
      category: "api-and-integration-management",
      outcome: "success",
      summary: "Scheduled rotation of billing export key",
    },
    actor: { type: "service", id: "svc-key-rotator" },
    resource: { type: "api-key", id: "key-5520" },
    application: { name: "api-gateway", environment: "production", version: "3.4.1" },
    authorization: { decision: "allow", policy: "rotation-schedule" },
    reason: { text: "90-day rotation policy" },
    metadata: {
      integration: { type: "internal", credentialReference: "vault://keys/billing/5520" },
    },
  }),
  // Violates INTEGRATION-REVOKE-001 (no reason) and INTEGRATION-KEY-001 (no
  // credentialReference) — shows red in the Profiles block.
  baseEvent({
    time: "2026-08-05T16:41:09.912Z",
    event: {
      name: "api-key.revoke",
      category: "api-and-integration-management",
      outcome: "success",
      summary: "Key revoked from admin console",
    },
    actor: { type: "admin", id: "usr-admin-3" },
    resource: { type: "api-key", id: "key-1093" },
    application: { name: "api-gateway", environment: "production", version: "3.4.1" },
    authentication: { method: "password", mfa: false },
    authorization: { decision: "allow" },
    metadata: { integration: { type: "partner-api" } },
  }),
  baseEvent({
    time: "2026-08-05T10:02:51.230Z",
    event: {
      name: "gateway.route.forward",
      category: "api-and-integration-management",
      outcome: "success",
      summary: "Checkout request routed to payments-api",
    },
    actor: { type: "service", id: "svc-gateway" },
    resource: { type: "route", id: "POST /v2/payments" },
    application: { name: "api-gateway", environment: "production", version: "3.4.1" },
    request: {
      correlationId: CORRELATION_CHECKOUT,
      traceId: TRACE_CHECKOUT,
      spanId: "1a2b3c4d5e6f7a8b",
      method: "POST",
      route: "/v2/payments",
      ipAddress: "203.0.113.40",
    },
  }),
  baseEvent({
    time: "2026-08-05T11:55:02.774Z",
    event: {
      name: "gateway.route.forward",
      category: "api-and-integration-management",
      outcome: "success",
      summary: "Payment retry routed to payments-api",
    },
    actor: { type: "service", id: "svc-gateway" },
    resource: { type: "route", id: "POST /v2/payments" },
    application: { name: "api-gateway", environment: "production", version: "3.4.1" },
    request: {
      correlationId: CORRELATION_FAILED,
      traceId: TRACE_FAILED_PAYMENT,
      spanId: "2b3c4d5e6f7a8b9c",
      method: "POST",
      route: "/v2/payments",
      ipAddress: "203.0.113.77",
    },
  }),
];

// ---------------------------------------------------------------------------
// 2. payments-api.jsonl — same traces continued, one failure with event.error
// ---------------------------------------------------------------------------
const payments = [
  baseEvent({
    time: "2026-08-05T10:02:51.412Z",
    event: {
      name: "authentication.login",
      category: "authentication",
      outcome: "success",
      summary: "Customer session established for checkout",
    },
    actor: { type: "user", id: "cust-88410" },
    resource: { type: "session", id: "sess-40917" },
    application: { name: "payments-api", environment: "production", version: "12.0.3" },
    authentication: { method: "oidc", provider: "login.example", mfa: true },
    request: {
      correlationId: CORRELATION_CHECKOUT,
      traceId: TRACE_CHECKOUT,
      spanId: "3c4d5e6f7a8b9c0d",
    },
  }),
  baseEvent({
    time: "2026-08-05T10:02:52.101Z",
    event: {
      name: "payment.authorization.request",
      category: "payment-processing",
      outcome: "success",
      summary: "Card authorization approved",
    },
    actor: { type: "user", id: "cust-88410" },
    resource: { type: "payment", id: "pay-303112" },
    application: { name: "payments-api", environment: "production", version: "12.0.3" },
    authorization: { decision: "allow", policy: "checkout-flow" },
    request: {
      correlationId: CORRELATION_CHECKOUT,
      traceId: TRACE_CHECKOUT,
      spanId: "4d5e6f7a8b9c0d1e",
    },
    metadata: { amount: { value: 249.9, currency: "EUR" }, processorReference: "psp-ref-99120" },
  }),
  baseEvent({
    time: "2026-08-05T10:02:53.309Z",
    event: {
      name: "payment.capture.execute",
      category: "payment-processing",
      outcome: "success",
      summary: "Capture settled",
    },
    actor: { type: "service", id: "svc-capture-worker" },
    resource: { type: "payment", id: "pay-303112" },
    application: { name: "payments-api", environment: "production", version: "12.0.3" },
    request: {
      correlationId: CORRELATION_CHECKOUT,
      traceId: TRACE_CHECKOUT,
      spanId: "5e6f7a8b9c0d1e2f",
    },
  }),
  baseEvent({
    time: "2026-08-05T11:55:03.001Z",
    event: {
      name: "payment.authorization.request",
      category: "payment-processing",
      outcome: "failure",
      summary: "Card authorization declined by issuer",
      error: {
        code: "issuer-declined",
        type: "card-declined",
        message: "Do not honor",
        retryable: true,
      },
    },
    actor: { type: "user", id: "cust-70233" },
    resource: { type: "payment", id: "pay-303544" },
    application: { name: "payments-api", environment: "production", version: "12.0.3" },
    authorization: { decision: "allow", policy: "checkout-flow" },
    request: {
      correlationId: CORRELATION_FAILED,
      traceId: TRACE_FAILED_PAYMENT,
      spanId: "6f7a8b9c0d1e2f3a",
    },
  }),
  baseEvent({
    time: "2026-08-05T11:55:04.560Z",
    event: {
      name: "payment.retry.schedule",
      category: "payment-processing",
      outcome: "success",
      summary: "Retry queued for declined authorization",
    },
    actor: { type: "service", id: "svc-retry-scheduler" },
    resource: { type: "payment", id: "pay-303544" },
    application: { name: "payments-api", environment: "production", version: "12.0.3" },
    request: {
      correlationId: CORRELATION_FAILED,
      traceId: TRACE_FAILED_PAYMENT,
      spanId: "7a8b9c0d1e2f3a4b",
    },
  }),
];

// ---------------------------------------------------------------------------
// 3. identity-service.jsonl — IAM profile: conforming (with diff) + violating
// ---------------------------------------------------------------------------
const identity = [
  // Fully conforming privileged role assignment: IAM-ROLE-001 + IAM-ROLE-002
  // satisfied, and change.before/after objects feed the diff view.
  baseEvent({
    time: "2026-08-05T08:30:11.007Z",
    event: {
      name: "identity.role.assign",
      category: "identity-and-access-management",
      outcome: "success",
      summary: "billing-admin granted to usr-4471",
    },
    actor: { type: "admin", id: "usr-iam-lead" },
    subject: { type: "user", id: "usr-4471" },
    resource: { type: "role", id: "billing-admin" },
    application: { name: "identity-service", environment: "production", version: "8.2.0" },
    authentication: { method: "mfa", mfa: true },
    authorization: { decision: "allow", policy: "iam-admin" },
    approval: {
      status: "approved",
      requestId: "ACC-1207",
      approvers: [{ type: "user", id: "usr-secops-1" }],
    },
    reason: { text: "Quarterly billing close requires elevated access", reference: "ACC-1207" },
    request: { correlationId: "iam-req-5590" },
    change: {
      type: "update",
      before: { roles: ["billing-viewer"], privileged: false, mfaEnforced: false },
      after: { roles: ["billing-viewer", "billing-admin"], privileged: true, mfaEnforced: true },
    },
    metadata: { role: { id: "billing-admin", privileged: true } },
  }),
  // Violates IAM-ROLE-001: no reason, no role metadata.
  baseEvent({
    time: "2026-08-05T13:12:44.870Z",
    event: {
      name: "identity.role.revoke",
      category: "identity-and-access-management",
      outcome: "success",
      summary: "contractor role removed",
    },
    actor: { type: "admin", id: "usr-iam-2" },
    subject: { type: "user", id: "usr-9021" },
    resource: { type: "role", id: "contractor-basic" },
    application: { name: "identity-service", environment: "production", version: "8.2.0" },
    authorization: { decision: "allow" },
  }),
  baseEvent({
    time: "2026-08-05T14:05:19.223Z",
    event: {
      name: "identity.user.disable",
      category: "identity-and-access-management",
      outcome: "success",
      summary: "Account disabled after offboarding",
    },
    actor: { type: "service", id: "svc-hr-sync" },
    subject: { type: "user", id: "usr-3318" },
    resource: { type: "user", id: "usr-3318" },
    application: { name: "identity-service", environment: "production", version: "8.2.0" },
    authorization: { decision: "allow", policy: "hr-lifecycle" },
    reason: { text: "Employment ended 2026-08-04", reference: "HR-88123" },
    change: {
      type: "update",
      before: { status: "active", sessions: 2 },
      after: { status: "disabled", sessions: 0 },
    },
    metadata: { user: { type: "employee" } },
  }),
  // Violates IAM-USER-002 (no reason) and IAM-USER-001 (no user.type).
  baseEvent({
    time: "2026-08-05T15:40:02.660Z",
    event: {
      name: "identity.user.delete",
      category: "identity-and-access-management",
      outcome: "success",
      summary: "Stale test account removed",
    },
    actor: { type: "admin", id: "usr-iam-2" },
    resource: { type: "user", id: "usr-test-77" },
    application: { name: "identity-service", environment: "production", version: "8.2.0" },
    authorization: { decision: "allow" },
  }),
  baseEvent({
    time: "2026-08-05T09:00:00.000Z",
    event: {
      name: "identity.credential.rotate",
      category: "identity-and-access-management",
      outcome: "success",
      summary: "Signing certificate rotated",
    },
    actor: { type: "service", id: "svc-cert-manager" },
    resource: { type: "credential", id: "cert-idp-2026" },
    application: { name: "identity-service", environment: "production", version: "8.2.0" },
    authorization: { decision: "allow", policy: "pki-rotation" },
    reason: { text: "Annual rotation window" },
    request: { correlationId: "pki-2026-rotation" },
    metadata: { credential: { type: "certificate" } },
  }),
];

// ---------------------------------------------------------------------------
// 4. docflow.jsonl — document profile: external share conforming + violating
// ---------------------------------------------------------------------------
const docflow = [
  baseEvent({
    time: "2026-08-05T10:20:33.145Z",
    event: {
      name: "document.share.create",
      category: "document-management",
      outcome: "success",
      summary: "Contract shared with external counsel",
    },
    actor: { type: "user", id: "usr-legal-4" },
    resource: {
      type: "document",
      id: "doc-20991",
      classification: "confidential",
      parentId: "folder-legal",
    },
    application: { name: "docflow", environment: "production", version: "5.9.2" },
    authorization: { decision: "allow", policy: "legal-share" },
    reason: { text: "External counsel review of supplier contract", reference: "LEG-501" },
    request: { correlationId: "leg-share-501" },
    metadata: {
      share: { recipientType: "external", permission: "read", expiresAt: "2026-09-05T00:00:00Z" },
    },
  }),
  // Violates DOC-SHARE-003: external share without reason or expiry.
  baseEvent({
    time: "2026-08-05T17:03:10.980Z",
    event: {
      name: "document.share.create",
      category: "document-management",
      outcome: "success",
      summary: "Folder shared externally from web UI",
    },
    actor: { type: "user", id: "usr-sales-12" },
    resource: { type: "document", id: "doc-31007", classification: "internal" },
    application: { name: "docflow", environment: "production", version: "5.9.2" },
    authorization: { decision: "allow" },
    metadata: { share: { recipientType: "external", permission: "read" } },
  }),
  baseEvent({
    time: "2026-08-05T11:11:41.037Z",
    event: {
      name: "document.version.rollback",
      category: "document-management",
      outcome: "success",
      summary: "Policy document rolled back to previous version",
    },
    actor: { type: "user", id: "usr-qa-2" },
    resource: { type: "document", id: "doc-8802", classification: "internal" },
    application: { name: "docflow", environment: "production", version: "5.9.2" },
    authorization: { decision: "allow" },
    reason: { text: "v14 published with wrong effective date" },
    change: {
      type: "restore",
      before: { versionId: "v14", effectiveDate: "2026-01-01", pages: 42 },
      after: { versionId: "v13", effectiveDate: "2026-06-01", pages: 41 },
    },
    metadata: { version: { id: "v13", previousId: "v14" } },
  }),
  baseEvent({
    time: "2026-08-05T12:45:59.512Z",
    event: {
      name: "document.file.delete",
      category: "document-management",
      outcome: "success",
      summary: "Draft removed by owner",
    },
    actor: { type: "user", id: "usr-eng-9" },
    resource: { type: "document", id: "doc-draft-112", classification: "internal" },
    application: { name: "docflow", environment: "production", version: "5.9.2" },
    authorization: { decision: "allow" },
    reason: { text: "Superseded by doc-draft-118" },
  }),
];

// ---------------------------------------------------------------------------
// 5. ops-desk.jsonl — incident-management profile, conforming and violating
// ---------------------------------------------------------------------------
const opsdesk = [
  baseEvent({
    time: "2026-08-05T22:14:08.404Z",
    event: {
      name: "incident.case.create",
      category: "incident-management",
      outcome: "success",
      summary: "Checkout latency incident opened",
    },
    actor: { type: "user", id: "usr-oncall-1" },
    resource: { type: "incident", id: "inc-2026-0455" },
    application: { name: "ops-desk", environment: "staging", version: "1.3.0" },
    authorization: { decision: "allow", policy: "responder" },
    request: { correlationId: CORRELATION_FAILED, traceId: TRACE_FAILED_PAYMENT },
    metadata: { incident: { status: "open", priority: "p2" } },
  }),
  baseEvent({
    time: "2026-08-06T01:02:47.918Z",
    event: {
      name: "incident.case.resolve",
      category: "incident-management",
      outcome: "success",
      summary: "Issuer connectivity restored",
    },
    actor: { type: "user", id: "usr-oncall-1" },
    resource: { type: "incident", id: "inc-2026-0455" },
    application: { name: "ops-desk", environment: "staging", version: "1.3.0" },
    authorization: { decision: "allow", policy: "responder" },
    reason: { text: "PSP confirmed fix on their edge" },
    change: {
      type: "update",
      before: { status: "open", assignee: "usr-oncall-1" },
      after: { status: "resolved", assignee: "usr-oncall-1" },
    },
    metadata: { incident: { status: "resolved", priority: "p2" } },
  }),
  // Violates INC-CORE-001: no authorization, no incident.status metadata.
  baseEvent({
    time: "2026-08-06T02:30:00.115Z",
    event: {
      name: "incident.priority.change",
      category: "incident-management",
      outcome: "success",
      summary: "Priority bumped from console",
    },
    actor: { type: "admin", id: "usr-mgr-5" },
    resource: { type: "incident", id: "inc-2026-0455" },
    application: { name: "ops-desk", environment: "staging", version: "1.3.0" },
  }),
];

// ---------------------------------------------------------------------------
// 6. config-chain.jsonl — an INTACT sealed chain (genesis, 8 events)
// ---------------------------------------------------------------------------
function configChainEvent(sequence, time, name, summary, extra = {}) {
  return baseEvent({
    time,
    event: { name, category: "configuration", outcome: "success", summary },
    actor: { type: "service", id: "svc-config-operator" },
    resource: { type: "configuration", id: "cluster-eu-1" },
    application: { name: "config-service", environment: "production", version: "2.1.0" },
    sequence,
    integrity: {
      canonicalization: "RFC8785",
      hashAlgorithm: "SHA-256",
      chainId: "cfg-eu1-2026-08",
    },
    ...extra,
  });
}

const configChain = await sealChain([
  configChainEvent(
    1,
    "2026-08-05T06:00:01.000Z",
    "config.baseline.publish",
    "Weekly baseline published",
  ),
  configChainEvent(
    2,
    "2026-08-05T06:15:22.310Z",
    "config.setting.update",
    "Connection pool raised",
    {
      change: { type: "update", before: { poolSize: 40 }, after: { poolSize: 64 } },
    },
  ),
  configChainEvent(3, "2026-08-05T07:02:09.774Z", "config.setting.update", "Timeout tightened", {
    change: { type: "update", before: { timeoutMs: 30000 }, after: { timeoutMs: 15000 } },
  }),
  configChainEvent(
    4,
    "2026-08-05T09:41:55.120Z",
    "config.feature-flag.enable",
    "New router enabled for 10%",
  ),
  configChainEvent(
    5,
    "2026-08-05T12:20:31.008Z",
    "config.feature-flag.update",
    "Rollout widened to 50%",
    {
      change: { type: "update", before: { rollout: 10 }, after: { rollout: 50 } },
    },
  ),
  configChainEvent(
    6,
    "2026-08-05T15:55:12.667Z",
    "config.feature-flag.update",
    "Rollout complete",
    {
      change: { type: "update", before: { rollout: 50 }, after: { rollout: 100 } },
    },
  ),
  configChainEvent(
    7,
    "2026-08-05T18:07:44.201Z",
    "config.secret-reference.update",
    "DB secret pointer moved",
  ),
  configChainEvent(
    8,
    "2026-08-05T23:59:59.999Z",
    "config.baseline.publish",
    "Nightly baseline sealed",
  ),
]);

// ---------------------------------------------------------------------------
// 7. billing-chain-broken.jsonl — sealed, then deliberately damaged:
//    seq 2 tampered after sealing (hash mismatch), seq 4 given a garbage
//    previousHash (broken link), seq 5 missing entirely (gap note).
// ---------------------------------------------------------------------------
function billingChainEvent(sequence, time, name, summary, extra = {}) {
  return baseEvent({
    time,
    event: { name, category: "billing", outcome: "success", summary },
    actor: { type: "service", id: "svc-billing-runner" },
    resource: { type: "billing-run", id: "run-2026-08-05" },
    application: { name: "billing-service", environment: "production", version: "7.7.1" },
    sequence,
    integrity: { canonicalization: "RFC8785", hashAlgorithm: "SHA-256", chainId: "bill-2026-08" },
    ...extra,
  });
}

const billingChain = await sealChain([
  billingChainEvent(
    1,
    "2026-08-05T03:00:00.000Z",
    "billing.run.start",
    "Nightly billing run started",
  ),
  billingChainEvent(
    2,
    "2026-08-05T03:04:11.220Z",
    "billing.invoice.issue",
    "Invoice batch A issued",
    {
      metadata: { invoiceCount: 1240, totalAmount: { value: 88410.5, currency: "EUR" } },
    },
  ),
  billingChainEvent(
    3,
    "2026-08-05T03:09:48.917Z",
    "billing.invoice.issue",
    "Invoice batch B issued",
    {
      metadata: { invoiceCount: 993, totalAmount: { value: 61102.25, currency: "EUR" } },
    },
  ),
  billingChainEvent(
    4,
    "2026-08-05T03:15:02.545Z",
    "billing.adjustment.apply",
    "Credit notes applied",
  ),
  billingChainEvent(6, "2026-08-05T03:21:40.030Z", "billing.run.complete", "Run completed"),
]);

// Damage AFTER sealing. This simulates what tampering actually looks like:
// the event says one thing, its sealed digest says another.
billingChain[1].metadata.totalAmount.value = 78410.5; // seq 2: content edited -> hash mismatch
billingChain[3].integrity.previousHash = "deadbeef".repeat(8); // seq 4: link no longer matches predecessor

// ---------------------------------------------------------------------------
// 8. sloppy-crm.jsonl — privacy findings festival (all values are fake)
// ---------------------------------------------------------------------------
function crmEvent(time, name, summary, extra = {}) {
  return baseEvent({
    time,
    event: { name, category: "customer-relationship-management", outcome: "success", summary },
    actor: { type: "user", id: "usr-crm-7" },
    resource: { type: "customer", id: "cust-5102" },
    application: { name: "sloppy-crm", environment: "production", version: "0.9.0-beta" },
    ...extra,
  });
}

const sloppyCrm = [
  crmEvent("2026-08-05T09:01:10.000Z", "customer.note.create", "Support note added", {
    metadata: { password: "Fake-Demo-Passw0rd-1" },
  }),
  crmEvent("2026-08-05T09:22:41.500Z", "customer.integration.sync", "CRM sync configured", {
    metadata: { awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE" },
  }),
  crmEvent("2026-08-05T10:15:33.808Z", "customer.billing.link", "Stripe account linked", {
    metadata: { integration: { apiKey: "sk_live_Fake4eC39HqLyjWDarjtT1zdp7dc" } },
  }),
  crmEvent("2026-08-05T11:40:02.117Z", "customer.export.run", "Nightly export executed", {
    metadata: {
      connectionString:
        "Server=db.internal;Database=crm;User Id=crm_admin;Password=Fake-Passw0rd-Demo",
    },
  }),
  crmEvent("2026-08-05T12:05:55.401Z", "customer.webhook.register", "Partner callback registered", {
    metadata: { callbackUrl: "https://svc-account:FakePass123@partner.example.com/hooks/42" },
  }),
  crmEvent("2026-08-05T13:30:19.223Z", "customer.session.debug", "Session debug snapshot", {
    metadata: {
      sessionToken:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vLXVzZXIiLCJpYXQiOjE3MjI5MzEyMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLWRlbW8tZGF0YQ",
    },
  }),
  crmEvent("2026-08-05T14:12:07.909Z", "customer.record.view", "Record opened from deep link", {
    request: { route: "/api/v1/customers/7f3c2a10-9b4e-4d2c-8a1f-5e6b7c8d9e0f/notes" },
  }),
  crmEvent("2026-08-05T15:00:00.000Z", "customer.record.update", "Address corrected", {
    change: { type: "update", before: { city: "Berlin" }, after: { city: "Potsdam" } },
  }),
];

// ---------------------------------------------------------------------------
// 9. monitoring.json — JSON array with schema-INVALID rows mixed in
// ---------------------------------------------------------------------------
const monitoring = [
  baseEvent({
    time: "2026-08-05T11:54:58.001Z",
    event: {
      name: "monitoring.alert.raise",
      category: "monitoring",
      outcome: "success",
      summary: "p95 latency above threshold on payments-api",
    },
    actor: { type: "system", id: "prom-alertmanager" },
    resource: { type: "alert", id: "alrt-90112" },
    application: { name: "monitoring-agent", environment: "production", version: "4.0.0" },
    request: { traceId: TRACE_FAILED_PAYMENT },
  }),
  // invalid: actor missing entirely
  {
    specVersion: "0.1",
    id: nextId(),
    time: "2026-08-05T11:56:10.220Z",
    event: { name: "monitoring.alert.clear", category: "monitoring", outcome: "success" },
    resource: { type: "alert", id: "alrt-90112" },
    application: { name: "monitoring-agent", environment: "production" },
  },
  // invalid: outcome outside the enum
  {
    specVersion: "0.1",
    id: nextId(),
    time: "2026-08-05T12:00:00.000Z",
    event: { name: "monitoring.heartbeat", category: "monitoring", outcome: "ok" },
    actor: { type: "system", id: "prom-alertmanager" },
    resource: { type: "agent", id: "agent-7" },
    application: { name: "monitoring-agent", environment: "production" },
  },
  baseEvent({
    time: "2026-08-06T00:41:12.760Z",
    event: {
      name: "monitoring.silence.create",
      category: "monitoring",
      outcome: "success",
      summary: "Silence during maintenance window",
    },
    actor: { type: "user", id: "usr-sre-3" },
    resource: { type: "silence", id: "sil-2231" },
    application: { name: "monitoring-agent", environment: "production", version: "4.0.0" },
    reason: { text: "Planned PSP failover test" },
  }),
];

// ---------------------------------------------------------------------------
// Write everything, then verify it against the app's own logic.
// ---------------------------------------------------------------------------
const files = {
  "api-gateway.jsonl": jsonl(gateway),
  "payments-api.jsonl": jsonl(payments),
  "identity-service.jsonl": jsonl(identity),
  "docflow.jsonl": jsonl(docflow),
  "ops-desk.jsonl": jsonl(opsdesk),
  "config-chain.jsonl": jsonl(configChain),
  "billing-chain-broken.jsonl": jsonl(billingChain),
  "sloppy-crm.jsonl": jsonl(sloppyCrm),
  "monitoring.json": JSON.stringify(monitoring, null, 2) + "\n",
};

for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(OUT_DIR, name), text, "utf8");
}

console.log(`\nwrote ${Object.keys(files).length} files to ${OUT_DIR}\n`);

// --- self-verification ------------------------------------------------------
function verdict(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

console.log("--- self-verification ---");
let totalRows = 0;
let totalFindings = 0;
for (const [name, text] of Object.entries(files)) {
  const rows = parseFile(name, text);
  totalRows += rows.length;
  const invalid = rows.filter((row) => !row.valid).length;
  const findings = rows.reduce((sum, row) => sum + row.privacyFindings.length, 0);
  totalFindings += findings;
  console.log(`  ${name}: ${rows.length} rows, ${invalid} invalid, ${findings} privacy findings`);
}

const monitoringRows = parseFile("monitoring.json", files["monitoring.json"]);
verdict(
  "monitoring.json has exactly 2 invalid rows",
  monitoringRows.filter((row) => !row.valid).length === 2,
);

const sloppyRows = parseFile("sloppy-crm.jsonl", files["sloppy-crm.jsonl"]);
const sloppyRules = new Set(
  sloppyRows.flatMap((row) => row.privacyFindings.map((finding) => finding.ruleId)),
);
verdict(
  "sloppy-crm trips credential/token/connection/URL rules",
  ["OAM-PRIV-001", "OAM-PRIV-011", "OAM-PRIV-015", "OAM-PRIV-040"].every((rule) =>
    sloppyRules.has(rule),
  ),
  [...sloppyRules].sort().join(","),
);
verdict(
  "sloppy-crm has exactly one clean event",
  sloppyRows.filter((row) => row.privacyFindings.length === 0).length === 1,
);

const goodReport = await verifyChains(configChain.map((event) => ({ label: event.id, event })));
verdict(
  "config chain verifies intact",
  goodReport.intact,
  JSON.stringify(goodReport.chains[0]?.findings),
);

const badReport = await verifyChains(billingChain.map((event) => ({ label: event.id, event })));
const badKinds = new Set(badReport.chains[0]?.findings.map((finding) => finding.kind));
verdict(
  "billing chain reports hash-mismatch AND broken-link",
  !badReport.intact && badKinds.has("hash-mismatch") && badKinds.has("broken-link"),
  [...badKinds].join(","),
);
verdict(
  "billing chain notes the sequence gap",
  badReport.chains[0]?.notes.some((note) => note.message.includes("not contiguous")) === true,
  JSON.stringify(badReport.chains[0]?.notes.map((note) => note.message)),
);

const iam = ALL_PROFILES.find((profile) => profile.name === "identity-and-access-management");
verdict(
  "conforming role assignment passes IAM profile",
  checkProfile(identity[0], "x", iam).status === "conforming",
  JSON.stringify(checkProfile(identity[0], "x", iam).errors),
);
verdict(
  "sloppy revoke violates IAM profile",
  checkProfile(identity[1], "x", iam).status === "violations",
);

const doc = ALL_PROFILES.find((profile) => profile.name === "document-management");
verdict(
  "external share with expiry conforms to DOC profile",
  checkProfile(docflow[0], "x", doc).status === "conforming",
);
verdict(
  "external share without expiry violates DOC profile",
  checkProfile(docflow[1], "x", doc).status === "violations",
);

console.log(`\ntotal: ${totalRows} mock rows, ${totalFindings} privacy findings\ndone`);
