use std::collections::HashMap;

use serde_json::{json, Value};

fn text(value: Option<&Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(|entry| entry.as_f64()).unwrap_or(0.0)
}

pub fn summarize_events(events: &[Value]) -> Value {
    let mut by_category: HashMap<String, usize> = HashMap::new();
    let mut total_tokens = 0.0;
    let mut cost_usd = 0.0;
    let mut retries = 0.0;
    let mut approvals = 0usize;

    for event in events.iter() {
      let category = text(event.get("category"));
      let category_key = if category.is_empty() { "runtime".to_string() } else { category };
      *by_category.entry(category_key).or_insert(0) += 1;
      total_tokens += number(event.get("tokenUsage").and_then(|usage| usage.get("totalTokens")));
      cost_usd += number(event.get("costUsd"));
      retries += number(event.get("retryCount"));
      if !text(event.get("approvalId")).is_empty() {
        approvals += 1;
      }
    }

    json!({
      "totals": {
        "events": events.len(),
        "totalTokens": total_tokens,
        "costUsd": cost_usd,
        "retries": retries,
        "approvals": approvals,
      },
      "categories": by_category,
    })
}

pub fn live_snapshot(events: &[Value]) -> Value {
    let mut sessions: HashMap<String, (String, usize, f64, String, String)> = HashMap::new();
    let mut tools: HashMap<String, (usize, f64)> = HashMap::new();

    for event in events.iter() {
      let session_id = text(event.get("sessionId"));
      let task_id = text(event.get("taskId"));
      let tool_name = text(event.get("toolName"));
      let approval_id = text(event.get("approvalId"));
      let tokens = number(event.get("tokenUsage").and_then(|usage| usage.get("totalTokens")));
      let session_entry = sessions
        .entry(session_id.clone())
        .or_insert((task_id.clone(), 0usize, 0.0, String::new(), String::new()));
      session_entry.0 = if task_id.is_empty() { session_entry.0.clone() } else { task_id };
      session_entry.1 += 1;
      session_entry.2 += tokens;
      if !approval_id.is_empty() {
        session_entry.3 = approval_id;
      }
      if !tool_name.is_empty() {
        session_entry.4 = tool_name.clone();
        let tool_entry = tools.entry(tool_name).or_insert((0usize, 0.0));
        tool_entry.0 += 1;
        tool_entry.1 += number(event.get("retryCount"));
      }
    }

    json!({
      "sessions": sessions.into_iter().map(|(session_id, (task_id, total_events, total_tokens, last_approval_id, last_tool_name))| json!({
        "sessionId": session_id,
        "taskId": if task_id.is_empty() { Value::Null } else { Value::String(task_id) },
        "totalEvents": total_events,
        "totalTokens": total_tokens,
        "lastApprovalId": if last_approval_id.is_empty() { Value::Null } else { Value::String(last_approval_id) },
        "lastToolName": if last_tool_name.is_empty() { Value::Null } else { Value::String(last_tool_name) },
      })).collect::<Vec<_>>(),
      "tools": tools.into_iter().map(|(tool_name, (total_calls, total_retries))| json!({
        "toolName": tool_name,
        "totalCalls": total_calls,
        "totalRetries": total_retries,
      })).collect::<Vec<_>>(),
    })
}

pub fn provider_usage(events: &[Value]) -> Value {
    let mut providers: HashMap<String, (String, usize, f64)> = HashMap::new();
    for event in events.iter() {
      let provider_id = text(event.get("providerId"));
      if provider_id.is_empty() {
        continue;
      }
      let model_id = text(event.get("modelId"));
      let entry = providers.entry(provider_id).or_insert((model_id.clone(), 0usize, 0.0));
      if !model_id.is_empty() {
        entry.0 = model_id;
      }
      entry.1 += 1;
      entry.2 += number(event.get("tokenUsage").and_then(|usage| usage.get("totalTokens")));
    }

    Value::Array(providers.into_iter().map(|(provider_id, (model_id, requests, total_tokens))| json!({
      "providerId": provider_id,
      "modelId": if model_id.is_empty() { Value::Null } else { Value::String(model_id) },
      "requests": requests,
      "totalTokens": total_tokens,
    })).collect())
}
