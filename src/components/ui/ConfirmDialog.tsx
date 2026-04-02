import { AlertTriangle } from "lucide-react";

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  variant?: "danger" | "warning";
}

export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  variant = "danger",
}: Props) {
  const btnClass =
    variant === "danger"
      ? "bg-red-600 hover:bg-red-500"
      : "bg-orange-600 hover:bg-orange-500";
  const textClass = variant === "danger" ? "text-red-300" : "text-orange-300";
  const borderClass =
    variant === "danger" ? "border-red-500/40 bg-red-500/5" : "border-orange-500/40 bg-orange-500/5";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className={`flex flex-col gap-3 p-4 rounded border ${borderClass} shadow-xl min-w-[260px] max-w-sm`}>
        <div className={`flex items-start gap-2 text-sm ${textClass}`}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`text-xs px-3 py-1.5 rounded ${btnClass} text-white`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
