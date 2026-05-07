import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import {
  listRoles,
  listRolebindings,
  listClusterroles,
  listClusterrolebindings,
  listServiceaccounts,
} from "../lib/tauri";
import {
  AlertTriangle,
  RefreshCw,
  Search,
  Shield,
  X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PolicyRule {
  verbs?: string[];
  resources?: string[];
  apiGroups?: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

interface K8sRole {
  metadata?: { name?: string; namespace?: string };
  rules?: PolicyRule[];
}

interface BindingSubject {
  kind: string;
  name: string;
  namespace?: string;
  apiGroup?: string;
}

interface RoleRef {
  kind: string;
  name: string;
  apiGroup?: string;
}

interface K8sRoleBinding {
  metadata?: { name?: string; namespace?: string };
  subjects?: BindingSubject[];
  roleRef?: RoleRef;
}

interface Subject {
  kind: "ServiceAccount" | "User" | "Group";
  name: string;
  namespace?: string; // for ServiceAccounts
}

interface FlatRule {
  resources: string[];
  verbs: string[];
  apiGroups: string[];
  sourceRole: string;
  sourceNamespace: string | null; // null = cluster-wide
  isWildcard: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const COMMON_VERBS = ["get", "list", "watch", "create", "update", "patch", "delete"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function subjectKey(s: Subject): string {
  return `${s.kind}/${s.namespace ?? ""}/${s.name}`;
}

function subjectMatches(bindingSub: BindingSubject, sel: Subject): boolean {
  if (bindingSub.kind !== sel.kind) return false;
  if (bindingSub.name !== sel.name) return false;
  if (sel.kind === "ServiceAccount" && sel.namespace) {
    return (bindingSub.namespace ?? "") === sel.namespace;
  }
  return true;
}

function computePermissions(
  selectedSubject: Subject,
  roles: K8sRole[],
  roleBindings: K8sRoleBinding[],
  clusterRoles: K8sRole[],
  clusterRoleBindings: K8sRoleBinding[]
): FlatRule[] {
  const flat: FlatRule[] = [];

  const roleMap = new Map<string, K8sRole>();
  for (const r of roles) {
    const key = `${r.metadata?.namespace ?? ""}/${r.metadata?.name ?? ""}`;
    roleMap.set(key, r);
  }

  const clusterRoleMap = new Map<string, K8sRole>();
  for (const r of clusterRoles) {
    clusterRoleMap.set(r.metadata?.name ?? "", r);
  }

  // RoleBindings
  for (const rb of roleBindings) {
    const matched = (rb.subjects ?? []).some((s) => subjectMatches(s, selectedSubject));
    if (!matched) continue;

    const ref = rb.roleRef;
    if (!ref) continue;

    let role: K8sRole | undefined;
    if (ref.kind === "Role") {
      const ns = rb.metadata?.namespace ?? "";
      role = roleMap.get(`${ns}/${ref.name}`);
    } else if (ref.kind === "ClusterRole") {
      role = clusterRoleMap.get(ref.name);
    }

    if (!role) continue;

    for (const rule of role.rules ?? []) {
      const resources = rule.resources ?? [];
      const verbs = rule.verbs ?? [];
      if (resources.length === 0 && (rule.nonResourceURLs ?? []).length === 0) continue;
      flat.push({
        resources: resources.length > 0 ? resources : ["<non-resource>"],
        verbs,
        apiGroups: rule.apiGroups ?? [""],
        sourceRole: ref.name,
        sourceNamespace: rb.metadata?.namespace ?? null,
        isWildcard: verbs.includes("*") || resources.includes("*"),
      });
    }
  }

  // ClusterRoleBindings
  for (const crb of clusterRoleBindings) {
    const matched = (crb.subjects ?? []).some((s) => subjectMatches(s, selectedSubject));
    if (!matched) continue;

    const ref = crb.roleRef;
    if (!ref) continue;

    const role = clusterRoleMap.get(ref.name);
    if (!role) continue;

    for (const rule of role.rules ?? []) {
      const resources = rule.resources ?? [];
      const verbs = rule.verbs ?? [];
      if (resources.length === 0 && (rule.nonResourceURLs ?? []).length === 0) continue;
      flat.push({
        resources: resources.length > 0 ? resources : ["<non-resource>"],
        verbs,
        apiGroups: rule.apiGroups ?? [""],
        sourceRole: ref.name,
        sourceNamespace: null, // cluster-wide
        isWildcard: verbs.includes("*") || resources.includes("*"),
      });
    }
  }

  return flat;
}

// Expand wildcard rules into individual resource rows for display
interface PermRow {
  resource: string;
  apiGroup: string;
  namespace: string | null;
  sourceRole: string;
  granted: Set<string>;
  isWildcard: boolean;
}

function buildPermRows(flatRules: FlatRule[]): PermRow[] {
  // group by resource + namespace + role
  const rowMap = new Map<string, PermRow>();

  for (const rule of flatRules) {
    for (const resource of rule.resources) {
      for (const apiGroup of rule.apiGroups) {
        const key = `${resource}|${apiGroup}|${rule.sourceNamespace ?? "__cluster__"}|${rule.sourceRole}`;
        let row = rowMap.get(key);
        if (!row) {
          row = {
            resource,
            apiGroup,
            namespace: rule.sourceNamespace,
            sourceRole: rule.sourceRole,
            granted: new Set(),
            isWildcard: rule.isWildcard,
          };
          rowMap.set(key, row);
        }
        if (rule.verbs.includes("*")) {
          COMMON_VERBS.forEach((v) => row!.granted.add(v));
          row.granted.add("*");
        } else {
          rule.verbs.forEach((v) => row!.granted.add(v));
        }
        if (rule.isWildcard) row.isWildcard = true;
      }
    }
  }

  return Array.from(rowMap.values()).sort((a, b) => {
    if (a.resource < b.resource) return -1;
    if (a.resource > b.resource) return 1;
    return 0;
  });
}

// ── Subject Badge ──────────────────────────────────────────────────────────────

function KindBadge({ kind }: { kind: string }) {
  if (kind === "ServiceAccount") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/40 text-blue-300 border border-blue-800/40">
        SA
      </span>
    );
  }
  if (kind === "User") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-900/40 text-purple-300 border border-purple-800/40">
        User
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-700 text-slate-300 border border-slate-600/40">
      Group
    </span>
  );
}

// ── Permission Matrix ──────────────────────────────────────────────────────────

function PermMatrix({ rows }: { rows: PermRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-600 text-sm">
        No permissions found
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
            <th className="px-3 py-2">Resource</th>
            <th className="px-2 py-2 text-slate-500 dark:text-slate-600">API Group</th>
            <th className="px-2 py-2 text-slate-500 dark:text-slate-600">Namespace</th>
            <th className="px-2 py-2 text-slate-500 dark:text-slate-600">Role</th>
            {COMMON_VERBS.map((v) => (
              <th key={v} className="px-2 py-2 text-center w-14">{v}</th>
            ))}
            <th className="px-2 py-2 text-center w-10 text-amber-600" title="Wildcard *">*</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isWc = row.isWildcard;
            const rowBg =
              isWc
                ? "bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-950/30"
                : i % 2 === 0
                ? "bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800/40"
                : "bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800/40";

            return (
              <tr
                key={`${row.resource}-${row.apiGroup}-${row.namespace}-${row.sourceRole}-${i}`}
                className={`border-b border-slate-200/50 dark:border-slate-800/50 transition-colors ${rowBg}`}
              >
                <td className="px-3 py-1.5">
                  <span className={`font-mono font-medium ${isWc ? "text-amber-700 dark:text-amber-300" : "text-slate-800 dark:text-slate-200"}`}>
                    {row.resource}
                  </span>
                  {isWc && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-400 bg-amber-900/30 px-1 py-0.5 rounded border border-amber-700/30">
                      <AlertTriangle size={9} />
                      wildcard
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-mono text-slate-600 text-[11px]">
                    {row.apiGroup === "" ? "core" : row.apiGroup}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className="text-slate-500 text-[11px]">
                    {row.namespace ?? (
                      <span className="text-blue-600 font-medium">cluster-wide</span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-mono text-slate-500 text-[11px] truncate max-w-[120px] block">
                    {row.sourceRole}
                  </span>
                </td>
                {COMMON_VERBS.map((v) => (
                  <td key={v} className="px-2 py-1.5 text-center w-14">
                    {row.granted.has(v) || row.granted.has("*") ? (
                      <span className="text-green-400 font-bold text-sm">✓</span>
                    ) : null}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-center w-10">
                  {row.granted.has("*") ? (
                    <span className="text-amber-400 font-bold text-sm">✓</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function RbacVisualizerPage() {
  const { activeContext, activeNamespace } = useAppStore();
  const namespace = activeNamespace || undefined;

  const [search, setSearch] = useState("");
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);

  const queryOpts = { enabled: !!activeContext };

  const { data: roles = [], isLoading: rolesLoading, refetch: refetchAll, isFetching } = useQuery({
    queryKey: ["rbac-roles", activeContext, namespace],
    queryFn: () => listRoles({ context: activeContext, namespace }) as Promise<K8sRole[]>,
    ...queryOpts,
  });

  const { data: roleBindings = [], isLoading: rbLoading } = useQuery({
    queryKey: ["rbac-rolebindings", activeContext, namespace],
    queryFn: () => listRolebindings({ context: activeContext, namespace }) as Promise<K8sRoleBinding[]>,
    ...queryOpts,
  });

  const { data: clusterRoles = [], isLoading: crLoading } = useQuery({
    queryKey: ["rbac-clusterroles", activeContext],
    queryFn: () => listClusterroles({ context: activeContext }) as Promise<K8sRole[]>,
    ...queryOpts,
  });

  const { data: clusterRoleBindings = [], isLoading: crbLoading } = useQuery({
    queryKey: ["rbac-clusterrolebindings", activeContext],
    queryFn: () => listClusterrolebindings({ context: activeContext }) as Promise<K8sRoleBinding[]>,
    ...queryOpts,
  });

  const { data: serviceAccounts = [] } = useQuery({
    queryKey: ["rbac-serviceaccounts", activeContext, namespace],
    queryFn: () => listServiceaccounts({ context: activeContext, namespace }),
    ...queryOpts,
  });

  const isLoading = rolesLoading || rbLoading || crLoading || crbLoading;

  // Extract all subjects from bindings
  const allSubjects = useMemo<Subject[]>(() => {
    const seen = new Map<string, Subject>();

    const addSub = (s: BindingSubject) => {
      const sub: Subject = {
        kind: s.kind as Subject["kind"],
        name: s.name,
        namespace: s.namespace,
      };
      const k = subjectKey(sub);
      if (!seen.has(k)) seen.set(k, sub);
    };

    for (const rb of roleBindings) {
      (rb.subjects ?? []).forEach(addSub);
    }
    for (const crb of clusterRoleBindings) {
      (crb.subjects ?? []).forEach(addSub);
    }

    // Also add all ServiceAccounts in the namespace as subjects (even if no binding yet)
    for (const sa of serviceAccounts as any[]) {
      const sub: Subject = {
        kind: "ServiceAccount",
        name: sa.metadata?.name ?? "",
        namespace: sa.metadata?.namespace ?? namespace,
      };
      const k = subjectKey(sub);
      if (!seen.has(k)) seen.set(k, sub);
    }

    return Array.from(seen.values()).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });
  }, [roleBindings, clusterRoleBindings, serviceAccounts, namespace]);

  const filteredSubjects = useMemo(() => {
    if (!search.trim()) return allSubjects;
    const q = search.toLowerCase();
    return allSubjects.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.kind.toLowerCase().includes(q) ||
        (s.namespace ?? "").toLowerCase().includes(q)
    );
  }, [allSubjects, search]);

  // Compute permissions for selected subject
  const permRows = useMemo<PermRow[]>(() => {
    if (!selectedSubject) return [];
    const flat = computePermissions(
      selectedSubject,
      roles,
      roleBindings,
      clusterRoles,
      clusterRoleBindings
    );
    return buildPermRows(flat);
  }, [selectedSubject, roles, roleBindings, clusterRoles, clusterRoleBindings]);

  const hasWildcard = permRows.some((r) => r.isWildcard);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <Shield size={16} className="animate-pulse text-blue-500" />
        Loading RBAC data…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={15} className="text-blue-600 dark:text-blue-400" />
          <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200">RBAC Visualizer</h1>
          {isFetching && (
            <RefreshCw size={11} className="animate-spin text-slate-600" />
          )}
          <span className="text-[11px] text-slate-600 ml-1">
            {allSubjects.length} subject{allSubjects.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={() => refetchAll()}
          disabled={isFetching}
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* ── Overprivileged warning ── */}
      {selectedSubject && hasWildcard && (
        <div className="shrink-0 px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800/50 flex items-center gap-2 text-amber-700 dark:text-amber-300 text-xs">
          <AlertTriangle size={13} className="text-amber-400 shrink-0" />
          <span>
            <span className="font-semibold">{selectedSubject.name}</span> has wildcard permissions
            — potential security risk
          </span>
        </div>
      )}

      {/* ── Body: split panels ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left panel — subject list */}
        <div className="w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col">
          {/* Search */}
          <div className="p-2 border-b border-slate-200 dark:border-slate-800">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search subjects…"
                className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded-md pl-7 pr-7 py-1.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-400 dark:placeholder:text-slate-600"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {filteredSubjects.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-slate-600 text-xs">
                No subjects found
              </div>
            ) : (
              filteredSubjects.map((s) => {
                const key = subjectKey(s);
                const selKey = selectedSubject ? subjectKey(selectedSubject) : null;
                const isSelected = key === selKey;

                return (
                  <button
                    key={key}
                    onClick={() => setSelectedSubject(s)}
                    className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors border-b border-slate-200/50 dark:border-slate-800/50 ${
                      isSelected
                        ? "bg-blue-100 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 border-l-2 border-l-blue-500"
                        : "hover:bg-black/5 dark:hover:bg-white/5 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    <div className="mt-0.5 shrink-0">
                      <KindBadge kind={s.kind} />
                    </div>
                    <div className="min-w-0">
                      <div className={`text-xs font-medium truncate ${isSelected ? "text-blue-600 dark:text-blue-300" : "text-slate-700 dark:text-slate-300"}`}>
                        {s.name}
                      </div>
                      {s.namespace && (
                        <div className="text-[11px] text-slate-600 truncate">{s.namespace}</div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right panel — permission matrix */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {!selectedSubject ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
              <Shield size={32} className="opacity-20" />
              <div className="text-sm">Select a subject to view permissions</div>
              <div className="text-xs text-slate-700">
                {allSubjects.length} subjects across {roleBindings.length + clusterRoleBindings.length} bindings
              </div>
            </div>
          ) : (
            <>
              {/* Panel header */}
              <div className="shrink-0 px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <KindBadge kind={selectedSubject.kind} />
                  <span className="text-sm font-medium text-slate-200">{selectedSubject.name}</span>
                  {selectedSubject.namespace && (
                    <span className="text-xs text-slate-600 font-mono">
                      ({selectedSubject.namespace})
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-600">
                  {permRows.length} rule{permRows.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Matrix */}
              <div className="flex-1 overflow-auto">
                <PermMatrix rows={permRows} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-600">
        <span>
          {roleBindings.length} RoleBindings · {clusterRoleBindings.length} ClusterRoleBindings ·{" "}
          {roles.length} Roles · {clusterRoles.length} ClusterRoles
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
