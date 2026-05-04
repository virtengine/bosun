#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AGENT_PROMPT_DEFINITIONS,
  getDefaultPromptTemplate,
} from "../agent/agent-prompts.mjs";
import { BUILTIN_SKILLS } from "../agent/bosun-skills.mjs";
import { BUILTIN_AGENT_PROFILES } from "../infra/library-manager.mjs";
import { BUILTIN_FLOW_TEMPLATES } from "../workflow/manual-flows.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const WORKFLOW_TEMPLATES_DIR = resolve(ROOT, "workflow-templates");
const OUTPUT_PATHS = [
  resolve(ROOT, "ui", "demo-defaults.js"),
  resolve(ROOT, "site", "ui", "demo-defaults.js"),
];

const CATEGORY_META = {
  agents: { label: "Agents", icon: ":bot:", order: 2 },
  "ci-cd": { label: "CI/CD", icon: ":rocket:", order: 3 },
  cicd: { label: "CI/CD", icon: ":rocket:", order: 3 },
  github: { label: "GitHub", icon: ":git:", order: 1 },
  planning: { label: "Planning", icon: ":clipboard:", order: 4 },
  reliability: { label: "Reliability", icon: ":shield:", order: 5 },
  research: { label: "Research", icon: ":search:", order: 6 },
  security: { label: "Security", icon: ":lock:", order: 7 },
};

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWorkflowTemplate(template) {
  const category = String(template?.category || "custom").trim().toLowerCase() || "custom";
  const meta = CATEGORY_META[category] || {
    label: category.replace(/(^|-)([a-z])/g, (_, sep, ch) => `${sep ? " " : ""}${ch.toUpperCase()}`).trim(),
    icon: ":settings:",
    order: 99,
  };
  const nodes = Array.isArray(template?.nodes) ? clone(template.nodes) : [];
  const edges = Array.isArray(template?.edges) ? clone(template.edges) : [];
  return {
    id: String(template?.id || slugify(template?.name) || "template"),
    name: String(template?.name || "Unnamed Template"),
    description: String(template?.description || "").trim(),
    category,
    categoryLabel: meta.label,
    categoryIcon: meta.icon,
    categoryOrder: meta.order,
    tags: Array.isArray(template?.metadata?.tags) ? [...template.metadata.tags] : [],
    nodeCount: nodes.length,
    edgeCount: edges.length,
    recommended: template?.recommended === true,
    enabled: template?.enabled !== false,
    trigger: String(template?.trigger || nodes[0]?.type || "manual"),
    variables: clone(template?.variables || {}),
    metadata: clone(template?.metadata || {}),
    nodes,
    edges,
  };
}

function buildInstalledWorkflow(template, index) {
  const installedId = `wf-${slugify(template.id.replace(/^template-/, "")) || index + 1}`;
  const timestamp = new Date(Date.UTC(2026, 2, Math.min(28, index + 1), 12, 0, 0)).toISOString();
  return {
    id: installedId,
    name: template.name,
    description: template.description,
    category: template.category,
    enabled: template.enabled !== false,
    nodeCount: template.nodeCount,
    trigger: template.trigger,
    variables: clone(template.variables || {}),
    nodes: clone(template.nodes || []),
    edges: clone(template.edges || []),
    metadata: {
      author: "bosun-demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      templateState: {
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.metadata?.templateVersion || template.metadata?.version || "1.0.0",
        installedTemplateVersion: template.metadata?.templateVersion || template.metadata?.version || "1.0.0",
        isCustomized: false,
        updateAvailable: false,
      },
    },
  };
}

function buildWorkflowRuns(workflows) {
  return workflows.slice(0, Math.min(8, workflows.length)).map((workflow, index) => {
    const startedAt = new Date(Date.UTC(2026, 2, 6, 9 + index, 15, 0)).toISOString();
    const duration = 20000 + index * 9000;
    return {
      runId: `run-${String(index + 1).padStart(3, "0")}`,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: index % 5 === 4 ? "failed" : "completed",
      nodeCount: workflow.nodeCount,
      duration,
      errorCount: index % 5 === 4 ? 1 : 0,
      triggerSource: "manual",
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + duration).toISOString(),
    };
  });
}

function buildPromptEntries() {
  const createdAt = "2026-03-01T09:00:00.000Z";
  return AGENT_PROMPT_DEFINITIONS.map((def, index) => {
    const id = slugify(def.key || def.filename);
    return {
      entry: {
        id,
        type: "prompt",
        name: String(def.label || def.key || id),
        description: String(def.description || `Default ${def.label || def.key} prompt`).trim(),
        filename: String(def.filename || `${id}.md`),
        tags: [String(def.key || id).toLowerCase(), "default", "prompt"],
        scope: "global",
        workspace: null,
        storageScope: "global",
        createdAt,
        updatedAt: createdAt,
        order: index,
      },
      content: getDefaultPromptTemplate(def.key),
    };
  });
}

function buildAgentEntries() {
  const createdAt = "2026-03-01T09:00:00.000Z";
  return BUILTIN_AGENT_PROFILES.map((profile, index) => ({
    entry: {
      id: String(profile.id),
      type: "agent",
      name: String(profile.name || profile.id),
      description: String(profile.description || "").trim(),
      filename: `${profile.id}.json`,
      tags: Array.isArray(profile.tags) ? [...profile.tags] : [],
      scope: "global",
      workspace: null,
      storageScope: "global",
      createdAt,
      updatedAt: createdAt,
      order: index,
    },
    content: clone(profile),
  }));
}

function buildSkillEntries() {
  const createdAt = "2026-03-01T09:00:00.000Z";
  return BUILTIN_SKILLS.map((skill, index) => ({
    entry: {
      id: slugify(skill.filename.replace(/\.md$/i, "")),
      type: "skill",
      name: String(skill.title || skill.filename),
      description: `Built-in ${skill.scope || "global"} skill`,
      filename: String(skill.filename),
      tags: Array.isArray(skill.tags) ? [...skill.tags] : [],
      scope: String(skill.scope || "global"),
      workspace: null,
      storageScope: "global",
      createdAt,
      updatedAt: createdAt,
      order: index,
    },
    content: skill.content.trim() + "\n",
  }));
}

async function loadWorkflowTemplates() {
  const files = readdirSync(WORKFLOW_TEMPLATES_DIR)
    .filter((name) => name.endsWith(".mjs") && !name.startsWith("_"))
    .sort();
  const templates = [];
  for (const file of files) {
    const moduleUrl = pathToFileURL(resolve(WORKFLOW_TEMPLATES_DIR, file));
    moduleUrl.searchParams.set("demoDefaultsCacheBust", `${Date.now()}-${Math.random()}`);
    const mod = await import(moduleUrl.href);
    for (const value of Object.values(mod)) {
      if (!value || typeof value !== "object") continue;
      if (!value.id || !value.name || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) continue;
      templates.push(normalizeWorkflowTemplate(value));
    }
  }
  return templates.sort((a, b) =>
    a.categoryOrder - b.categoryOrder
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id),
  );
}

export async function buildDemoDefaultsData() {
  const workflowTemplates = await loadWorkflowTemplates();
  const workflows = workflowTemplates.map(buildInstalledWorkflow);
  const workflowRuns = buildWorkflowRuns(workflows);
  const manualFlowTemplates = BUILTIN_FLOW_TEMPLATES.map((template) => clone(template));

  const libraryPairs = [
    ...buildPromptEntries(),
    ...buildAgentEntries(),
    ...buildSkillEntries(),
  ];
  const libraryEntries = libraryPairs
    .map((pair) => pair.entry)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const libraryContents = Object.fromEntries(
    libraryPairs.map((pair) => [pair.entry.id, pair.content]),
  );

  return {
    workflowTemplates,
    workflows,
    workflowRuns,
    manualFlowTemplates,
    libraryEntries,
    libraryContents,
  };
}

export function renderDefaultsScript(data) {
  const payload = JSON.stringify(data, null, 2);
  return [
    "/* Auto-generated by tools/generate-demo-defaults.mjs. */",
    "(function () {",
    "  window.__BOSUN_DEMO_DEFAULTS__ = " + payload + ";",
    "})();",
    "",
  ].join("\n");
}

export async function syncDemoDefaults({ silent = false } = {}) {
  const data = await buildDemoDefaultsData();
  const content = renderDefaultsScript(data);
  const updatedPaths = [];
  for (const filePath of OUTPUT_PATHS) {
    mkdirSync(dirname(filePath), { recursive: true });
    const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
    if (current === content) continue;
    writeFileSync(filePath, content, "utf8");
    updatedPaths.push(filePath);
  }
  if (!silent && updatedPaths.length > 0) {
    console.log(`[demo-defaults] synced ${updatedPaths.length} file(s)`);
  }
  return {
    data,
    content,
    outputPaths: OUTPUT_PATHS,
    updatedPaths,
    updated: updatedPaths.length > 0,
  };
}

export async function writeDemoDefaults() {
  return syncDemoDefaults();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await writeDemoDefaults();
}
