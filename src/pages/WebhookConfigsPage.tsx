import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listMutatingwebhookconfigurations, listValidatingwebhookconfigurations } from "../lib/tauri";
import { ResourceTable, type Column } from "../components/resources/ResourceTable";
import { age } from "../lib/utils";
import { Webhook, X, FileCode, ChevronDown, ChevronRight } from "lucide-react";
import { YamlPanel } from "../components/resources/YamlPanel";

type TabId = "mutating" | "validating";

function FailurePolicyBadge({ policy }: { policy?: string }) {
  if (!policy) return <span className="text-xs text-slate-500">-</span>;
  if (policy === "Fail") {
    return (
      <span className="px-1.5 py-0.5 rounded text-xs bg-red-900/40 text-red-400">
        Fail
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-xs bg-green-900/40 text-green-400">
      {policy}
    </span>
  );
}

interface WebhookDetailPanelProps {
  resource: any;
  context: string;
  kind: string;
  onClose: () => void;
}

function WebhookDetailPanel({ resource, context, kind, onClose }: WebhookDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<"details" | "yaml">("details");
  const [expandedWebhook, setExpandedWebhook] = useState<number | null>(0);

  const name: string = resource.metadata?.name ?? "";
  const webhooks: any[] = resource.webhooks ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
        <span className="font-mono text-xs text-slate-200 truncate">{name}</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 shrink-0 ml-2">
          <X size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 shrink-0">
        {(["details", "yaml"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs capitalize border-b-2 transition-colors ${
              activeTab === tab
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab === "yaml" && <FileCode size={11} />}
            {tab === "details" ? "Webhooks" : "YAML"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "yaml" && (
          <YamlPanel
            context={context}
            namespace={undefined}
            kind={kind}
            name={name}
          />
        )}

        {activeTab === "details" && (
          <div className="p-3 space-y-2">
            {webhooks.length === 0 && (
              <p className="text-xs text-slate-500 italic">No webhooks defined.</p>
            )}
            {webhooks.map((wh: any, idx: number) => {
              const isOpen = expandedWebhook === idx;
              const rules: any[] = wh.rules ?? [];
              return (
                <div key={idx} className="border border-slate-700 rounded">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/50 transition-colors"
                    onClick={() => setExpandedWebhook(isOpen ? null : idx)}
                  >
                    {isOpen ? (
                      <ChevronDown size={12} className="text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-400 shrink-0" />
                    )}
                    <span className="font-mono text-xs text-slate-200 truncate">
                      {wh.name ?? `webhook-${idx}`}
                    </span>
                    <FailurePolicyBadge policy={wh.failurePolicy} />
                  </button>

                  {isOpen && (
                    <div className="px-3 pb-3 space-y-2 border-t border-slate-700">
                      {/* Side effects */}
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-slate-500 w-24 shrink-0">Side Effects</span>
                        <span className="text-xs text-slate-300">{wh.sideEffects ?? "-"}</span>
                      </div>

                      {/* Admission review versions */}
                      {wh.admissionReviewVersions && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500 w-24 shrink-0">Review Vers.</span>
                          <span className="text-xs text-slate-300">
                            {wh.admissionReviewVersions.join(", ")}
                          </span>
                        </div>
                      )}

                      {/* Namespace selector */}
                      {wh.namespaceSelector?.matchLabels && (
                        <div className="flex items-start gap-2">
                          <span className="text-xs text-slate-500 w-24 shrink-0">NS Selector</span>
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(wh.namespaceSelector.matchLabels).map(([k, v]) => (
                              <span
                                key={k}
                                className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-300 font-mono"
                              >
                                {k}={String(v)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Rules */}
                      {rules.length > 0 && (
                        <div>
                          <span className="text-xs text-slate-500 block mb-1">Rules</span>
                          <div className="space-y-1.5">
                            {rules.map((rule: any, rIdx: number) => (
                              <div
                                key={rIdx}
                                className="bg-slate-800 rounded px-2 py-1.5 text-xs space-y-0.5"
                              >
                                <div>
                                  <span className="text-slate-500">Groups: </span>
                                  <span className="text-slate-300 font-mono">
                                    {(rule.apiGroups ?? []).join(", ") || "*"}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-500">Versions: </span>
                                  <span className="text-slate-300 font-mono">
                                    {(rule.apiVersions ?? []).join(", ") || "*"}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-500">Resources: </span>
                                  <span className="text-slate-300 font-mono">
                                    {(rule.resources ?? []).join(", ") || "*"}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-500">Operations: </span>
                                  <span className="text-slate-300 font-mono">
                                    {(rule.operations ?? []).join(", ")}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function WebhookTable({
  data,
  isLoading,
  kind,
  context,
  emptyHint,
}: {
  data: any[];
  isLoading: boolean;
  kind: string;
  context: string;
  emptyHint: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const columns: Column<any>[] = [
    {
      header: "Name",
      accessor: (r) => (
        <span className="font-mono text-xs text-slate-200">{r.metadata?.name}</span>
      ),
    },
    {
      header: "Webhooks",
      accessor: (r) => (
        <span className="text-xs text-slate-400">{r.webhooks?.length ?? 0}</span>
      ),
      width: "80px",
    },
    {
      header: "Failure Policy",
      accessor: (r) => (
        <FailurePolicyBadge policy={r.webhooks?.[0]?.failurePolicy} />
      ),
      width: "110px",
    },
    {
      header: "Operations",
      accessor: (r) => {
        const ops: string[] = r.webhooks?.[0]?.rules?.[0]?.operations ?? [];
        const joined = ops.join(", ");
        return (
          <span className="text-xs text-slate-400 font-mono truncate" title={joined}>
            {joined ? (joined.length > 30 ? joined.slice(0, 28) + "…" : joined) : "-"}
          </span>
        );
      },
    },
    {
      header: "Side Effects",
      accessor: (r) => (
        <span className="text-xs text-slate-400">{r.webhooks?.[0]?.sideEffects ?? "-"}</span>
      ),
      width: "100px",
    },
    {
      header: "Age",
      accessor: (r) => (
        <span className="text-xs text-slate-500">{age(r.metadata?.creationTimestamp)}</span>
      ),
      width: "60px",
    },
  ];

  const selectedResource = data.find((r) => r.metadata?.name === selected);

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 overflow-auto min-w-0">
        <ResourceTable
          columns={columns}
          data={data}
          getKey={(r) => r.metadata?.uid ?? r.metadata?.name}
          onSelect={(r) => setSelected(r.metadata?.name)}
          selected={selected ?? undefined}
          loading={isLoading}
          emptyMessage={
            data.length === 0 && !isLoading ? emptyHint : undefined
          }
        />
      </div>

      {selected && selectedResource && (
        <div className="w-[440px] shrink-0 border-l border-slate-800 overflow-hidden flex flex-col">
          <WebhookDetailPanel
            resource={selectedResource}
            context={context}
            kind={kind}
            onClose={() => setSelected(null)}
          />
        </div>
      )}
    </div>
  );
}

export function WebhookConfigsPage() {
  const { activeContext } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>("mutating");

  const { data: mutatingData = [], isLoading: mutatingLoading } = useQuery({
    queryKey: ["mutatingwebhookconfigurations", activeContext],
    queryFn: () => listMutatingwebhookconfigurations({ context: activeContext }),
    enabled: !!activeContext,
    refetchInterval: 30000,
  });

  const { data: validatingData = [], isLoading: validatingLoading } = useQuery({
    queryKey: ["validatingwebhookconfigurations", activeContext],
    queryFn: () => listValidatingwebhookconfigurations({ context: activeContext }),
    enabled: !!activeContext,
    refetchInterval: 30000,
  });

  const mutating = mutatingData as any[];
  const validating = validatingData as any[];

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "mutating", label: "Mutating", count: mutating.length },
    { id: "validating", label: "Validating", count: validating.length },
  ];

  const emptyHint =
    "No webhook configurations found — typically installed by service meshes, admission controllers (OPA, Kyverno), cert-manager.";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <Webhook size={16} className="text-slate-400 shrink-0" />
        <h2 className="text-sm font-semibold text-slate-200">
          Webhook Configurations
        </h2>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}{" "}
            <span className="text-slate-500">({tab.count})</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === "mutating" && (
          <WebhookTable
            data={mutating}
            isLoading={mutatingLoading}
            kind="MutatingWebhookConfiguration"
            context={activeContext}
            emptyHint={emptyHint}
          />
        )}
        {activeTab === "validating" && (
          <WebhookTable
            data={validating}
            isLoading={validatingLoading}
            kind="ValidatingWebhookConfiguration"
            context={activeContext}
            emptyHint={emptyHint}
          />
        )}
      </div>
    </div>
  );
}
