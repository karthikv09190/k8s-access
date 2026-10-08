interface IngressRule {
  host: string;
  path: string;
  pathType: string;
  service: string;
  port: string | number;
}

interface Props {
  resource: any;
}

function parseRules(resource: any): IngressRule[] {
  const rules: IngressRule[] = [];
  for (const rule of resource.spec?.rules ?? []) {
    const host = rule.host ?? "*";
    for (const p of rule.http?.paths ?? []) {
      const svc =
        p.backend?.service?.name ??
        p.backend?.serviceName ??
        "?";
      const port =
        p.backend?.service?.port?.number ??
        p.backend?.service?.port?.name ??
        p.backend?.servicePort ??
        "?";
      rules.push({
        host,
        path: p.path ?? "/",
        pathType: p.pathType ?? "-",
        service: svc,
        port: String(port),
      });
    }
    // Rule with no http paths (e.g. TCP)
    if (!rule.http?.paths?.length) {
      rules.push({ host, path: "-", pathType: "-", service: "-", port: "-" });
    }
  }
  return rules;
}

export function IngressRulesPanel({ resource }: Props) {
  const rules = parseRules(resource);
  const tls: { hosts: string[]; secretName: string }[] = resource.spec?.tls ?? [];
  const tlsHosts = new Set(tls.flatMap((t: any) => t.hosts ?? []));

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 shrink-0">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold">RULES</span>
        <span className="text-xs text-slate-500 dark:text-slate-600">{rules.length} rule{rules.length !== 1 ? "s" : ""}</span>
        {tls.length > 0 && (
          <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-900/40 border border-green-300 dark:border-green-800 text-green-600 dark:text-green-400">
            TLS
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {rules.length === 0 ? (
          <p className="text-xs text-slate-500 p-4">No rules defined.</p>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
                <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Host</th>
                <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Path</th>
                <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Type</th>
                <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Service</th>
                <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Port</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-200/50 dark:border-slate-800/50 hover:bg-black/5 dark:hover:bg-slate-800/30"
                >
                  <td className="px-3 py-2 font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">
                    {r.host}
                    {tlsHosts.has(r.host) && (
                      <span className="ml-1.5 text-green-600 dark:text-green-400 text-xs">🔒</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">{r.path}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.pathType}</td>
                  <td className="px-3 py-2 font-mono text-blue-600 dark:text-blue-400 whitespace-nowrap">{r.service}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">{r.port}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* TLS section */}
        {tls.length > 0 && (
          <div className="px-3 py-3 border-t border-slate-200 dark:border-slate-800 mt-1">
            <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold mb-2">TLS Certificates</p>
            {tls.map((t: any, i: number) => (
              <div key={i} className="flex items-start gap-3 text-xs mb-1.5">
                <span className="text-green-600 dark:text-green-400 font-mono">{t.secretName ?? "(auto)"}</span>
                <span className="text-slate-500">→</span>
                <span className="text-slate-700 dark:text-slate-300 font-mono">{(t.hosts ?? []).join(", ") || "*"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
