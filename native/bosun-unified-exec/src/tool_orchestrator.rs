use std::collections::HashMap;

use serde_json::{json, Value};

use crate::async_watcher::{AsyncWatcherService, WatchRequest};
use crate::head_tail_buffer::{buffer_items, truncate_text, BufferLimits};
use crate::process_manager::{ProcessManager, RunProcessRequest};

fn as_u64(value: Option<&Value>, fallback: u64) -> u64 {
    value.and_then(|entry| entry.as_u64()).unwrap_or(fallback)
}

fn as_usize(value: Option<&Value>, fallback: usize) -> usize {
    value
        .and_then(|entry| entry.as_u64())
        .map(|entry| entry as usize)
        .unwrap_or(fallback)
}

fn as_string(value: Option<&Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn truncate_output(output: &Value, truncation: &Value) -> Value {
    let max_chars = as_usize(truncation.get("maxChars"), 4000).max(32);
    let tail_chars = as_usize(truncation.get("tailChars"), max_chars / 5).max(16);
    let format = if output.is_string() { "text" } else { "json" };
    let serialized = if format == "text" {
        output.as_str().unwrap_or_default().to_string()
    } else {
        serde_json::to_string_pretty(output)
            .unwrap_or_else(|_| json!({ "preview": format!("{output:?}") }).to_string())
    };
    let truncated = truncate_text(&serialized, max_chars, tail_chars);
    let original_bytes = serialized.as_bytes().len();
    let retained_bytes = truncated.text.as_bytes().len();

    if !truncated.truncated {
        return json!({
            "format": format,
            "data": if format == "text" { Value::String(serialized.clone()) } else { output.clone() },
            "preview": serialized,
            "truncated": false,
            "originalChars": truncated.original_chars,
            "retainedChars": truncated.retained_chars,
            "originalBytes": original_bytes,
            "retainedBytes": retained_bytes,
        });
    }

    json!({
        "format": format,
        "data": if format == "text" {
            Value::String(truncated.text.clone())
        } else {
            json!({
                "truncated": true,
                "preview": truncated.text.clone(),
            })
        },
        "preview": truncated.text,
        "truncated": true,
        "originalChars": truncated.original_chars,
        "retainedChars": truncated.retained_chars,
        "originalBytes": original_bytes,
        "retainedBytes": retained_bytes,
    })
}

fn parse_env(request: &Value) -> HashMap<String, String> {
    request
        .get("env")
        .and_then(|entry| entry.as_object())
        .map(|entries| {
            entries
                .iter()
                .map(|(key, value)| (key.clone(), as_string(Some(value))))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default()
}

#[derive(Debug, Default)]
pub struct UnifiedExecService {
    process_manager: ProcessManager,
    watcher: AsyncWatcherService,
}

impl UnifiedExecService {
    pub fn new() -> Self {
        Self {
            process_manager: ProcessManager::new(),
            watcher: AsyncWatcherService::new(),
        }
    }

    pub fn handle_request(&self, request: &Value) -> Result<Value, String> {
        let command = request
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or_default();

        match command {
            "status" => Ok(json!({
                "service": "bosun-unified-exec",
                "version": env!("CARGO_PKG_VERSION"),
                "protocolVersion": 1,
                "processManager": self.process_manager.snapshot(),
                "watcher": self.watcher.snapshot(),
            })),
            "truncate_output" => {
                let output = request.get("output").cloned().unwrap_or(Value::Null);
                let truncation = request.get("truncation").cloned().unwrap_or_else(|| json!({}));
                Ok(json!({
                    "service": "bosun-unified-exec",
                    "version": env!("CARGO_PKG_VERSION"),
                    "result": truncate_output(&output, &truncation),
                }))
            }
            "buffer_items" => {
                let items = request
                    .get("items")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let limits = request.get("limits").cloned().unwrap_or_else(|| json!({}));
                let result = buffer_items(
                    &items,
                    BufferLimits {
                        max_items: as_usize(limits.get("maxItems"), items.len()),
                        max_item_chars: as_usize(limits.get("maxItemChars"), 4000),
                    },
                    as_usize(limits.get("droppedItems"), 0),
                );
                Ok(json!({
                    "service": "bosun-unified-exec",
                    "version": env!("CARGO_PKG_VERSION"),
                    "items": result.items,
                    "droppedItems": result.dropped_items,
                    "notice": result.notice,
                }))
            }
            "run_process" => self.process_manager.run_process(RunProcessRequest {
                process_id: as_string(request.get("processId")),
                command: as_string(request.get("command")),
                args: request
                    .get("args")
                    .and_then(|value| value.as_array())
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| as_string(Some(entry)))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                cwd: Some(as_string(request.get("cwd"))).filter(|value| !value.is_empty()),
                env: parse_env(request),
                stdin: Some(as_string(request.get("stdin"))).filter(|value| !value.is_empty()),
                timeout_ms: as_u64(request.get("timeoutMs"), 60_000),
                max_buffer_bytes: as_usize(request.get("maxBufferBytes"), 64 * 1024),
                tail_buffer_bytes: as_usize(request.get("tailBufferBytes"), 12 * 1024),
            }),
            "cancel_process" => self
                .process_manager
                .cancel_process(&as_string(request.get("processId"))),
            "watch_paths" => self.watcher.watch_paths(WatchRequest {
                paths: request
                    .get("paths")
                    .and_then(|value| value.as_array())
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| as_string(Some(entry)))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                timeout_ms: as_u64(request.get("timeoutMs"), 2_000),
                poll_ms: as_u64(request.get("pollMs"), 50),
            }),
            _ => Err(format!("unknown_command:{command}")),
        }
    }
}
