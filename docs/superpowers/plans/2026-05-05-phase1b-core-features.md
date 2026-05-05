# Phase 1B — Core Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement streaming logs, interactive PTY terminal, deployment rollout history/rollback, and resource creation modal.

**Architecture:** Rust backend additions (streaming via Tauri events, PTY via portable-pty, kubectl shell commands for rollout) + React frontend rewrites. All new Rust commands registered in lib.rs.

**Tech Stack:** Rust (`portable-pty`, `dashmap`, `uuid`, `base64`), `@xterm/xterm` v6 + `FitAddon`, Monaco DiffEditor, React Query, Tauri events

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `portable-pty`, `dashmap`, `uuid`, `base64` |
| `src-tauri/src/commands/logs.rs` | Add `start_log_stream`, `stop_log_stream` commands |
| `src-tauri/src/commands/terminal.rs` | **Create** — PTY spawn, I/O bridge via Tauri events |
| `src-tauri/src/commands/exec.rs` | Add `get_rollout_history`, `rollback_rollout`, `get_rollout_status` |
| `src-tauri/src/lib.rs` | Register all new commands; add `LogStreamState`, `TerminalState` |
| `src/lib/tauri.ts` | Add TS wrappers for all new commands |
| `src/components/logs/PodLogsPanel.tsx` | Full rewrite — streaming + follow toggle + search + download |
| `src/components/pods/ExecPanel.tsx` | Full rewrite — xterm.js PTY terminal + quick exec fallback |
| `src/components/pods/PodActionsPanel.tsx` | Add `"terminal"` tab |
| `src/components/resources/RolloutPanel.tsx` | **Create** — history table + rollback |
| `src/components/resources/ResourceActionsPanel.tsx` | Add `"rollout"` tab type |
| `src/App.tsx` | Add `"rollout"` to deployment/statefulset actionTabs |
| `src/components/resources/CreateResourceModal.tsx` | **Create** — Monaco editor + templates + dry-run |
| `src/pages/GenericResourcePage.tsx` | Add `+ Create` button → open modal |

---

### Task 6: Streaming Logs — Rust Backend

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/logs.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Cargo dependencies**

In `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
dashmap = "6"
uuid = { version = "1", features = ["v4"] }
tokio-util = { version = "0.7", features = ["codec"] }
```

- [ ] **Step 2: Add LogStreamState to lib.rs**

Add after existing `use` statements in `src-tauri/src/lib.rs`:

```rust
use commands::logs::{LogStreamState, start_log_stream, stop_log_stream};
```

Add to `.manage()` chain in `run()`:

```rust
.manage(LogStreamState::default())
```

Add to `invoke_handler`:
```rust
start_log_stream,
stop_log_stream,
```

- [ ] **Step 3: Add streaming commands to logs.rs**

Append to `src-tauri/src/commands/logs.rs`:

```rust
use std::sync::Arc;
use dashmap::DashMap;
use tokio::sync::CancellationToken;
use uuid::Uuid;
use kube::{api::LogParams, Api};
use k8s_openapi::api::core::v1::Pod;
use futures::AsyncBufReadExt;

#[derive(Default)]
pub struct LogStreamState {
    pub streams: Arc<DashMap<String, CancellationToken>>,
}

#[tauri::command]
pub async fn start_log_stream(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, LogStreamState>,
) -> Result<String, String> {
    let stream_id = Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.streams.insert(stream_id.clone(), token.clone());

    let sid = stream_id.clone();
    let app2 = app.clone();

    tokio::spawn(async move {
        let opts = kube::config::KubeConfigOptions {
            context: Some(context.clone()),
            ..Default::default()
        };
        let config = match kube::Config::from_kubeconfig(&opts).await {
            Ok(c) => c,
            Err(e) => {
                let _ = app2.emit(&format!("log-error-{}", sid), e.to_string());
                return;
            }
        };
        let client = match kube::Client::try_from(config) {
            Ok(c) => c,
            Err(e) => {
                let _ = app2.emit(&format!("log-error-{}", sid), e.to_string());
                return;
            }
        };

        let api: Api<Pod> = Api::namespaced(client, &namespace);
        let params = LogParams {
            follow: true,
            tail_lines,
            container: container.clone(),
            ..Default::default()
        };

        let stream = match api.log_stream(&pod_name, &params).await {
            Ok(s) => s,
            Err(e) => {
                let _ = app2.emit(&format!("log-error-{}", sid), e.to_string());
                return;
            }
        };

        use futures::TryStreamExt;
        let mut lines = stream.lines();

        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                line = lines.try_next() => {
                    match line {
                        Ok(Some(l)) => {
                            let _ = app2.emit(&format!("log-line-{}", sid), l);
                        }
                        _ => break,
                    }
                }
            }
        }
    });

    Ok(stream_id)
}

#[tauri::command]
pub async fn stop_log_stream(
    stream_id: String,
    state: tauri::State<'_, LogStreamState>,
) -> Result<(), String> {
    if let Some((_, token)) = state.streams.remove(&stream_id) {
        token.cancel();
    }
    Ok(())
}
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd /Users/karthikvellingiri/k8s-manager/src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/logs.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add start_log_stream and stop_log_stream Tauri commands"
```

---

### Task 7: Streaming Logs — Frontend Rewrite

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/logs/PodLogsPanel.tsx`

- [ ] **Step 1: Add TS wrappers to tauri.ts**

```ts
// ── Log streaming ─────────────────────────────────────────────────────────────
export const startLogStream = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
}) => invoke<string>("start_log_stream", args);

export const stopLogStream = (streamId: string) =>
  invoke<void>("stop_log_stream", { streamId });
```

- [ ] **Step 2: Rewrite PodLogsPanel.tsx**

```tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getPodContainers, startLogStream, stopLogStream, getPodLogs } from "../../lib/tauri";
import { Download, Pause, Play, Search, X, Loader2 } from "lucide-react";

const MAX_LINES = 5000;

interface Props {
  context: string;
  namespace: string;
  podName: string;
}

export function PodLogsPanel({ context, namespace, podName }: Props) {
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamId, setStreamId] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const streamIdRef = useRef<string | null>(null);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers", context, namespace, podName],
    queryFn: () => getPodContainers({ context, namespace, podName }),
  });

  useEffect(() => {
    if (containers.length && !container) setContainer(containers[0]);
  }, [containers]);

  // Start/stop stream when container or follow changes
  useEffect(() => {
    if (!container && containers.length > 0) return;
    if (!follow) return;

    let unlisten: (() => void) | null = null;
    let currentStreamId: string | null = null;

    const start = async () => {
      setLines([]);
      const sid = await startLogStream({
        context, namespace, podName, container, tailLines: 200,
      });
      currentStreamId = sid;
      streamIdRef.current = sid;
      setStreamId(sid);

      unlisten = await listen<string>(`log-line-${sid}`, (event) => {
        if (paused) return;
        setLines((prev) => {
          const next = [...prev, event.payload];
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        });
      });
    };

    start();

    return () => {
      if (currentStreamId) stopLogStream(currentStreamId);
      unlisten?.();
    };
  }, [context, namespace, podName, container, follow]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20);
  };

  const download = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${podName}-${container ?? "default"}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const displayed = search.trim()
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900 flex-wrap">
        <span className="text-xs text-slate-400 font-semibold shrink-0">LOGS</span>

        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
          >
            {(containers as string[]).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}

        {/* Follow toggle */}
        <button
          onClick={() => setFollow((f) => !f)}
          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
            follow
              ? "bg-green-500/15 border-green-500/30 text-green-400"
              : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300"
          }`}
        >
          {follow ? <Loader2 size={10} className="animate-spin" /> : null}
          {follow ? "Live" : "Static"}
        </button>

        {/* Pause */}
        {follow && (
          <button
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-300 bg-slate-800"
          >
            {paused ? <Play size={10} /> : <Pause size={10} />}
            {paused ? "Resume" : "Pause"}
          </button>
        )}

        <span className="text-xs text-slate-600">{lines.length} lines</span>

        {/* Search */}
        <div className="relative ml-auto">
          <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs…"
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded pl-5 pr-5 py-0.5 w-36 focus:outline-none focus:border-blue-500"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-600">
              <X size={10} />
            </button>
          )}
        </div>

        {/* Download */}
        <button
          onClick={download}
          title="Download log"
          className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800"
        >
          <Download size={12} />
        </button>
      </div>

      {/* Log output */}
      <pre
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-3 text-xs font-mono text-green-400 leading-5 whitespace-pre-wrap break-all"
      >
        {displayed.length === 0
          ? <span className="text-slate-600">Waiting for logs…</span>
          : displayed.map((line, i) => {
              const isMatch = search && line.toLowerCase().includes(search.toLowerCase());
              return (
                <span key={i} className={isMatch ? "bg-yellow-500/20" : ""}>
                  {line}{"\n"}
                </span>
              );
            })
        }
      </pre>

      {/* Scroll-to-bottom indicator */}
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); logRef.current!.scrollTop = logRef.current!.scrollHeight; }}
          className="absolute bottom-8 right-4 text-xs bg-blue-600 text-white px-2 py-1 rounded shadow"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify TS build**

```bash
cd /Users/karthikvellingiri/k8s-manager && npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts src/components/logs/PodLogsPanel.tsx
git commit -m "feat: streaming log viewer with follow, pause, search, and download"
```

---

### Task 8: Interactive PTY Terminal — Rust Backend

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/terminal.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Cargo dependencies**

In `src-tauri/Cargo.toml`:

```toml
portable-pty = "0.8"
base64 = "0.22"
```

- [ ] **Step 2: Create terminal.rs**

```rust
// src-tauri/src/commands/terminal.rs
use base64::{engine::general_purpose::STANDARD, Engine};
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::Arc;
use tokio::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct TerminalState {
    pub sessions: Arc<DashMap<String, TerminalSession>>,
}

pub struct TerminalSession {
    pub writer: Box<dyn std::io::Write + Send>,
    pub cancel: CancellationToken,
    pub child: Box<dyn portable_pty::Child + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
}

#[tauri::command]
pub async fn start_terminal(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    shell: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
) -> Result<String, String> {
    let terminal_id = Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell_cmd = shell.unwrap_or_else(|| "sh".to_string());

    let mut cmd = CommandBuilder::new("kubectl");
    cmd.args([
        "exec", "-it", &pod_name,
        "-n", &namespace,
        "--context", &context,
    ]);
    if let Some(ref c) = container {
        cmd.args(["-c", c]);
    }
    cmd.args(["--", &shell_cmd]);

    // Set PTY env
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let tid = terminal_id.clone();
    let app2 = app.clone();
    let cancel2 = cancel.clone();

    // Reader task: PTY output → Tauri event
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 1024];
        loop {
            if cancel2.is_cancelled() { break; }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let encoded = STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(&format!("terminal-output-{}", tid), encoded);
                }
            }
        }
    });

    state.sessions.insert(terminal_id.clone(), TerminalSession {
        writer,
        cancel,
        child,
        master: pair.master,
    });

    Ok(terminal_id)
}

#[tauri::command]
pub async fn write_terminal(
    terminal_id: String,
    data: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    if let Some(mut session) = state.sessions.get_mut(&terminal_id) {
        let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;
        session.writer.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    if let Some(session) = state.sessions.get(&terminal_id) {
        session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_terminal(
    terminal_id: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    if let Some((_, mut session)) = state.sessions.remove(&terminal_id) {
        session.cancel.cancel();
        let _ = session.child.kill();
    }
    Ok(())
}
```

Note: `use std::io::Read;` and `use std::io::Write;` must be at the top of the file.

- [ ] **Step 3: Add `pub mod terminal;` to commands/mod.rs**

```rust
pub mod terminal;
```

- [ ] **Step 4: Register in lib.rs**

Add imports:
```rust
use commands::terminal::{TerminalState, start_terminal, write_terminal, resize_terminal, close_terminal};
```

Add `.manage(TerminalState::default())` to the builder chain.

Add to invoke_handler: `start_terminal, write_terminal, resize_terminal, close_terminal`

- [ ] **Step 5: Verify Rust compiles**

```bash
cd /Users/karthikvellingiri/k8s-manager/src-tauri && cargo build 2>&1 | grep -E "^error" | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/terminal.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add PTY terminal commands via portable-pty"
```

---

### Task 9: Interactive PTY Terminal — Frontend

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/pods/ExecPanel.tsx`
- Modify: `src/components/pods/PodActionsPanel.tsx`

- [ ] **Step 1: Add terminal TS wrappers to tauri.ts**

```ts
// ── Terminal ──────────────────────────────────────────────────────────────────
export const startTerminal = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  shell?: string;
}) => invoke<string>("start_terminal", args);

export const writeTerminal = (args: { terminalId: string; data: string }) =>
  invoke<void>("write_terminal", args);

export const resizeTerminal = (args: { terminalId: string; cols: number; rows: number }) =>
  invoke<void>("resize_terminal", args);

export const closeTerminal = (terminalId: string) =>
  invoke<void>("close_terminal", { terminalId });
```

- [ ] **Step 2: Create TerminalPanel component (replaces ExecPanel content)**

Create `src/components/pods/TerminalPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getPodContainers, startTerminal, writeTerminal, resizeTerminal, closeTerminal } from "../../lib/tauri";

const SHELLS = ["sh", "bash", "/bin/bash", "/bin/sh", "/bin/ash"];

interface Props {
  context: string;
  namespace: string;
  podName: string;
}

export function TerminalPanel({ context, namespace, podName }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [shell, setShell] = useState("sh");
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminalIdRef = useRef<string | null>(null);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers", context, namespace, podName],
    queryFn: () => getPodContainers({ context, namespace, podName }),
  });

  useEffect(() => {
    if (containers.length && !container) setContainer(containers[0]);
  }, [containers]);

  // Init xterm
  useEffect(() => {
    if (!termRef.current) return;

    const term = new XTerm({
      theme: { background: "#020617", foreground: "#e2e8f0", cursor: "#60a5fa" },
      fontSize: 12,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      cursorBlink: true,
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();

    term.loadAddon(fit);
    term.loadAddon(webLinks);
    term.open(termRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;

    // Resize observer
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (terminalIdRef.current) {
        resizeTerminal({
          terminalId: terminalIdRef.current,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

  // Connect to backend
  const connect = async () => {
    if (!container && containers.length > 0) return;
    setError(null);

    if (terminalIdRef.current) {
      await closeTerminal(terminalIdRef.current);
    }
    xtermRef.current?.clear();
    xtermRef.current?.write("\r\n\x1b[32mConnecting...\x1b[0m\r\n");

    try {
      const tid = await startTerminal({ context, namespace, podName, container, shell });
      terminalIdRef.current = tid;
      setTerminalId(tid);

      // Listen for output
      const unlisten = await listen<string>(`terminal-output-${tid}`, (event) => {
        const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
        xtermRef.current?.write(bytes);
      });

      // Send input
      const disposeInput = xtermRef.current?.onData((data) => {
        const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(data)));
        writeTerminal({ terminalId: tid, data: encoded });
      });

      // Cleanup stored for unmount
      return () => {
        unlisten();
        disposeInput?.dispose();
        closeTerminal(tid);
      };
    } catch (e: any) {
      setError(String(e));
      xtermRef.current?.write(`\r\n\x1b[31mError: ${e}\x1b[0m\r\n`);
    }
  };

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    if (container !== undefined) {
      connect().then((fn) => { cleanup = fn; });
    }
    return () => { cleanup?.(); };
  }, [context, namespace, podName, container, shell]);

  return (
    <div className="flex flex-col h-full bg-[#020617]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900 shrink-0">
        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
          >
            {(containers as string[]).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <select
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
        >
          {SHELLS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => connect()}
          className="ml-auto text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
        >
          Reconnect
        </button>
      </div>

      {/* xterm container */}
      <div ref={termRef} className="flex-1 p-1 overflow-hidden" />
    </div>
  );
}
```

- [ ] **Step 3: Update ExecPanel to be quick-exec only (keep it for one-shot commands)**

`ExecPanel.tsx` stays as-is (one-shot commands) — no change needed. It remains the "Exec" tab.

- [ ] **Step 4: Add "terminal" tab to PodActionsPanel**

In `PodActionsPanel.tsx`:

```tsx
import { TerminalPanel } from "./TerminalPanel";

type Tab = "logs" | "terminal" | "exec" | "events" | "portforward" | "yaml" | "edit";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "terminal", label: "Terminal", icon: Terminal },  // new
  { id: "exec", label: "Exec", icon: Terminal },
  { id: "events", label: "Events", icon: Activity },
  { id: "portforward", label: "Port Fwd", icon: Wifi },
  { id: "yaml", label: "YAML", icon: FileCode },
  { id: "edit", label: "Edit", icon: Pencil },
];

// In tab content area, add:
{activeTab === "terminal" && (
  <TerminalPanel context={context} namespace={namespace} podName={podName} />
)}
```

- [ ] **Step 5: Verify TS build**

```bash
cd /Users/karthikvellingiri/k8s-manager && npm run build 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/tauri.ts src/components/pods/TerminalPanel.tsx src/components/pods/PodActionsPanel.tsx
git commit -m "feat: interactive PTY terminal tab in pod panel via xterm.js + portable-pty"
```

---

### Task 10: Rollout History & Rollback — Rust

**Files:**
- Modify: `src-tauri/src/commands/exec.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add rollout commands to exec.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RolloutRevision {
    pub revision: u32,
    pub change_cause: String,
}

#[tauri::command]
pub async fn get_rollout_history(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<Vec<RolloutRevision>, String> {
    let output = crate::kubectl::run_kubectl(&[
        "rollout", "history",
        &format!("{}/{}", kind.to_lowercase(), name),
        "-n", &namespace,
        "--context", &context,
    ]).await?;

    let mut revisions = Vec::new();
    for line in output.lines().skip(2) {
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        if let Some(rev_str) = parts.first() {
            if let Ok(rev) = rev_str.trim().parse::<u32>() {
                let change_cause = parts.get(1).map(|s| s.trim()).unwrap_or("<none>").to_string();
                revisions.push(RolloutRevision { revision: rev, change_cause });
            }
        }
    }
    Ok(revisions)
}

#[tauri::command]
pub async fn rollback_rollout(
    context: String,
    namespace: String,
    kind: String,
    name: String,
    revision: u32,
) -> Result<String, String> {
    crate::kubectl::run_kubectl(&[
        "rollout", "undo",
        &format!("{}/{}", kind.to_lowercase(), name),
        "-n", &namespace,
        "--context", &context,
        &format!("--to-revision={}", revision),
    ]).await
}

#[tauri::command]
pub async fn get_rollout_status(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    crate::kubectl::run_kubectl(&[
        "rollout", "status",
        &format!("{}/{}", kind.to_lowercase(), name),
        "-n", &namespace,
        "--context", &context,
        "--timeout=2s",
    ]).await
}
```

- [ ] **Step 2: Check if kubectl.rs has a `run_kubectl` helper**

```bash
grep -n "pub async fn" /Users/karthikvellingiri/k8s-manager/src-tauri/src/kubectl.rs | head -20
```

If `run_kubectl` doesn't exist, check what helpers exist and adapt the above to use the existing pattern. If exec.rs already runs kubectl directly via `std::process::Command` or `tokio::process::Command`, use that pattern instead.

- [ ] **Step 3: Register in lib.rs**

Add to imports:
```rust
use commands::exec::{..., get_rollout_history, rollback_rollout, get_rollout_status};
```

Add to invoke_handler:
```rust
get_rollout_history,
rollback_rollout,
get_rollout_status,
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd /Users/karthikvellingiri/k8s-manager/src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/exec.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add rollout history, rollback, and status commands"
```

---

### Task 11: Rollout History — Frontend

**Files:**
- Modify: `src/lib/tauri.ts`
- Create: `src/components/resources/RolloutPanel.tsx`
- Modify: `src/components/resources/ResourceActionsPanel.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add TS wrappers**

```ts
export interface RolloutRevision {
  revision: number;
  changeCause: string;
}

export const getRolloutHistory = (args: {
  context: string; namespace: string; kind: string; name: string;
}) => invoke<RolloutRevision[]>("get_rollout_history", args);

export const rollbackRollout = (args: {
  context: string; namespace: string; kind: string; name: string; revision: number;
}) => invoke<string>("rollback_rollout", args);

export const getRolloutStatus = (args: {
  context: string; namespace: string; kind: string; name: string;
}) => invoke<string>("get_rollout_status", args);
```

- [ ] **Step 2: Create RolloutPanel.tsx**

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRolloutHistory, rollbackRollout, getRolloutStatus } from "../../lib/tauri";
import { RotateCcw, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}

export function RolloutPanel({ context, namespace, kind, name }: Props) {
  const qc = useQueryClient();
  const [rolling, setRolling] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: history = [], isLoading } = useQuery({
    queryKey: ["rollout-history", context, namespace, kind, name],
    queryFn: () => getRolloutHistory({ context, namespace, kind, name }),
  });

  const { data: status = "" } = useQuery({
    queryKey: ["rollout-status", context, namespace, kind, name],
    queryFn: () => getRolloutStatus({ context, namespace, kind, name }),
    refetchInterval: 5000,
  });

  const rollback = async (revision: number) => {
    setRolling(revision);
    setError(null);
    setResult(null);
    try {
      const msg = await rollbackRollout({ context, namespace, kind, name, revision });
      setResult(msg);
      qc.invalidateQueries({ queryKey: ["rollout-history"] });
    } catch (e: any) {
      setError(String(e));
    } finally {
      setRolling(null);
    }
  };

  const statusOk = status.toLowerCase().includes("successfully") || status.toLowerCase().includes("complete");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Status bar */}
      <div className="shrink-0 px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-2 text-xs">
          {statusOk
            ? <CheckCircle2 size={12} className="text-green-400" />
            : <AlertCircle size={12} className="text-amber-400" />}
          <span className="text-slate-400 font-mono truncate">{status || "Fetching status…"}</span>
        </div>
      </div>

      {/* Feedback */}
      {result && <div className="px-3 py-2 text-xs text-green-400 bg-green-400/10 border-b border-green-400/20">{result}</div>}
      {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-400/10 border-b border-red-400/20">{error}</div>}

      {/* History table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-xs gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading history…
          </div>
        ) : history.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-600 text-xs">
            No rollout history. Requires change-cause annotations.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
              <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="px-3 py-2 text-left w-20">Revision</th>
                <th className="px-3 py-2 text-left">Change Cause</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {history.map((rev, i) => (
                <tr key={rev.revision} className={`border-b border-slate-800/50 ${i === 0 ? "bg-blue-600/5" : "hover:bg-white/5"}`}>
                  <td className="px-3 py-2">
                    <span className="font-mono text-slate-200">#{rev.revision}</span>
                    {i === 0 && <span className="ml-1.5 text-[10px] text-blue-400 bg-blue-400/10 px-1 rounded">current</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-400 font-mono">{rev.changeCause || "<none>"}</td>
                  <td className="px-3 py-2">
                    {i !== 0 && (
                      <button
                        onClick={() => rollback(rev.revision)}
                        disabled={rolling === rev.revision}
                        className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-50"
                      >
                        {rolling === rev.revision
                          ? <Loader2 size={9} className="animate-spin" />
                          : <RotateCcw size={9} />}
                        Rollback
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add "rollout" to ResourceTab and ResourceActionsPanel**

In `ResourceActionsPanel.tsx`:

```tsx
import { RolloutPanel } from "./RolloutPanel";

// Add to ResourceTab type:
| "rollout"

// Add to TAB_CONFIG:
rollout: { label: "Rollout", icon: RotateCcw },

// Add to tab content:
{effectiveTab === "rollout" && (
  <RolloutPanel context={context} namespace={ns} kind={kind} name={name} />
)}
```

- [ ] **Step 4: Add "rollout" to deployments and statefulsets in App.tsx**

```tsx
// deployments actionTabs:
actionTabs={["yaml", "edit", "describe", "events", "scale", "restart", "rollout"]}

// statefulsets actionTabs:
actionTabs={["yaml", "edit", "describe", "events", "scale", "restart", "rollout"]}
```

- [ ] **Step 5: Verify TS build**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/tauri.ts src/components/resources/RolloutPanel.tsx src/components/resources/ResourceActionsPanel.tsx src/App.tsx
git commit -m "feat: rollout history and rollback panel for deployments and statefulsets"
```

---

### Task 12: Resource Creation Modal

**Files:**
- Modify: `src-tauri/src/commands/exec.rs` — add `dry_run` param
- Modify: `src-tauri/src/lib.rs` — no change needed (command name same)
- Create: `src/components/resources/CreateResourceModal.tsx`
- Modify: `src/pages/GenericResourcePage.tsx`

- [ ] **Step 1: Update apply_resource_yaml to support dry-run**

In `exec.rs`, find `apply_resource_yaml` and add `dry_run: Option<bool>` parameter:

```rust
#[tauri::command]
pub async fn apply_resource_yaml(
    context: String,
    yaml: String,
    dry_run: Option<bool>,
) -> Result<String, String> {
    let mut args = vec![
        "apply", "-f", "-",
        "--context", &context,
    ];
    if dry_run.unwrap_or(false) {
        args.push("--dry-run=client");
    }
    // Use existing kubectl invocation pattern
    // Pass yaml via stdin — check how existing code does it and follow same pattern
    crate::kubectl::run_kubectl_with_stdin(&args, yaml.as_bytes()).await
}
```

Check `kubectl.rs` for the stdin variant — if it doesn't exist, add it alongside `run_kubectl`.

- [ ] **Step 2: Create CreateResourceModal.tsx**

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { applyResourceYaml } from "../../lib/tauri";
import { X, Play, AlertCircle, CheckCircle2 } from "lucide-react";

const TEMPLATES: Record<string, string> = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80`,

  Service: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 80`,

  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key: value`,

  Secret: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
data:
  key: dmFsdWU=`,

  Job: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: my-job
        image: busybox
        command: ["sh", "-c", "echo Hello"]
      restartPolicy: Never`,

  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace`,
};

interface Props {
  context: string;
  namespace: string;
  onClose: () => void;
  invalidateKey: string;
}

export function CreateResourceModal({ context, namespace, onClose, invalidateKey }: Props) {
  const qc = useQueryClient();
  const [yaml, setYaml] = useState(TEMPLATES.Deployment);
  const [activeTemplate, setActiveTemplate] = useState("Deployment");
  const [dryRun, setDryRun] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [running, setRunning] = useState(false);

  const apply = async () => {
    setRunning(true);
    setResult(null);
    try {
      const msg = await applyResourceYaml({ context, yaml, dryRun });
      setResult({ ok: true, msg: msg || (dryRun ? "Dry run passed." : "Applied successfully.") });
      if (!dryRun) {
        qc.invalidateQueries({ queryKey: [invalidateKey] });
        setTimeout(onClose, 1000);
      }
    } catch (e: any) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[800px] max-h-[90vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Create Resource</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800">
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Template sidebar */}
          <div className="w-36 shrink-0 border-r border-slate-700 py-2">
            <p className="px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Templates</p>
            {Object.keys(TEMPLATES).map((t) => (
              <button
                key={t}
                onClick={() => { setActiveTemplate(t); setYaml(TEMPLATES[t]); setResult(null); }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  activeTemplate === t ? "text-blue-400 bg-blue-500/10" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language="yaml"
              theme="vs-dark"
              value={yaml}
              onChange={(v) => setYaml(v ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: "on" }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-t border-slate-700">
          {result && (
            <div className={`flex items-center gap-1.5 text-xs flex-1 ${result.ok ? "text-green-400" : "text-red-400"}`}>
              {result.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              <span className="truncate">{result.msg}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="rounded" />
              Dry run
            </label>
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800">
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={running || !yaml.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
            >
              <Play size={11} />
              {running ? "Applying…" : dryRun ? "Dry Run" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update applyResourceYaml wrapper in tauri.ts**

```ts
export const applyResourceYaml = (args: {
  context: string;
  yaml: string;
  dryRun?: boolean;
}) => invoke<string>("apply_resource_yaml", args);
```

- [ ] **Step 4: Add Create button to GenericResourcePage**

```tsx
import { Plus } from "lucide-react";
import { CreateResourceModal } from "../components/resources/CreateResourceModal";

// Add state:
const [showCreate, setShowCreate] = useState(false);

// In header, after search input:
<button
  onClick={() => setShowCreate(true)}
  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white shrink-0"
>
  <Plus size={11} />
  Create
</button>

// Above the table:
{showCreate && (
  <CreateResourceModal
    context={activeContext}
    namespace={activeNamespace || "default"}
    onClose={() => setShowCreate(false)}
    invalidateKey={invokeCmd}
  />
)}
```

- [ ] **Step 5: Verify TS build**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/exec.rs src/components/resources/CreateResourceModal.tsx src/pages/GenericResourcePage.tsx src/lib/tauri.ts
git commit -m "feat: resource creation modal with YAML editor, templates, and dry-run support"
```

---

## Self-Review

- [x] Streaming logs — Rust (LogStreamState, start/stop) + frontend (follow, pause, search, download)
- [x] Terminal — Rust (portable-pty, 4 commands) + frontend (xterm.js, FitAddon, resize, reconnect)
- [x] Rollout — Rust (history, rollback, status) + frontend (RolloutPanel, new tab in deployments/statefulsets)
- [x] Create resource — Rust (dry_run param) + frontend (Monaco + templates + dry-run toggle)
- [x] All types consistent (RolloutRevision, stream_id/terminal_id as strings)
- [x] No placeholder code — all steps have actual implementation
- [x] Build verification at each task
- [x] `run_kubectl` / `run_kubectl_with_stdin` dependency flagged with check step
