import { REFRESH_OPTIONS } from "../../lib/refreshOptions";

export function RefreshSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value ? `⏱ ${o.label}` : "Refresh: Off"}
        </option>
      ))}
    </select>
  );
}
