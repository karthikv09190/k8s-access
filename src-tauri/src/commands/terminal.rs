use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Emitter;
use uuid::Uuid;

use crate::kubectl::kubectl_path;

pub struct TerminalSession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub reader_handle: tokio::task::JoinHandle<()>,
}

pub struct TerminalState {
    pub sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
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

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell_cmd = shell.unwrap_or_else(|| "sh".to_string());

    let mut cmd = CommandBuilder::new(kubectl_path());
    let mut args = vec![
        "exec".to_string(),
        "-it".to_string(),
        pod_name,
        "-n".to_string(),
        namespace,
        "--context".to_string(),
        context,
    ];
    if let Some(c) = container {
        args.push("-c".to_string());
        args.push(c);
    }
    args.push("--".to_string());
    args.push(shell_cmd);
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let tid = terminal_id.clone();
    let app2 = app.clone();

    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let encoded = STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(&format!("terminal-output-{}", tid), encoded);
                }
            }
        }
    });

    state.sessions.lock().unwrap().insert(
        terminal_id.clone(),
        TerminalSession {
            writer,
            master: pair.master,
            reader_handle,
        },
    );

    Ok(terminal_id)
}

#[tauri::command]
pub async fn write_terminal(
    terminal_id: String,
    data: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&terminal_id) {
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
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&terminal_id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_terminal(
    terminal_id: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().remove(&terminal_id) {
        session.reader_handle.abort();
    }
    Ok(())
}
