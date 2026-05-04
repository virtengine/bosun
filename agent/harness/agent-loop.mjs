export function createAgentLoop(options = {}) {
  const runtimeSession = options.runtimeSession;
  if (!runtimeSession || typeof runtimeSession.run !== "function") {
    throw new Error("A runtime session with a run() method is required");
  }
  return {
    canSteer() {
      return runtimeSession.canSteer?.() === true;
    },
    steer(prompt, meta = {}) {
      return runtimeSession.steer?.(prompt, meta) || {
        ok: false,
        delivered: false,
        reason: "not_steerable",
      };
    },
    abort(reason = "aborted") {
      return runtimeSession.abort?.(reason);
    },
    async run(...args) {
      return await runtimeSession.run(...args);
    },
  };
}

export default createAgentLoop;
