use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

mod export;
mod metrics;
mod session_telemetry;

const PROTOCOL_VERSION: u32 = 1;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut service = session_telemetry::TelemetryService::new();

    for line in stdin.lock().lines() {
        let raw_line = match line {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({
                        "id": null,
                        "ok": false,
                        "protocolVersion": PROTOCOL_VERSION,
                        "error": format!("stdin_read_failed: {}", error),
                    })
                );
                let _ = stdout.flush();
                continue;
            }
        };

        if raw_line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&raw_line) {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({
                        "id": null,
                        "ok": false,
                        "protocolVersion": PROTOCOL_VERSION,
                        "error": format!("invalid_json: {}", error),
                    })
                );
                let _ = stdout.flush();
                continue;
            }
        };

        let response_id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match service.handle_request(&request) {
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

        let _ = writeln!(stdout, "{}", response);
        let _ = stdout.flush();
    }
}
