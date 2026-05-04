use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::head_tail_buffer::{ByteBufferSnapshot, HeadTailByteBuffer};

const PROCESS_POLL_INTERVAL_MS: u64 = 10;

#[derive(Debug, Clone)]
pub struct RunProcessRequest {
    pub process_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub max_buffer_bytes: usize,
    pub tail_buffer_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessManagerSnapshot {
    pub cancellation_supported: bool,
    pub backpressure_supported: bool,
    pub buffering_mode: &'static str,
    pub active_processes: usize,
    pub completed_runs: u64,
    pub cancelled_runs: u64,
    pub timed_out_runs: u64,
    pub last_process_id: Option<String>,
}

#[derive(Debug, Default)]
struct ProcessManagerState {
    active: HashMap<String, Arc<ProcessControl>>,
    completed_runs: u64,
    cancelled_runs: u64,
    timed_out_runs: u64,
    last_process_id: Option<String>,
}

#[derive(Debug)]
struct ProcessControl {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
    timed_out: AtomicBool,
}

impl ProcessControl {
    fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
            cancelled: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
        }
    }

    fn cancel(&self, timed_out: bool) -> Result<bool, String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "process_lock_poisoned".to_string())?;
        let Some(child) = guard.as_mut() else {
            return Ok(false);
        };
        if timed_out {
            self.timed_out.store(true, Ordering::SeqCst);
        } else {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        child
            .kill()
            .map_err(|error| format!("kill_failed: {error}"))?;
        Ok(true)
    }
}

#[derive(Debug, Default)]
pub struct ProcessManager {
    state: Mutex<ProcessManagerState>,
}

fn read_stream<R: Read + Send + 'static>(
    mut reader: R,
    buffer: Arc<Mutex<HeadTailByteBuffer>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    if let Ok(mut guard) = buffer.lock() {
                        guard.push_bytes(&chunk[..size]);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn take_snapshot(buffer: &Arc<Mutex<HeadTailByteBuffer>>) -> ByteBufferSnapshot {
    match buffer.lock() {
        Ok(guard) => guard.snapshot(),
        Err(_) => HeadTailByteBuffer::new(1024, 256).snapshot(),
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ProcessManagerState::default()),
        }
    }

    pub fn snapshot(&self) -> ProcessManagerSnapshot {
        let state = self.state.lock().expect("process manager poisoned");
        ProcessManagerSnapshot {
            cancellation_supported: true,
            backpressure_supported: true,
            buffering_mode: "head_tail",
            active_processes: state.active.len(),
            completed_runs: state.completed_runs,
            cancelled_runs: state.cancelled_runs,
            timed_out_runs: state.timed_out_runs,
            last_process_id: state.last_process_id.clone(),
        }
    }

    pub fn cancel_process(&self, process_id: &str) -> Result<Value, String> {
        let process_key = process_id.trim();
        if process_key.is_empty() {
            return Err("processId is required".to_string());
        }
        let control = {
            let state = self
                .state
                .lock()
                .map_err(|_| "process_state_poisoned".to_string())?;
            state.active.get(process_key).cloned()
        };
        let cancelled = match control {
            Some(control) => control.cancel(false)?,
            None => false,
        };
        Ok(json!({
            "service": "bosun-unified-exec",
            "version": env!("CARGO_PKG_VERSION"),
            "processId": process_key,
            "cancelled": cancelled,
        }))
    }

    pub fn run_process(&self, request: RunProcessRequest) -> Result<Value, String> {
        if request.process_id.trim().is_empty() {
            return Err("processId is required".to_string());
        }
        if request.command.trim().is_empty() {
            return Err("command is required".to_string());
        }

        let mut command = Command::new(&request.command);
        command
            .args(&request.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = request.cwd.as_deref() {
            if !cwd.trim().is_empty() {
                command.current_dir(cwd);
            }
        }
        for (key, value) in request.env.iter() {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("spawn_failed: {error}"))?;

        if let Some(mut writer) = child.stdin.take() {
            if let Some(stdin) = request.stdin.as_ref() {
                writer
                    .write_all(stdin.as_bytes())
                    .map_err(|error| format!("stdin_write_failed: {error}"))?;
            }
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "stdout_pipe_unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "stderr_pipe_unavailable".to_string())?;

        let control = Arc::new(ProcessControl::new(child));
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "process_state_poisoned".to_string())?;
            state.last_process_id = Some(request.process_id.clone());
            state.active.insert(request.process_id.clone(), Arc::clone(&control));
        }

        let stdout_buffer = Arc::new(Mutex::new(HeadTailByteBuffer::new(
            request.max_buffer_bytes,
            request.tail_buffer_bytes,
        )));
        let stderr_buffer = Arc::new(Mutex::new(HeadTailByteBuffer::new(
            request.max_buffer_bytes,
            request.tail_buffer_bytes,
        )));
        let stdout_thread = read_stream(stdout, Arc::clone(&stdout_buffer));
        let stderr_thread = read_stream(stderr, Arc::clone(&stderr_buffer));

        let started_at = Instant::now();
        let timeout_ms = request.timeout_ms.max(1);

        let exit_code = loop {
            if started_at.elapsed() >= Duration::from_millis(timeout_ms) {
                let _ = control.cancel(true);
            }

            let status = {
                let mut guard = control
                    .child
                    .lock()
                    .map_err(|_| "process_lock_poisoned".to_string())?;
                let Some(child) = guard.as_mut() else {
                    break None;
                };
                child
                    .try_wait()
                    .map_err(|error| format!("wait_failed: {error}"))?
            };

            if let Some(status) = status {
                break status.code();
            }
            thread::sleep(Duration::from_millis(PROCESS_POLL_INTERVAL_MS));
        };

        {
            let mut guard = control
                .child
                .lock()
                .map_err(|_| "process_lock_poisoned".to_string())?;
            let _ = guard.take();
        }

        let _ = stdout_thread.join();
        let _ = stderr_thread.join();

        let stdout_snapshot = take_snapshot(&stdout_buffer);
        let stderr_snapshot = take_snapshot(&stderr_buffer);
        let cancelled = control.cancelled.load(Ordering::SeqCst);
        let timed_out = control.timed_out.load(Ordering::SeqCst);
        let duration_ms = started_at.elapsed().as_secs_f64() * 1000.0;

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "process_state_poisoned".to_string())?;
            state.active.remove(&request.process_id);
            state.completed_runs += 1;
            if cancelled {
                state.cancelled_runs += 1;
            }
            if timed_out {
                state.timed_out_runs += 1;
            }
        }

        Ok(json!({
            "service": "bosun-unified-exec",
            "version": env!("CARGO_PKG_VERSION"),
            "processId": request.process_id,
            "exitCode": exit_code,
            "signal": Value::Null,
            "cancelled": cancelled,
            "timedOut": timed_out,
            "durationMs": ((duration_ms * 100.0).round() / 100.0),
            "stdout": stdout_snapshot.text,
            "stderr": stderr_snapshot.text,
            "buffer": {
                "stdout": stdout_snapshot,
                "stderr": stderr_snapshot,
            }
        }))
    }
}
