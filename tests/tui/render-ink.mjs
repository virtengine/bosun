import { PassThrough } from "node:stream";

import { render } from "ink";

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}

export function createInputTty() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.resume = () => {};
  stream.pause = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

export function createOutputTty({ columns = 120, rows = 40 } = {}) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  return stream;
}

export async function renderInk(element, options = {}) {
  const stdin = options.stdin || createInputTty();
  const stdout = options.stdout || createOutputTty(options);
  let buffer = "";
  const frames = [];
  stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    buffer += text;
    frames.push(text);
  });

  const app = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    debug: true,
  });

  // Ink registers its stdin listener from a useEffect, so a keystroke written before
  // that effect has run is never dispatched. Wait for the listener to be attached
  // instead of sleeping a fixed 40ms, so the first press is never dropped.
  const rawModeWaitMs = options.rawModeWaitMs ?? 250;
  const rawModeDeadline = Date.now() + rawModeWaitMs;
  while (Date.now() < rawModeDeadline) {
    if (stdin.listenerCount("readable") > 0) break;
    await delay(5);
  }

  await delay(options.waitMs ?? 40);

  return {
    app,
    stdin,
    stdout,
    frames() {
      return buffer;
    },
    text() {
      return stripAnsi(buffer).replace(/\r/g, "");
    },
    latestText() {
      for (let i = frames.length - 1; i >= 0; i--) {
        const stripped = stripAnsi(frames[i]).replace(/\r/g, "");
        if (stripped.trim().length > 0) return stripped;
      }
      return stripAnsi(buffer).replace(/\r/g, "");
    },
    lastFrame() {
      for (let i = frames.length - 1; i >= 0; i--) {
        const stripped = stripAnsi(frames[i]).replace(/\r/g, "");
        if (stripped.trim().length > 0) return stripped;
      }
      return stripAnsi(buffer).replace(/\r/g, "");
    },
    // Writes to a PassThrough are buffered and delivered asynchronously, so a fixed
        // sleep after the write races React's effect flush and loses the keystroke. Wait
        // for the chunk to actually be consumed by ink instead of guessing.
        async press(chars, waitMs = 40) {
          stdin.write(chars);
          const settleDeadline = Date.now() + waitMs;
          while (Date.now() < settleDeadline) {
            await delay(5);
            // Once ink has drained the buffer there is nothing left to dispatch; a short
            // tail lets React commit the resulting state change before we return.
            if (stdin.readableLength === 0) break;
          }
          await delay(5);
        },
    async unmount(waitMs = 20) {
      app.unmount();
      await delay(waitMs);
    },
  };
}