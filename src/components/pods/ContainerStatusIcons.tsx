interface ContainerStatus {
  name: string;
  ready: boolean;
  state?: {
    running?: { startedAt?: string };
    waiting?: { reason?: string; message?: string };
    terminated?: { exitCode?: number; reason?: string };
  };
}

interface Props {
  containerStatuses: ContainerStatus[];
}

export function ContainerStatusIcons({ containerStatuses }: Props) {
  if (!containerStatuses.length) return null;

  return (
    <div className="flex items-center gap-0.5">
      {containerStatuses.map((cs) => {
        const s = cs.state;
        let color = "bg-slate-500";
        let title = cs.name;

        if (s?.running) {
          color = cs.ready ? "bg-green-400" : "bg-yellow-400";
          title = `${cs.name}: running${cs.ready ? "" : " (not ready)"}`;
        } else if (s?.waiting) {
          color = "bg-amber-500";
          title = `${cs.name}: ${s.waiting.reason ?? "waiting"}`;
        } else if (s?.terminated) {
          color = (s.terminated.exitCode ?? 1) === 0 ? "bg-slate-400" : "bg-red-500";
          title = `${cs.name}: terminated (exit ${s.terminated.exitCode ?? "?"})`;
        }

        return (
          <span
            key={cs.name}
            title={title}
            className={`inline-block w-2 h-2 rounded-full ${color} cursor-default`}
          />
        );
      })}
    </div>
  );
}
