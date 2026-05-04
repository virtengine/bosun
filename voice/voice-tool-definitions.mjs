export const TOOL_DEFS = [
  // ── Workspace Tools ──
  {
    type: "function",
    name: "list_tasks",
    description: "List tasks from the kanban board. Returns task IDs, titles, status, and assignees.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["todo", "inprogress", "inreview", "done", "cancelled", "all"],
          description: "Filter by task status. Default: all",
        },
        limit: {
          type: "number",
          description: "Max number of tasks to return. Default: 20",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_task",
    description: "Get detailed information about a specific task by ID or number.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID or issue number" },
      },
      required: ["taskId"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a new task on the kanban board.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description/body" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply",
        },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "update_task_status",
    description: "Update the status of a task (move between columns).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID or issue number" },
        status: {
          type: "string",
          enum: ["todo", "inprogress", "inreview", "done", "cancelled"],
        },
      },
      required: ["taskId", "status"],
    },
  },
  // ── Agent Tools ──
  {
    type: "function",
    name: "delegate_to_agent",
    description: "Execute a CODE MODIFICATION task via a coding agent (codex, copilot, claude, gemini, or opencode). Creates a live session for writing code, modifying files, creating PRs, or running multi-step workflows. Do NOT use this for questions, status checks, or information retrieval — use ask_agent_context or direct tools instead. Only use when the user explicitly asks to write, fix, create, implement, refactor, or deploy code.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The instruction to send to the agent. Be specific and detailed.",
        },
        executor: {
          type: "string",
          enum: ["openai-native", "codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
          description: "Optional executor override. Prefer omitting this unless you need a specific runtime; when omitted, Bosun uses the active workflow/runtime executor.",
        },
        mode: {
          type: "string",
          enum: ["ask", "agent", "plan", "code", "architect"],
          description: "Agent mode: code (make changes), ask (read-only), architect (plan). Default: code",
        },
        model: {
          type: "string",
          description: "Optional model override for the delegated call.",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function",
    name: "ask_agent_context",
    description: "Ask the coding agent a quick question in ask/instant mode and return the answer in this voice turn. Use for context, project understanding, debugging questions, and fast reasoning that needs workspace awareness.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Question or instruction for the agent.",
        },
        mode: {
          type: "string",
          enum: ["ask", "instant"],
          description: "Low-latency query mode. Default: instant",
        },
        model: {
          type: "string",
          description: "Optional model override for this quick query.",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function",
    name: "get_agent_status",
    description: "Get the current status of the active coding agent (busy, idle, session info).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "switch_agent",
    description: "Switch the active primary agent to a different executor.",
    parameters: {
      type: "object",
      properties: {
        executor: {
          type: "string",
          enum: ["openai-native", "codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
          description: "The executor to switch to",
        },
      },
      required: ["executor"],
    },
  },
  // ── Session Tools ──
  {
    type: "function",
    name: "list_sessions",
    description: "List active and historical chat/agent sessions with metadata. Returns session summaries (not full transcripts) for fast browsing. Use get_session_history with fullTranscript=true for complete message text.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max sessions per page. Default: 10" },
        page: { type: "number", description: "Page number for pagination. Default: 1" },
        includeHistory: { type: "boolean", description: "Include completed/archived sessions. Default: true" },
      },
    },
  },
  {
    type: "function",
    name: "get_session_history",
    description: "Get the recent message history from a session. Returns metadata-first (truncated content) by default. Set fullTranscript=true for complete message text.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID to retrieve" },
        limit: { type: "number", description: "Max messages. Default: 20" },
        fullTranscript: { type: "boolean", description: "Return full message text instead of truncated preview. Default: false" },
      },
      required: ["sessionId"],
    },
  },
  // ── System Tools ──
  {
    type: "function",
    name: "get_system_status",
    description: "Get the overall bosun system status including agent health, task counts, and fleet info.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_fleet_status",
    description: "Get fleet coordination status across workstations.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Execute a Bosun system command by name. Supported commands: status, health, config, " +
      "fleet, sync, tasks, agents, version, maintenance. These map to the equivalent Bosun " +
      "CLI operations and return live results. For free-form workspace shell commands " +
      "(git, npm, grep…) use run_workspace_command instead.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Bosun command name. Examples: 'status', 'health', 'config', 'fleet', 'tasks inprogress', 'sync'.",
        },
      },
      required: ["command"],
    },
  },
  // ── Git/PR Tools ──
  {
    type: "function",
    name: "get_pr_status",
    description: "Get the status of open pull requests.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max PRs to return. Default: 10" },
      },
    },
  },
  // ── Config Tools ──
  {
    type: "function",
    name: "get_config",
    description: "Get current bosun configuration values.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific config key to retrieve. Omit for full config summary." },
      },
    },
  },
  {
    type: "function",
    name: "update_config",
    description: "Update a bosun configuration value.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key to update" },
        value: { type: "string", description: "New value" },
      },
      required: ["key", "value"],
    },
  },
  {
    type: "function",
    name: "get_effective_config",
    description: "Get the full effective bosun configuration with sensitive values redacted. Owner/admin only. Returns all config sections for debugging and inspection.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific config key. Omit for all." },
      },
    },
  },
  {
    type: "function",
    name: "get_admin_help",
    description: "Get a complete listing of all available Voice tools, slash commands, and dispatch actions for admin reference.",
    parameters: { type: "object", properties: {} },
  },
  // ── Workspace Navigation ──
  {
    type: "function",
    name: "search_code",
    description: "Search for code patterns in the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or regex pattern" },
        filePattern: { type: "string", description: "Glob pattern to filter files. E.g., '**/*.mjs'" },
        maxResults: { type: "number", description: "Max results. Default: 20" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_file_content",
    description: "Read the content of a file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path relative to workspace root" },
        startLine: { type: "number", description: "Start line (1-indexed)" },
        endLine: { type: "number", description: "End line (1-indexed)" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "list_directory",
    description: "List files and directories in a workspace path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace root. Default: root" },
      },
    },
  },
  {
    type: "function",
    name: "get_workspace_context",
    description: "Get current workspace and repository context for this voice/chat session.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "query_live_view",
    description: "Analyze the latest live camera/screen frame for this session. Provide a query when available; if omitted, it will infer from recent voice context and still return a best-effort screen summary.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Question about the current visual frame. Example: 'What error is shown on screen?'",
        },
      },
    },
  },
  // ── Monitoring ──
  {
    type: "function",
    name: "get_recent_logs",
    description: "Get recent agent, system, or all log types. Supports paging through log files.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["agent", "system", "monitor", "orchestrator", "voice", "all"],
          description: "Log type (or 'all' for every source). Default: agent",
        },
        lines: {
          type: "number",
          description: "Number of lines to return per source. Default: 50",
        },
        page: {
          type: "number",
          description: "Page through log files (1 = most recent). Default: 1",
        },
      },
    },
  },
  // ── Task Management (extended) ──
  {
    type: "function",
    name: "search_tasks",
    description: "Search tasks by text query across titles, descriptions, and labels.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limit: { type: "number", description: "Max results. Default: 20" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_task_stats",
    description: "Get task board statistics (counts by status, backlog size, etc.).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "delete_task",
    description: "Delete a task from the kanban board.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID or issue number" },
      },
      required: ["taskId"],
    },
  },
  {
    type: "function",
    name: "comment_on_task",
    description: "Add a comment to a task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        body: { type: "string", description: "Comment text" },
      },
      required: ["taskId", "body"],
    },
  },
  // ── Agent Mode ──
  {
    type: "function",
    name: "set_agent_mode",
    description: "Set the agent interaction mode (ask for questions, agent for code changes, plan for architecture).",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["ask", "agent", "plan"],
          description: "The interaction mode to set",
        },
      },
      required: ["mode"],
    },
  },
  // ── Workflow & Skills ──
  {
    type: "function",
    name: "list_workflows",
    description: "List available workflow templates and installed workflow definitions.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "create_workflow",
    description: "Create a new workflow from a JSON definition (or create a blank workflow by name).",
    parameters: {
      type: "object",
      properties: {
        definition: {
          description: "Workflow definition object (or JSON string)",
        },
        name: { type: "string", description: "Workflow name (used for blank workflow creation)" },
        description: { type: "string", description: "Workflow description" },
        enabled: { type: "boolean", description: "Whether workflow should be enabled on save. Default: false" },
        workflowId: { type: "string", description: "Optional explicit workflow id" },
      },
    },
  },
  {
    type: "function",
    name: "update_workflow_definition",
    description: "Update an existing workflow definition (merge patch by default, or replace).",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id to update" },
        patch: {
          description: "Partial workflow object patch (or JSON string)",
        },
        replace: {
          type: "boolean",
          description: "Replace the definition instead of merge-patch. Default: false",
        },
      },
      required: ["workflowId"],
    },
  },
  {
    type: "function",
    name: "delete_workflow",
    description: "Delete a workflow definition by id.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id" },
      },
      required: ["workflowId"],
    },
  },
  {
    type: "function",
    name: "create_workflow_from_template",
    description: "Install a workflow template as a new workflow instance, with optional variable overrides.",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string", description: "Workflow template id" },
        overrides: {
          description: "Variable override object (or JSON string)",
        },
        executeAfterCreate: { type: "boolean", description: "Run the new workflow immediately. Default: false" },
        input: { description: "Input object (or JSON string) for executeAfterCreate" },
      },
      required: ["templateId"],
    },
  },
  {
    type: "function",
    name: "generate_workflow_with_agent",
    description: "Ask the coding agent to generate a workflow JSON, then optionally save it.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What workflow to generate" },
        save: { type: "boolean", description: "Save generated workflow automatically. Default: true" },
        enabled: { type: "boolean", description: "When saving, set enabled state. Default: false" },
        executor: {
          type: "string",
          enum: ["openai-native", "codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
          description: "Optional agent executor override for generation",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "get_workflow_definition",
    description: "Get a saved workflow definition (nodes, edges, metadata) by workflow id.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id" },
        includeDisabled: {
          type: "boolean",
          description: "Include disabled workflows in lookups where relevant. Default: true",
        },
      },
      required: ["workflowId"],
    },
  },
  {
    type: "function",
    name: "execute_workflow",
    description: "Execute a workflow now with optional input payload.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id to run" },
        input: { description: "Input payload object (or JSON string)" },
        force: { type: "boolean", description: "Force run even if workflow is disabled. Default: false" },
      },
      required: ["workflowId"],
    },
  },
  {
    type: "function",
    name: "list_workflow_runs",
    description: "List workflow run history across all workflows or for one workflow.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Optional workflow id filter" },
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "paused", "cancelled"],
          description: "Optional status filter",
        },
        limit: { type: "number", description: "Max runs to return. Default: 20" },
      },
    },
  },
  {
    type: "function",
    name: "get_workflow_run",
    description: "Get workflow run detail, including errors and recent logs.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run id" },
        includeLogs: {
          type: "boolean",
          description: "Include run logs in response. Default: true",
        },
        logLimit: {
          type: "number",
          description: "Max log entries to return when includeLogs=true. Default: 120",
        },
        includeNodeStatusEvents: {
          type: "boolean",
          description: "Include node status event timeline. Default: false",
        },
      },
      required: ["runId"],
    },
  },
  {
    type: "function",
    name: "analyze_workflow",
    description: "Analyze workflow health using structure + recent run history.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id. Omit to analyze multiple workflows." },
        limit: { type: "number", description: "Max runs used for analysis. Default: 30" },
      },
    },
  },
  {
    type: "function",
    name: "retry_workflow_run",
    description: "Retry workflow run: from_failed (only failed runs) or from_scratch (any run).",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Original failed workflow run id to retry" },
        mode: {
          type: "string",
          enum: ["from_failed", "from_scratch"],
          description: "Retry mode. Default: from_failed",
        },
      },
      required: ["runId"],
    },
  },
  {
    type: "function",
    name: "list_skills",
    description: "List available agent skills from the knowledge base.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_prompts",
    description: "List available agent prompt definitions.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "sync_prompt_defaults",
    description: "Compare current workspace prompt files against Bosun defaults and return update candidates; optionally apply safe default updates for selected prompt keys.",
    parameters: {
      type: "object",
      properties: {
        apply: {
          type: "boolean",
          description: "When true, apply default updates for prompt keys with updateAvailable=true. Default: false",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional prompt key filter when apply=true. Example: ['orchestrator', 'voiceAgent']",
        },
      },
    },
  },
  // ── Batch Action ──
  {
    type: "function",
    name: "dispatch_action",
    description: "Execute a Bosun action by name. Use for any action not covered by dedicated tools. Actions: task.list, task.create, agent.delegate, system.status, workflow.list, skill.list, prompt.list, etc.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action name (e.g. task.stats, agent.status)" },
        params: {
          type: "object",
          description: "Action parameters",
        },
      },
      required: ["action"],
    },
  },
  // ── Generic MCP Gateway ──
  {
    type: "function",
    name: "invoke_mcp_tool",
    description: "Call any MCP (Model Context Protocol) tool by name via the agent. Use for GitHub operations (create PR, list issues), kanban integrations, or any capability exposed by a configured MCP server. This is the preferred way to trigger one-shot MCP actions from voice without needing a dedicated tool wrapper.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "The MCP tool name, e.g. 'create_issue', 'create_pull_request', 'list_tasks'. For GitHub tools omit the server prefix.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name to disambiguate, e.g. 'github', 'linear', 'jira'. Leave empty if unambiguous.",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the MCP tool as key/value pairs.",
        },
      },
      required: ["tool"],
    },
  },
  // ── Context Warm-up ──
  {
    type: "function",
    name: "warm_codebase_context",
    description: "Pre-load codebase context into the agent so subsequent code questions answer instantly. Call this once at the start of a voice session when you know the user will ask project-specific questions.",
    parameters: { type: "object", properties: {} },
  },

  // ── Slash Commands ──
  {
    type: "function",
    name: "bosun_slash_command",
    description:
      "Invoke a Bosun slash command by exact name. Supports: " +
      "/instant <prompt> (fast inline answer), " +
      "/ask <prompt> (read-only agent answer), " +
      "/agent <prompt> or /handoff <prompt> (create a dedicated live handoff session), " +
      "/status, /tasks, /agents, /health, /version, /commands, " +
      "/prompts, /promptsync [apply [keys...]], " +
      "/mcp <tool_name> [server] (invoke an MCP tool). " +
      "Use this when the user explicitly says a slash command or when you need a fast inline " +
      "answer vs a direct handoff session.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Full slash command string including leading /. Examples: " +
            "'/instant what does the auth module do?', " +
            "'/agent write unit tests for config.mjs', " +
            "'/ask summarize the git log', " +
            "'/promptsync', '/promptsync apply orchestrator,voiceAgent', " +
            "'/mcp create_issue server=github', " +
            "'/status'",
        },
      },
      required: ["command"],
    },
  },

  // ── Workspace Shell ──
  {
    type: "function",
    name: "run_workspace_command",
    description:
      "Execute a workspace shell command and return live output. " +
      "Standard sessions run read-only commands directly; privileged owner/admin sessions can run broader commands. " +
      "Use this for diagnostics, git operations, tests/builds, and direct shell workflows.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command to run in the workspace root. Examples: " +
            "'git status --short', 'git log --oneline -10', " +
            "'git commit --amend -m \"fix(workspace): restore per-agent rate limiting\"', " +
            "'npm test -- tests/workspace-health.test.mjs', 'cat package.json', 'ls src/'",
        },
      },
      required: ["command"],
    },
  },

  // ── Background Session Polling ──
  {
    type: "function",
    name: "poll_background_session",
    description:
      "Check the current status and latest output of a background agent session that was " +
      "previously started with delegate_to_agent. Use this when the user asks 'what's the status of that " +
      "background task?' or 'is the agent done yet?'.",
    parameters: {
      type: "object",
      properties: {
        backgroundSessionId: {
          type: "string",
          description: "The background session ID returned by delegate_to_agent (starts with 'voice-bg-').",
        },
        limit: {
          type: "number",
          description: "Number of most-recent messages to include. Default: 5",
        },
      },
      required: ["backgroundSessionId"],
    },
  },
];
