// Mirrors src-tauri/src/healing/model.rs (serde camelCase / SCREAMING_SNAKE_CASE).

export type IncidentStatus =
  | "DETECTED"
  | "ANALYZING"
  | "PROPOSAL_READY"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFYING"
  | "HEALED"
  | "FAILED"
  | "REJECTED"
  | "EXPIRED"
  | "STALE"
  | "ROLLBACK_PROPOSED"
  | "ROLLED_BACK"
  | "MANUAL_INTERVENTION_REQUIRED";

export type Severity = "INFO" | "WARNING" | "CRITICAL";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ClusterBinding {
  context: string;
  clusterName: string;
  server: string;
}

export interface ResourceRef {
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
}

export type HealingAction =
  | { type: "RESTART_POD"; namespace: string; pod: string }
  | { type: "ROLLOUT_RESTART"; namespace: string; kind: string; name: string }
  | { type: "ROLLBACK_DEPLOYMENT"; namespace: string; name: string; to_revision: number }
  | { type: "SCALE_DEPLOYMENT"; namespace: string; name: string; replicas: number }
  | { type: "SCALE_STATEFULSET"; namespace: string; name: string; replicas: number }
  | { type: "PATCH_WORKLOAD"; namespace: string; kind: string; name: string; container: string; changes: WorkloadPatch };

export interface ProbeChange {
  initial_delay_seconds?: number;
  period_seconds?: number;
  timeout_seconds?: number;
  failure_threshold?: number;
  success_threshold?: number;
}

export interface WorkloadPatch {
  liveness_probe?: ProbeChange;
  readiness_probe?: ProbeChange;
  startup_probe?: ProbeChange;
  resources?: { requests_cpu?: string; requests_memory?: string; limits_cpu?: string; limits_memory?: string };
  termination_grace_period_seconds?: number;
  pre_stop_sleep_seconds?: number;
  image_tag?: string;
}

export interface DryRunResult {
  ok: boolean;
  error: string | null;
  changes: { path: string; before: string; after: string }[];
}

export interface ChatMessage {
  id: string;
  role: "OPERATOR" | "ASSISTANT";
  text: string;
  at: number;
  suggestedAction: HealingAction | null;
  suggestionError: string | null;
  gitopsSuggestion: string | null;
  riskLevel: RiskLevel | null;
  confidence: number | null;
  evidence: string[];
  model: string | null;
  proposalId: string | null;
}

export interface StateSnapshot {
  replicas: number | null;
  revision: number | null;
  generation: number | null;
  images: string[];
  ready: string | null;
}

export interface OperatorIdentity {
  kind: string;
  osUser: string;
  kubernetesUser: string | null;
}

export type ProposalSource =
  | { type: "ai"; provider: string; model: string | null }
  | { type: "rollbackOfExecution"; execution_id: string };

export interface HealingProposal {
  id: string;
  incidentId: string;
  kind: "REMEDIATION" | "ROLLBACK";
  binding: ClusterBinding;
  action: HealingAction;
  risk: RiskLevel;
  rationale: string;
  evidence: string[];
  expectedImpact: string;
  verificationSteps: string[];
  rollbackPlan: string;
  confidence: number | null;
  source: ProposalSource;
  baseline: { uid: string; generation: number | null; observed: Record<string, string> };
  currentState: StateSnapshot;
  proposedState: StateSnapshot;
  verificationTarget: { kind: string; namespace: string; name: string; expectedReplicas: number | null };
  gitopsOwner: string | null;
  blockedReason: string | null;
  patch?: unknown;
  dryRun?: DryRunResult;
  createdAt: number;
  expiresAt: number;
  hash: string;
}

export interface Approval {
  proposalId: string;
  proposalHash: string;
  operator: OperatorIdentity;
  approvedAt: number;
  highRiskConfirmed: boolean;
}

export interface Rejection {
  proposalId: string;
  operator: OperatorIdentity;
  rejectedAt: number;
  reason: string | null;
}

export interface ExecutionRecord {
  id: string;
  proposalId: string;
  proposalHash: string;
  operator: OperatorIdentity;
  action: HealingAction;
  command: string[];
  startedAt: number;
  finishedAt: number | null;
  success: boolean;
  output: string;
  error: string | null;
  preState: StateSnapshot | null;
  postState: StateSnapshot | null;
}

export interface VerificationRecord {
  executionId: string;
  startedAt: number;
  finishedAt: number;
  outcome: "HEALTHY" | "UNHEALTHY" | "TIMED_OUT" | "ERROR";
  checks: string[];
}

export interface StatusChange {
  from: IncidentStatus | null;
  to: IncidentStatus;
  at: number;
  reason: string;
}

export interface Symptom {
  code: string;
  resource: ResourceRef;
  message: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

export interface AiDiagnosis {
  summary: string;
  probable_root_cause: string;
  confidence: number;
  evidence: string[];
  contributing_factors: string[];
  recommended_action: unknown;
  risk_level: RiskLevel;
  expected_impact: string;
  verification_steps: string[];
  rollback_strategy: string;
  limitations: string[];
  uncertainty: string;
  gitops_suggestion?: string | null;
}

export interface ContextMeta {
  sections: string[];
  chars: number;
  redactions: number;
  truncated: boolean;
}

export interface DiagnosisRecord {
  result: AiDiagnosis;
  provider: string;
  model: string | null;
  cacheKey: string;
  at: number;
  context: ContextMeta;
}

export interface Incident {
  id: string;
  key: string;
  binding: ClusterBinding;
  severity: Severity;
  status: IncidentStatus;
  resource: ResourceRef;
  problem: string;
  symptoms: Symptom[];
  affected: ResourceRef[];
  restartCount: number | null;
  firstDetected: number;
  lastDetected: number;
  gitopsOwner: string | null;
  diagnosis: DiagnosisRecord | null;
  diagnosisError: string | null;
  proposals: HealingProposal[];
  activeProposalId: string | null;
  approvals: Approval[];
  rejections: Rejection[];
  executions: ExecutionRecord[];
  verifications: VerificationRecord[];
  history: StatusChange[];
  lastError: string | null;
  conversation: ChatMessage[];
}

export interface HealingStats {
  active: number;
  pendingApproval: number;
  inProgress: number;
  healedToday: number;
  failed: number;
  needsAttention: number;
}

export interface AuditRecord {
  id: string;
  at: number;
  event: string;
  incidentId: string;
  proposalId: string | null;
  proposalHash: string | null;
  context: string;
  namespace: string | null;
  resource: string;
  resourceUid: string | null;
  operator: OperatorIdentity | null;
  action: HealingAction | null;
  detail: string;
}

export interface ScanResult {
  newIncidents: Incident[];
  openIncidents: number;
  findings: number;
  scannedAt: number;
}

export interface AiConfig {
  enabled: boolean;
  provider: "CLAUDE_CLI";
  model: string | null;
  timeoutSecs: number;
  maxContextChars: number;
  maxBudgetUsd: number;
  authMode: "CLI_LOGIN" | "KEYCHAIN_TOKEN";
}

export interface AiStatus {
  config: AiConfig;
  cliPath: string | null;
  available: boolean;
  message: string;
  tokenStored: boolean;
  tokenHint: string | null;
  keychainError: string | null;
  cliLogin: { loggedIn: boolean; authMethod: string | null; orgName: string | null } | null;
}

export interface HealingPolicy {
  protectedNamespaces: string[];
  protectedResources: { namespace: string; kind: string; name: string }[];
  allowedContexts: string[];
  allowedNamespaces: string[];
  allowedActions: string[];
  maxRisk: RiskLevel;
  maxReplicas: number;
  proposalTtlMinutes: number;
}

export interface AiContextPreview {
  context: {
    clusterContext: string;
    namespace: string | null;
    resourceKind: string;
    resourceName: string;
    problem: string;
    symptoms: { code: string; resource: string; message: string; count: number }[];
    resource: unknown;
    pods: unknown[];
    events: { type: string; reason: string; message: string; count: number; object: string; lastTimestamp: string }[];
    logs: { pod: string; container: string; previous: boolean; text: string }[];
    rolloutHistory: string | null;
    nodes: unknown[];
    services: unknown[];
    configReferences: string[];
    metrics: string | null;
    gitopsOwner: string | null;
    collectionNotes: string[];
  };
  meta: ContextMeta;
  provider: string;
  enabled: boolean;
}

export interface BatchStatus {
  running: boolean;
  context: string | null;
  total: number;
  done: number;
  proposals: number;
  manual: number;
  failed: number;
  current: string | null;
  stoppedReason: string | null;
}

/** Statuses that need no further action. */
export const CLOSED_STATUSES: IncidentStatus[] = ["HEALED", "ROLLED_BACK", "REJECTED"];
