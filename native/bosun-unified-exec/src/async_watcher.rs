use std::{
    collections::HashMap,
    fs,
    sync::Mutex,
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct WatchRequest {
    pub paths: Vec<String>,
    pub timeout_ms: u64,
    pub poll_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsyncWatcherSnapshot {
    pub protocol_version: u32,
    pub queueing_strategy: &'static str,
    pub ready: bool,
    pub poll_mode: &'static str,
    pub watch_requests: u64,
    pub change_detections: u64,
    pub timed_out_requests: u64,
}

#[derive(Debug, Default)]
struct AsyncWatcherState {
    watch_requests: u64,
    change_detections: u64,
    timed_out_requests: u64,
}

#[derive(Debug, Default)]
pub struct AsyncWatcherService {
    state: Mutex<AsyncWatcherState>,
}

fn read_watch_stamp(path: &str) -> String {
    match fs::metadata(path) {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .unwrap_or_default();
            format!("{modified}:{}", metadata.len())
        }
        Err(_) => "missing".to_string(),
    }
}

impl AsyncWatcherService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(AsyncWatcherState::default()),
        }
    }

    pub fn snapshot(&self) -> AsyncWatcherSnapshot {
        let state = self.state.lock().expect("watcher poisoned");
        AsyncWatcherSnapshot {
            protocol_version: 1,
            queueing_strategy: "stdio-jsonl",
            ready: true,
            poll_mode: "stat-poll",
            watch_requests: state.watch_requests,
            change_detections: state.change_detections,
            timed_out_requests: state.timed_out_requests,
        }
    }

    pub fn watch_paths(&self, request: WatchRequest) -> Result<Value, String> {
        let paths = request
            .paths
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Err("paths is required".to_string());
        }

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "watch_state_poisoned".to_string())?;
            state.watch_requests += 1;
        }

        let timeout_ms = request.timeout_ms.max(1);
        let poll_ms = request.poll_ms.max(1);
        let baseline = paths
            .iter()
            .map(|path| (path.clone(), read_watch_stamp(path)))
            .collect::<HashMap<_, _>>();
        let started_at = Instant::now();

        loop {
            let changed_paths = paths
                .iter()
                .filter(|path| baseline.get(*path).map(|value| value != &read_watch_stamp(path)).unwrap_or(true))
                .cloned()
                .collect::<Vec<_>>();
            if !changed_paths.is_empty() {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "watch_state_poisoned".to_string())?;
                state.change_detections += 1;
                return Ok(json!({
                    "service": "bosun-unified-exec",
                    "version": env!("CARGO_PKG_VERSION"),
                    "changed": true,
                    "changedPaths": changed_paths,
                    "timedOut": false,
                    "durationMs": ((started_at.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0),
                }));
            }

            if started_at.elapsed() >= Duration::from_millis(timeout_ms) {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "watch_state_poisoned".to_string())?;
                state.timed_out_requests += 1;
                return Ok(json!({
                    "service": "bosun-unified-exec",
                    "version": env!("CARGO_PKG_VERSION"),
                    "changed": false,
                    "changedPaths": Vec::<String>::new(),
                    "timedOut": true,
                    "durationMs": ((started_at.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0),
                }));
            }

            thread::sleep(Duration::from_millis(poll_ms));
        }
    }
}
