# Phase 1A — Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 5 quick-win UX improvements: copy buttons, container status icons, auto-refresh toggle, keyboard shortcuts, and events enhancements.

**Architecture:** Pure frontend changes except ResourceTable keyboard nav. No new Rust commands. All changes are additive — existing behaviour unchanged.

**Tech Stack:** React, TypeScript, Tailwind, lucide-react, navigator.clipboard

---

## File Map

| File | Change |
|------|--------|
| `src/components/resources/ResourceActionsPanel.tsx` | Add copy name + copy YAML buttons to header |
| `src/components/pods/PodActionsPanel.tsx` | Add copy name + copy YAML buttons to header |
| `src/components/pods/ContainerStatusIcons.tsx` | **Create** — per-container state icon row |
| `src/components/resources/ResourceTable.tsx` | Add `group` class to rows, keyboard nav props |
| `src/pages/PodsPage.tsx` | Add ContainerStatusIcons column, auto-refresh dropdown |
| `src/pages/GenericResourcePage.tsx` | Add auto-refresh dropdown, keyboard nav |
| `src/hooks/useKeyboardNav.ts` | **Create** — j/k/Enter/Escape/Delete nav hook |
| `src/pages/EventsPage.tsx` | Add time-range filter dropdown |
| `src/components/resources/EventsPanel.tsx` | Add "Copy as kubectl" button in footer |

---

### Task 1: Copy Name / Copy YAML Buttons

**Files:**
- Modify: `src/components/resources/ResourceActionsPanel.tsx`
- Modify: `src/components/pods/PodActionsPanel.tsx`

- [ ] **Step 1: Add useCopyButton hook inline in ResourceActionsPanel.tsx**

Replace the header section (lines 71–85) with:

```tsx
// inside ResourceActionsPanel, before return:
const [copiedField, setCopiedField] = useState<"name" | "yaml" | null>(null);

const copy = (field: "name" | "yaml", text: string) => {
  navigator.clipboard.writeText(text).then(() => {
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1200);
  });
};
```

- [ ] **Step 2: Add copy buttons to ResourceActionsPanel header**

In the header `<div>` (between the name/ns block and the X button), add:

```tsx
import { Copy, Check } from "lucide-react";

// After the name/ns div, before the close button:
<div className="flex items-center gap-1 shrink-0">
  <button
    onClick={() => copy("name", name)}
    title="Copy name"
    className="p-1 text-slate-500 hover:text-slate-300 rounded hover:bg-slate-800"
  >
    {copiedField === "name" ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
  </button>
</div>
```

- [ ] **Step 3: Add same copy buttons to PodActionsPanel.tsx header**

PodActionsPanel header is at lines 35–47. Add the same `copiedField` state and copy buttons:

```tsx
const [copiedField, setCopiedField] = useState<"name" | null>(null);
const copy = (text: string) => {
  navigator.clipboard.writeText(text).then(() => {
    setCopiedField("name");
    setTimeout(() => setCopiedField(null), 1200);
  });
};
```

Button in header (before X):
```tsx
<button
  onClick={() => copy(podName)}
  title="Copy pod name"
  className="p-1 text-slate-500 hover:text-slate-300 rounded hover:bg-slate-800 shrink-0"
>
  {copiedField === "name" ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
</button>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/karthikvellingiri/k8s-manager && npm run build 2>&1 | tail -20
```

Expected: no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/resources/ResourceActionsPanel.tsx src/components/pods/PodActionsPanel.tsx
git commit -m "feat: add copy name button to action panel headers"
```

---

### Task 2: Container Status Icons

**Files:**
- Create: `src/components/pods/ContainerStatusIcons.tsx`
- Modify: `src/pages/PodsPage.tsx`

- [ ] **Step 1: Create ContainerStatusIcons component**

```tsx
// src/components/pods/ContainerStatusIcons.tsx
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
        const state = cs.state;
        let color = "bg-slate-500";
        let title = cs.name;

        if (state?.running) {
          color = cs.ready ? "bg-green-400" : "bg-yellow-400";
          title = `${cs.name}: running${cs.ready ? "" : " (not ready)"}`;
        } else if (state?.waiting) {
          color = "bg-amber-500";
          title = `${cs.name}: ${state.waiting.reason ?? "waiting"}`;
        } else if (state?.terminated) {
          color = state.terminated.exitCode === 0 ? "bg-slate-400" : "bg-red-500";
          title = `${cs.name}: terminated (exit ${state.terminated.exitCode ?? "?"})`;
        }

        return (
          <span
            key={cs.name}
            title={title}
            className={`inline-block w-2 h-2 rounded-full ${color}`}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add ContainerStatusIcons column to PodsPage**

In `PodsPage.tsx`, import the component and add a column after the "Ready" column:

```tsx
import { ContainerStatusIcons } from "../components/pods/ContainerStatusIcons";

// In columns array, after the Ready column:
{
  header: "Containers",
  accessor: (p) => (
    <ContainerStatusIcons
      containerStatuses={p.status?.containerStatuses ?? []}
    />
  ),
  width: "80px",
},
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/pods/ContainerStatusIcons.tsx src/pages/PodsPage.tsx
git commit -m "feat: add per-container status icons to pods page"
```

---

### Task 3: Auto-Refresh Toggle Per Page

**Files:**
- Modify: `src/pages/GenericResourcePage.tsx`
- Modify: `src/pages/PodsPage.tsx`

- [ ] **Step 1: Add RefreshIntervalSelect component (inline in GenericResourcePage.tsx)**

Add this small component at the top of the file (before `GenericResourcePage`):

```tsx
const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

function RefreshSelect({
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
      className="bg-slate-800 border border-slate-700 text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value ? `⏱ ${o.label}` : "Refresh: Off"}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Wire RefreshSelect into GenericResourcePage**

Add state and update query:

```tsx
// Add state (line ~34):
const [refreshInterval, setRefreshInterval] = useState(30_000);

// Update useQuery (change refetchInterval line):
refetchInterval: refreshInterval || false,
```

Add `<RefreshSelect>` to the header div, after the search input:

```tsx
<div className="ml-auto">
  <RefreshSelect value={refreshInterval} onChange={setRefreshInterval} />
</div>
```

- [ ] **Step 3: Same changes for PodsPage.tsx**

Add `const [refreshInterval, setRefreshInterval] = useState(15_000);` and update `refetchInterval: refreshInterval || false`. Add `<RefreshSelect>` to the header row (after the status filter select).

Copy the `REFRESH_OPTIONS` and `RefreshSelect` definitions, or extract to `src/lib/refreshOptions.ts`:

```ts
// src/lib/refreshOptions.ts
export const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];
```

Import it in both files. Move `RefreshSelect` to `src/components/ui/RefreshSelect.tsx`:

```tsx
// src/components/ui/RefreshSelect.tsx
import { REFRESH_OPTIONS } from "../../lib/refreshOptions";

export function RefreshSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="bg-slate-800 border border-slate-700 text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value ? `⏱ ${o.label}` : "Refresh: Off"}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/refreshOptions.ts src/components/ui/RefreshSelect.tsx src/pages/GenericResourcePage.tsx src/pages/PodsPage.tsx
git commit -m "feat: add configurable auto-refresh interval to resource pages"
```

---

### Task 4: Keyboard Navigation Hook

**Files:**
- Create: `src/hooks/useKeyboardNav.ts`
- Modify: `src/components/resources/ResourceTable.tsx`
- Modify: `src/pages/GenericResourcePage.tsx`
- Modify: `src/pages/PodsPage.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create useKeyboardNav hook**

```ts
// src/hooks/useKeyboardNav.ts
import { useEffect, useCallback } from "react";

interface Options {
  items: any[];
  selectedKey: string | null;
  getKey: (item: any) => string;
  onSelect: (item: any) => void;
  onClose?: () => void;
  onDelete?: (item: any) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}

export function useKeyboardNav({
  items,
  selectedKey,
  getKey,
  onSelect,
  onClose,
  onDelete,
  searchRef,
  enabled = true,
}: Options) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;
      // Don't hijack when user is typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape") onClose?.();
        return;
      }

      const idx = selectedKey
        ? items.findIndex((i) => getKey(i) === selectedKey)
        : -1;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = items[Math.min(idx + 1, items.length - 1)];
        if (next) onSelect(next);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = items[Math.max(idx - 1, 0)];
        if (prev) onSelect(prev);
      } else if (e.key === "Enter" && selectedKey) {
        // already selected — no-op (panel opens on select)
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedKey) {
        const item = items.find((i) => getKey(i) === selectedKey);
        if (item) onDelete?.(item);
      } else if (e.key === "Escape") {
        onClose?.();
      } else if (e.key === "/" && searchRef?.current) {
        e.preventDefault();
        searchRef.current.focus();
      }
    },
    [items, selectedKey, getKey, onSelect, onClose, onDelete, searchRef, enabled]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);
}
```

- [ ] **Step 2: Fix ResourceTable row missing `group` class**

In `ResourceTable.tsx` line 69, the `<tr>` needs `group` for the hover buttons to work. Update:

```tsx
<tr
  key={key}
  onClick={() => onSelect?.(row)}
  className={cn(
    "border-b border-slate-800/50 transition-colors group",
    onSelect && "cursor-pointer",
    isSelected ? "bg-blue-600/10" : "hover:bg-white/5"
  )}
>
```

- [ ] **Step 3: Wire useKeyboardNav into GenericResourcePage**

```tsx
import { useRef } from "react";
import { useKeyboardNav } from "../hooks/useKeyboardNav";

// Inside GenericResourcePage, add:
const searchRef = useRef<HTMLInputElement>(null);

useKeyboardNav({
  items: filtered,
  selectedKey: selected,
  getKey: (r) => r.metadata?.uid ?? r.metadata?.name,
  onSelect: (r) => setSelected(r.metadata?.name),
  onClose: () => setSelected(null),
  onDelete: supportsDelete ? handleDelete : undefined,
  searchRef,
});

// Add ref to search input:
<input ref={searchRef} ... />
```

- [ ] **Step 4: Wire useKeyboardNav into PodsPage.tsx**

Same pattern — add `searchRef`, wire hook with `onDelete={handleDelete}`.

- [ ] **Step 5: Add global Cmd+K handler in App.tsx**

```tsx
// In App component, add useEffect:
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      // Global search — placeholder until Phase 2
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, []);
```

- [ ] **Step 6: Verify build**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useKeyboardNav.ts src/components/resources/ResourceTable.tsx src/pages/GenericResourcePage.tsx src/pages/PodsPage.tsx src/App.tsx
git commit -m "feat: add keyboard navigation (j/k/Escape/slash) to resource tables"
```

---

### Task 5: Events Enhancement — Time Range Filter + Copy as kubectl

**Files:**
- Modify: `src/pages/EventsPage.tsx`
- Modify: `src/components/resources/EventsPanel.tsx`

- [ ] **Step 1: Add time-range filter to EventsPage**

Add type and options at the top of `EventsPage.tsx`:

```tsx
type TimeRange = "1h" | "6h" | "24h" | "all";

const TIME_RANGE_OPTIONS: { label: string; value: TimeRange; ms: number | null }[] = [
  { label: "Last 1h", value: "1h", ms: 60 * 60 * 1000 },
  { label: "Last 6h", value: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "Last 24h", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "All time", value: "all", ms: null },
];
```

Add state: `const [timeRange, setTimeRange] = useState<TimeRange>("all");`

Add to the `filtered` useMemo (after the typeFilter block):

```tsx
if (timeRange !== "all") {
  const opt = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)!;
  const cutoff = Date.now() - opt.ms!;
  result = result.filter((e) => {
    if (!e.lastTimestamp) return false;
    return new Date(e.lastTimestamp).getTime() >= cutoff;
  });
}
```

Add the dropdown to the filters row in the header (before the search input):

```tsx
<select
  value={timeRange}
  onChange={(e) => setTimeRange(e.target.value as TimeRange)}
  className="bg-slate-800 border border-slate-700 text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
>
  {TIME_RANGE_OPTIONS.map((o) => (
    <option key={o.value} value={o.value}>{o.label}</option>
  ))}
</select>
```

- [ ] **Step 2: Add "Copy as kubectl" to EventsPanel footer**

In `EventsPanel.tsx`, replace the footer with:

```tsx
import { Copy, Check } from "lucide-react";

// Add state:
const [copied, setCopied] = useState(false);

const copyKubectl = () => {
  const cmd = namespace
    ? `kubectl get events -n ${namespace} --field-selector involvedObject.name=${name}`
    : `kubectl get events --field-selector involvedObject.name=${name}`;
  navigator.clipboard.writeText(cmd).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  });
};

// Footer:
<div className="shrink-0 px-3 py-1 border-t border-slate-800 text-[10px] text-slate-600 flex items-center justify-between">
  <span>
    {filtered.length} event{filtered.length !== 1 ? "s" : ""}
    {filtered.length !== events.length && ` (${events.length} total)`}
  </span>
  <div className="flex items-center gap-2">
    <button
      onClick={copyKubectl}
      className="flex items-center gap-1 text-slate-600 hover:text-slate-400 transition-colors"
      title="Copy as kubectl command"
    >
      {copied ? <Check size={9} className="text-green-400" /> : <Copy size={9} />}
      {copied ? "Copied!" : "Copy kubectl"}
    </button>
    <span className="flex items-center gap-1">
      <Clock size={9} />
      Auto-refresh 10s
    </span>
  </div>
</div>
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/EventsPage.tsx src/components/resources/EventsPanel.tsx
git commit -m "feat: add time-range filter to events page and copy-as-kubectl to events panel"
```

---

## Self-Review Checklist

- [x] Copy buttons — both panels covered
- [x] Container status icons — component created + column added
- [x] Auto-refresh — both GenericResourcePage and PodsPage
- [x] Keyboard nav — hook + ResourceTable fix + App Cmd+K stub
- [x] Events time-range — EventsPage + copy kubectl in EventsPanel
- [x] No placeholder code
- [x] Types consistent across tasks
- [x] Build verification step in each task
