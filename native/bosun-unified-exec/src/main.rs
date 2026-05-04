use std::{
    io::{self, BufRead, Write},
    sync::{mpsc, Arc},
    thread,
};

use serde_json::{json, Value};

mod async_watcher;
mod head_tail_buffer;
mod process_manager;
mod tool_orchestrator;

const PROTOCOL_VERSION: u32 = 1;

fn main() {
    let stdin = io::stdin();
    let (response_tx, response_rx) = mpsc::channel::<Value>();
    let service = Arc::new(tool_orchestrator::UnifiedExecService::new());

    let writer = thread::spawn(move || {
        let mut stdout = io::stdout();
        for payload in response_rx {
            let _ = writeln!(stdout, "{}", payload);
            let _ = stdout.flush();
        }
    });

    for line in stdin.lock().lines() {
        let raw_line = match line {
            Ok(value) => value,
            Err(error) => {
                let _ = response_tx.send(json!({
                    "id": null,
                    "ok": false,
                    "protocolVersion": PROTOCOL_VERSION,
                    "error": format!("stdin_read_failed: {}", error),
                }));
                continue;
            }
        };

        if raw_line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&raw_line) {
            Ok(value) => value,
            Err(error) => {
                let _ = response_tx.send(json!({
                    "id": null,
                    "ok": false,
                    "protocolVersion": PROTOCOL_VERSION,
                    "error": format!("invalid_json: {}", error),
                }));
                continue;
            }
        };

        let tx = response_tx.clone();
        let request_value = request.clone();
        let service = Arc::clone(&service);
        thread::spawn(move || {
            let response = service.handle_request(&request_value);
            let response_id = request_value.get("id").cloned().unwrap_or(Value::Null);
            let payload = match response {
                Ok(mut payload) => {
                    payload["id"] = response_id;
                    payload["ok"] = Value::Bool(true);
                    payload["protocolVersion"] = Value::from(PROTOCOL_VERSION);
                    payload
                }
                Err(message) => json!({
                    "id": response_id,
                    "ok": false,
                    "protocolVersion": PROTOCOL_VERSION,
                    "error": message,
                }),
            };
            let _ = tx.send(payload);
        });
    }

    drop(response_tx);
    let _ = writer.join();
}
