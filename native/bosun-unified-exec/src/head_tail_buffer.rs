use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy)]
pub struct BufferLimits {
    pub max_items: usize,
    pub max_item_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TruncateResult {
    pub text: String,
    pub truncated: bool,
    pub original_chars: usize,
    pub retained_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ByteBufferSnapshot {
    pub text: String,
    pub truncated: bool,
    pub original_bytes: usize,
    pub retained_bytes: usize,
    pub dropped_bytes: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BufferResult {
    pub items: Vec<Value>,
    pub dropped_items: usize,
    pub notice: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct HeadTailByteBuffer {
    max_bytes: usize,
    tail_bytes: usize,
    head_budget_bytes: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    original_bytes: usize,
    truncated: bool,
    dropped_bytes: usize,
}

impl HeadTailByteBuffer {
    pub fn new(max_bytes: usize, tail_bytes: usize) -> Self {
        let bounded_max = max_bytes.max(1024);
        let bounded_tail = tail_bytes.max(256).min(bounded_max.saturating_sub(256));
        Self {
            max_bytes: bounded_max,
            tail_bytes: bounded_tail,
            head_budget_bytes: bounded_max.saturating_sub(bounded_tail),
            head: Vec::new(),
            tail: Vec::new(),
            original_bytes: 0,
            truncated: false,
            dropped_bytes: 0,
        }
    }

    pub fn push_bytes(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.original_bytes += chunk.len();

        if !self.truncated && self.head.len() + chunk.len() <= self.head_budget_bytes {
            self.head.extend_from_slice(chunk);
            return;
        }

        self.truncated = true;
        self.dropped_bytes += chunk.len();
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > self.tail_bytes {
            let keep_from = self.tail.len() - self.tail_bytes;
            self.tail = self.tail[keep_from..].to_vec();
        }
    }

    pub fn snapshot(&self) -> ByteBufferSnapshot {
        let mut text = String::from_utf8_lossy(&self.head).into_owned();
        if self.truncated {
            text.push_str(&format!("\n...truncated {} bytes...\n", self.dropped_bytes));
            text.push_str(&String::from_utf8_lossy(&self.tail));
        }
        ByteBufferSnapshot {
            retained_bytes: text.as_bytes().len(),
            text,
            truncated: self.truncated,
            original_bytes: self.original_bytes,
            dropped_bytes: self.dropped_bytes,
            max_bytes: self.max_bytes,
        }
    }
}

pub fn truncate_text(value: &str, max_chars: usize, tail_chars: usize) -> TruncateResult {
    let effective_max = max_chars.max(32);
    if value.chars().count() <= effective_max {
        return TruncateResult {
            text: value.to_string(),
            truncated: false,
            original_chars: value.chars().count(),
            retained_chars: value.chars().count(),
        };
    }

    let marker = "…truncated";
    let effective_tail = tail_chars.min(effective_max / 2);
    let head_chars = effective_max
        .saturating_sub(effective_tail)
        .saturating_sub(marker.chars().count())
        .saturating_sub(2);

    let head: String = value.chars().take(head_chars).collect();
    let tail: String = value
        .chars()
        .rev()
        .take(effective_tail)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let text = format!("{head}\n{marker}\n{tail}");
    TruncateResult {
        text: text.clone(),
        truncated: true,
        original_chars: value.chars().count(),
        retained_chars: text.chars().count(),
    }
}

fn truncate_known_fields(map: &Map<String, Value>, max_chars: usize) -> Map<String, Value> {
    let mut next = Map::new();
    for (key, value) in map.iter() {
        let updated = match value {
            Value::String(text)
                if matches!(
                    key.as_str(),
                    "text" | "output" | "aggregated_output" | "stderr" | "stdout" | "result" | "message"
                ) =>
            {
                Value::String(truncate_text(text, max_chars, max_chars / 5).text)
            }
            Value::Array(entries) if key == "content" => Value::Array(
                entries
                    .iter()
                    .map(|entry| truncate_json_value(entry, max_chars))
                    .collect(),
            ),
            Value::Object(error_map) if key == "error" => {
                Value::Object(truncate_known_fields(error_map, max_chars))
            }
            _ => value.clone(),
        };
        next.insert(key.clone(), updated);
    }
    next
}

pub fn truncate_json_value(value: &Value, max_chars: usize) -> Value {
    match value {
        Value::Object(map) => Value::Object(truncate_known_fields(map, max_chars)),
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| truncate_json_value(entry, max_chars))
                .collect(),
        ),
        Value::String(text) => Value::String(truncate_text(text, max_chars, max_chars / 5).text),
        _ => value.clone(),
    }
}

pub fn buffer_items(items: &[Value], limits: BufferLimits, dropped_items: usize) -> BufferResult {
    let bounded_items = if limits.max_items > 0 {
        items.iter().take(limits.max_items).cloned().collect::<Vec<_>>()
    } else {
        items.to_vec()
    };
    let overflow = items.len().saturating_sub(bounded_items.len());
    let total_dropped = dropped_items + overflow;
    let truncated_items = bounded_items
        .iter()
        .map(|item| truncate_json_value(item, limits.max_item_chars.max(64)))
        .collect::<Vec<_>>();
    let notice = if total_dropped > 0 {
        Some(json!({
            "type": "stream_notice",
            "text": format!(
                "Dropped {} completed items to stay within INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN={}.",
                total_dropped,
                limits.max_items.max(1)
            ),
        }))
    } else {
        None
    };

    BufferResult {
        items: truncated_items,
        dropped_items: total_dropped,
        notice,
    }
}

#[cfg(test)]
mod tests {
    use super::{buffer_items, truncate_text, BufferLimits};
    use serde_json::json;

    #[test]
    fn truncates_large_text_with_head_tail_shape() {
        let truncated = truncate_text(&"x".repeat(160), 48, 8);
        assert!(truncated.truncated);
        assert!(truncated.text.contains("…truncated"));
        assert!(truncated.retained_chars <= 48);
    }

    #[test]
    fn buffers_and_notices_when_items_overflow() {
        let items = vec![
            json!({ "type": "agent_message", "text": "a".repeat(120) }),
            json!({ "type": "agent_message", "text": "b".repeat(120) }),
        ];
        let result = buffer_items(
            &items,
            BufferLimits {
                max_items: 1,
                max_item_chars: 40,
            },
            0,
        );
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.dropped_items, 1);
        assert!(result.notice.is_some());
    }
}
