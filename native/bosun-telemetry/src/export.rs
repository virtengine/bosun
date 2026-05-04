use chrono::DateTime;
use serde_json::{json, Map, Value};

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|entry| entry.as_str())
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|entry| entry.as_f64())
}

fn timestamp_micros(value: Option<&Value>) -> i64 {
    value
        .and_then(|entry| entry.as_str())
        .and_then(|entry| chrono_like_to_micros(entry))
        .unwrap_or_else(|| current_micros())
}

fn current_micros() -> i64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_micros() as i64)
        .unwrap_or_default()
}

fn chrono_like_to_micros(value: &str) -> Option<i64> {
    if let Ok(parsed) = value.parse::<i64>() {
        return Some(parsed);
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_micros())
}

fn build_trace_args(event: &Value) -> Value {
    let keys = [
        "source",
        "category",
        "taskId",
        "sessionId",
        "threadId",
        "runId",
        "rootRunId",
        "parentRunId",
        "childRunId",
        "traceId",
        "spanId",
        "parentSpanId",
        "executionId",
        "executionKey",
        "executionKind",
        "executionLabel",
        "parentExecutionId",
        "causedByExecutionId",
        "parentSessionId",
        "childSessionId",
        "parentTaskId",
        "childTaskId",
        "subagentId",
        "providerId",
        "providerKind",
        "modelId",
        "toolId",
        "toolName",
        "approvalId",
        "artifactId",
        "artifactPath",
        "filePath",
        "fileHash",
        "patchHash",
        "workflowId",
        "workflowName",
        "nodeId",
        "nodeType",
        "nodeLabel",
        "stageId",
        "stageType",
        "commandId",
        "commandName",
        "surface",
        "channel",
        "action",
        "workspaceId",
        "repoRoot",
        "branch",
        "prUrl",
        "actor",
        "status",
        "summary",
    ];
    let mut map = Map::new();
    for key in keys {
        map.insert(
            key.to_string(),
            text(event.get(key))
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    }
    map.insert(
        "prNumber".to_string(),
        event.get("prNumber").cloned().unwrap_or(Value::Null),
    );
    map.insert(
        "retryCount".to_string(),
        Value::from(event.get("retryCount").and_then(|entry| entry.as_i64()).unwrap_or(0)),
    );
    map.insert(
        "durationMs".to_string(),
        Value::from(number(event.get("durationMs")).unwrap_or(0.0)),
    );
    map.insert(
        "latencyMs".to_string(),
        Value::from(number(event.get("latencyMs").or_else(|| event.get("durationMs"))).unwrap_or(0.0)),
    );
    map.insert(
        "costUsd".to_string(),
        Value::from(number(event.get("costUsd")).unwrap_or(0.0)),
    );
    map.insert(
        "tokenUsage".to_string(),
        event.get("tokenUsage").cloned().unwrap_or(Value::Null),
    );
    Value::Object(map)
}

pub fn export_trace(events: &[Value]) -> Value {
    json!({
        "schemaVersion": 1,
        "format": "chrome-trace",
        "displayTimeUnit": "ms",
        "traceEvents": events.iter().map(|event| {
            let duration_ms = number(event.get("durationMs").or_else(|| event.get("latencyMs"))).unwrap_or(0.0);
            json!({
                "name": text(event.get("eventType").or_else(|| event.get("type"))).unwrap_or_else(|| "event".to_string()),
                "cat": text(event.get("category").or_else(|| event.get("source"))).unwrap_or_else(|| "runtime".to_string()),
                "ph": if duration_ms > 0.0 { "X" } else { "i" },
                "s": if duration_ms > 0.0 { Value::Null } else { Value::String("t".to_string()) },
                "ts": timestamp_micros(event.get("timestamp").or_else(|| event.get("ts"))),
                "dur": if duration_ms > 0.0 { Value::from((duration_ms * 1000.0) as i64) } else { Value::Null },
                "pid": "bosun-harness",
                "tid": text(event.get("threadId").or_else(|| event.get("sessionId")).or_else(|| event.get("runId")).or_else(|| event.get("taskId")))
                    .unwrap_or_else(|| "runtime".to_string()),
                "args": build_trace_args(event),
            })
        }).collect::<Vec<_>>(),
    })
}
