export interface KubeContext {
  name: string;
  cluster: string;
  namespace: string | null;
  current: boolean;
}

export interface K8sResource {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    uid?: string;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface Pod extends K8sResource {
  spec?: {
    nodeName?: string;
    containers: Array<{ name: string; image: string }>;
  };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: Array<{ type: string; status: string }>;
    containerStatuses?: Array<{
      name: string;
      ready: boolean;
      restartCount: number;
      state: Record<string, unknown>;
    }>;
  };
}

export interface Deployment extends K8sResource {
  spec?: {
    replicas?: number;
    template: {
      spec?: { containers: Array<{ name: string; image: string }> };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
}

export interface ClusterOverview {
  totalNodes: number;
  readyNodes: number;
  totalPods: number;
  runningPods: number;
  pendingPods: number;
  failedPods: number;
  totalDeployments: number;
  totalServices: number;
  totalNamespaces: number;
}

// ── Compare types ─────────────────────────────────────────────────────────────

export type DiffStatus = "identical" | "different" | "leftOnly" | "rightOnly";

export interface ResourceSnapshot {
  replicas: number | null;
  readyReplicas: number | null;
  image: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  secretKeys: string[] | null;
  configmapKeys: string[] | null;
  serviceType: string | null;
  servicePort: number | null;
  rawJson: string;
}

export interface ResourceDiff {
  name: string;
  kind: string;
  namespace: string;
  status: DiffStatus;
  left: ResourceSnapshot | null;
  right: ResourceSnapshot | null;
}

export interface CompareSummary {
  total: number;
  identical: number;
  different: number;
  leftOnly: number;
  rightOnly: number;
}

export interface CompareResult {
  leftContext: string;
  rightContext: string;
  namespace: string;
  diffs: ResourceDiff[];
  summary: CompareSummary;
}
