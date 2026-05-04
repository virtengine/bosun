import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { EOL } from "node:os";

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (typeof signal?.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (typeof signal?.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function tailContent(raw, maxLines) {
  if (!raw) return "";
  const lines = String(raw).split(/\r?\n/);
  const trailingNewline = /\r?\n$/.test(raw);
  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const slice = lines.slice(-Math.max(1, maxLines));
  if (slice.length === 0) return "";
  return `${slice.join(EOL)}${EOL}`;
}

function readFileChunk(filePath, start, length) {
  if (!Number.isFinite(length) || length <= 0) return "";
  const handle = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(handle, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(handle);
  }
}

export async function followTextFile(filePath, options = {}) {
  const pollMs = Math.max(50, Number(options.pollMs || 250) || 250);
  const initialLines = Math.max(1, Number(options.initialLines || 200) || 200);
  const output = options.outputStream || process.stdout;
  const errorStream = options.errorStream || process.stderr;
  const signal = options.signal;

  if (signal?.aborted) return;
  if (!existsSync(filePath)) {
    throw new Error(`Log file not found: ${filePath}`);
  }

  let offset = 0;
  try {
    const initialRaw = readFileSync(filePath, "utf8");
    const initialText = tailContent(initialRaw, initialLines);
    if (initialText) {
      output.write(initialText);
    }
    offset = Buffer.byteLength(initialRaw, "utf8");
  } catch (error) {
    throw new Error(`Could not read log file ${filePath}: ${error?.message || error}`);
  }

  while (!signal?.aborted) {
    await delay(pollMs, signal);
    if (signal?.aborted) break;
    try {
      const stats = statSync(filePath);
      if (stats.size < offset) {
        offset = 0;
      }
      if (stats.size <= offset) {
        continue;
      }
      const chunkLength = stats.size - offset;
      const chunk = readFileChunk(filePath, offset, chunkLength);
      offset = stats.size;
      if (chunk) {
        output.write(chunk);
      }
    } catch (error) {
      if (signal?.aborted) break;
      const message = String(error?.message || error || "unknown error").trim();
      if (message) {
        errorStream.write(`[bosun] log follow warning: ${message}${EOL}`);
      }
    }
  }
}

export default followTextFile;