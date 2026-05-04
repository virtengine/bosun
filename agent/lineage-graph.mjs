function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toRecordMap(values = [], keyName) {
  const map = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const key = toTrimmedString(value?.[keyName] || "");
    if (!key) continue;
    map.set(key, value);
  }
  return map;
}

export function createLineageGraph(options = {}) {
  const sessions = Array.isArray(options.sessions)
    ? options.sessions
    : (typeof options.listSessions === "function" ? options.listSessions() : []);
  const threads = Array.isArray(options.threads)
    ? options.threads
    : (options.threadRegistry?.listThreads ? options.threadRegistry.listThreads() : []);
  const subagents = Array.isArray(options.subagents)
    ? options.subagents
    : (options.subagentControl?.listSpawnRecords ? options.subagentControl.listSpawnRecords() : []);

  const sessionsById = toRecordMap(sessions, "sessionId");
  const threadsById = toRecordMap(threads, "threadId");

  function getSession(sessionId) {
    const normalized = toTrimmedString(sessionId);
    return normalized && sessionsById.has(normalized) ? cloneValue(sessionsById.get(normalized)) : null;
  }

  function getRootSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) return null;
    return getSession(session.rootSessionId || session.sessionId) || session;
  }

  function getChildren(sessionId) {
    const normalized = toTrimmedString(sessionId);
    return sessions
      .filter((entry) => toTrimmedString(entry?.parentSessionId || "") === normalized)
      .sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")))
      .map((entry) => cloneValue(entry));
  }

  function getDescendants(rootSessionId) {
    const normalizedRoot = toTrimmedString(rootSessionId);
    if (!normalizedRoot) return [];
    return sessions
      .filter((entry) => {
        return toTrimmedString(entry?.rootSessionId || entry?.sessionId || "") === normalizedRoot
          && toTrimmedString(entry?.sessionId || "") !== normalizedRoot;
      })
      .sort((left, right) => Number(left?.lineageDepth || 0) - Number(right?.lineageDepth || 0))
      .map((entry) => cloneValue(entry));
  }

  function getSiblings(sessionId) {
    const session = getSession(sessionId);
    if (!session?.parentSessionId) return [];
    return sessions
      .filter((entry) => {
        return toTrimmedString(entry?.parentSessionId || "") === toTrimmedString(session.parentSessionId)
          && toTrimmedString(entry?.sessionId || "") !== toTrimmedString(session.sessionId);
      })
      .sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")))
      .map((entry) => cloneValue(entry));
  }

  function getSubagents(sessionId) {
    const normalized = toTrimmedString(sessionId);
    return subagents
      .filter((entry) => toTrimmedString(entry?.parentSessionId || "") === normalized)
      .sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")))
      .map((entry) => cloneValue(entry));
  }

  function getThreadLineage(threadId) {
    const lineage = [];
    let current = toTrimmedString(threadId);
    while (current && threadsById.has(current)) {
      const record = threadsById.get(current);
      lineage.unshift(cloneValue(record));
      current = toTrimmedString(record?.parentThreadId || "");
    }
    return lineage;
  }

  function buildSessionTree(rootSessionId) {
    const root = getRootSession(rootSessionId);
    if (!root) return null;
    function attach(node) {
      return {
        session: cloneValue(node),
        children: getChildren(node.sessionId).map((child) => attach(child)),
      };
    }
    return attach(root);
  }

  function describe(sessionId) {
    const session = getSession(sessionId);
    if (!session) return null;
    const rootSession = getRootSession(session.sessionId);
    const activeThread = toTrimmedString(session.activeThreadId || "");
    return {
      session,
      root: rootSession,
      rootSession,
      parent: getSession(session.parentSessionId),
      children: getChildren(session.sessionId),
      siblings: getSiblings(session.sessionId),
      descendants: getDescendants(rootSession?.sessionId || session.rootSessionId || session.sessionId),
      subagents: getSubagents(session.sessionId),
      activeThread: activeThread && threadsById.has(activeThread) ? cloneValue(threadsById.get(activeThread)) : null,
      threadLineage: activeThread ? getThreadLineage(activeThread) : [],
      sessionTree: buildSessionTree(rootSession?.sessionId || session.sessionId),
    };
  }

  return {
    getSession,
    getRootSession,
    getChildren,
    getDescendants,
    getSiblings,
    getSubagents,
    getThreadLineage,
    getSessionLineage: describe,
    buildSessionTree,
    describe,
  };
}

export default createLineageGraph;
