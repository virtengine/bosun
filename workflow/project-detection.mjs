/**
 * project-detection.mjs — Auto-detect project type, build tools, and commands.
 *
 * Scans a directory for manifest files and infers the project's language,
 * package manager, and standard commands (test, build, lint, syntax-check,
 * quality gate).
 * Handles mono-repos by detecting multiple stacks in a single root.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Stack Definitions ────────────────────────────────────────────────────────

/**
 * Each stack entry describes a language/framework ecosystem and how to detect it.
 * Priority order matters — first match with a manifest file wins for "primary".
 */
const STACK_DEFINITIONS = [
  {
    id: "node",
    label: "Node.js",
    markers: ["package.json"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "pnpm-lock.yaml"))) return "pnpm";
      if (existsSync(resolve(rootDir, "yarn.lock"))) return "yarn";
      if (existsSync(resolve(rootDir, "bun.lockb")) || existsSync(resolve(rootDir, "bun.lock"))) return "bun";
      return "npm";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm" : "bun run";
      const scripts = readPackageJsonScripts(rootDir);
      const cmds = {
        test: scripts.test ? `${pm} test` : "",
        build: scripts.build ? `${run} build` : "",
        lint: scripts.lint ? `${run} lint` : "",
        syntaxCheck: "node --check",
        typeCheck: "",
      };
      if (existsSync(resolve(rootDir, "tsconfig.json"))) {
        cmds.typeCheck = `${pm === "npm" ? "npx" : pm} tsc --noEmit`;
        cmds.syntaxCheck = `${pm === "npm" ? "npx" : pm} tsc --noEmit`;
      }
      // Detect test framework
      const deps = readPackageJsonDeps(rootDir);
      if (deps.has("vitest")) cmds.testFramework = "vitest";
      else if (deps.has("jest")) cmds.testFramework = "jest";
      else if (deps.has("mocha")) cmds.testFramework = "mocha";
      else if (deps.has("ava")) cmds.testFramework = "ava";
      // Detect lint tool
      if (deps.has("eslint") && !scripts.lint) cmds.lint = `${pm === "npm" ? "npx" : pm} eslint .`;
      if (deps.has("biome") && !scripts.lint) cmds.lint = `${pm === "npm" ? "npx" : pm} biome check .`;
      return cmds;
    },
    detectFrameworks(rootDir) {
      const deps = readPackageJsonDeps(rootDir);
      const frameworks = [];
      if (deps.has("react") || deps.has("react-dom")) frameworks.push("react");
      if (deps.has("next")) frameworks.push("nextjs");
      if (deps.has("vue")) frameworks.push("vue");
      if (deps.has("nuxt")) frameworks.push("nuxt");
      if (deps.has("svelte")) frameworks.push("svelte");
      if (deps.has("angular") || deps.has("@angular/core")) frameworks.push("angular");
      if (deps.has("express")) frameworks.push("express");
      if (deps.has("fastify")) frameworks.push("fastify");
      if (deps.has("nestjs") || deps.has("@nestjs/core")) frameworks.push("nestjs");
      if (deps.has("electron")) frameworks.push("electron");
      return frameworks;
    },
  },
  {
    id: "python",
    label: "Python",
    markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "poetry.lock")) || existsSync(resolve(rootDir, "pyproject.toml"))) {
        try {
          const toml = readFileSync(resolve(rootDir, "pyproject.toml"), "utf8");
          if (toml.includes("[tool.poetry]")) return "poetry";
        } catch {}
      }
      if (existsSync(resolve(rootDir, "Pipfile"))) return "pipenv";
      if (existsSync(resolve(rootDir, "uv.lock"))) return "uv";
      if (existsSync(resolve(rootDir, "pdm.lock"))) return "pdm";
      return "pip";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const cmds = { test: "", build: "", lint: "", syntaxCheck: "python -m py_compile", typeCheck: "" };

      // Test command
      if (existsSync(resolve(rootDir, "pytest.ini")) || existsSync(resolve(rootDir, "conftest.py"))) {
        cmds.test = pm === "poetry" ? "poetry run pytest" : pm === "uv" ? "uv run pytest" : "pytest";
      } else if (existsSync(resolve(rootDir, "pyproject.toml"))) {
        try {
          const toml = readFileSync(resolve(rootDir, "pyproject.toml"), "utf8");
          if (toml.includes("[tool.pytest]") || toml.includes("pytest")) {
            cmds.test = pm === "poetry" ? "poetry run pytest" : pm === "uv" ? "uv run pytest" : "pytest";
          }
        } catch {}
      }
      if (!cmds.test) cmds.test = pm === "poetry" ? "poetry run pytest" : "python -m pytest";

      // Build command
      if (pm === "poetry") cmds.build = "poetry build";
      else if (pm === "uv") cmds.build = "uv build";
      else cmds.build = "python -m build";

      // Lint / type check
      cmds.lint = pm === "poetry" ? "poetry run ruff check ." : "ruff check .";
      cmds.typeCheck = pm === "poetry" ? "poetry run mypy ." : "mypy .";
      cmds.syntaxCheck = "python -m py_compile";
      return cmds;
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const content = readAllPythonDeps(rootDir);
        if (/\bdjango\b/i.test(content)) frameworks.push("django");
        if (/\bflask\b/i.test(content)) frameworks.push("flask");
        if (/\bfastapi\b/i.test(content)) frameworks.push("fastapi");
        if (/\btorch\b|\bpytorch\b/i.test(content)) frameworks.push("pytorch");
        if (/\btensorflow\b/i.test(content)) frameworks.push("tensorflow");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "go",
    label: "Go",
    markers: ["go.mod"],
    detectPackageManager() { return "go"; },
    detectCommands() {
      return {
        test: "go test ./...",
        build: "go build ./...",
        lint: "golangci-lint run",
        syntaxCheck: "go vet ./...",
        typeCheck: "go vet ./...",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const gomod = readFileSync(resolve(rootDir, "go.mod"), "utf8");
        if (gomod.includes("github.com/gin-gonic/gin")) frameworks.push("gin");
        if (gomod.includes("github.com/gofiber/fiber")) frameworks.push("fiber");
        if (gomod.includes("github.com/labstack/echo")) frameworks.push("echo");
        if (gomod.includes("github.com/gorilla/mux")) frameworks.push("gorilla");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "rust",
    label: "Rust",
    markers: ["Cargo.toml"],
    detectPackageManager() { return "cargo"; },
    detectCommands() {
      return {
        test: "cargo test",
        build: "cargo build",
        lint: "cargo clippy -- -D warnings",
        syntaxCheck: "cargo check",
        typeCheck: "cargo check",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const cargo = readFileSync(resolve(rootDir, "Cargo.toml"), "utf8");
        if (cargo.includes("actix")) frameworks.push("actix");
        if (cargo.includes("axum")) frameworks.push("axum");
        if (cargo.includes("rocket")) frameworks.push("rocket");
        if (cargo.includes("tokio")) frameworks.push("tokio");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "java",
    label: "Java",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "gradlew")) || existsSync(resolve(rootDir, "build.gradle")) || existsSync(resolve(rootDir, "build.gradle.kts"))) return "gradle";
      return "maven";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const gradlew = existsSync(resolve(rootDir, "gradlew")) ? "./gradlew" : "gradle";
      if (pm === "gradle") {
        return {
          test: `${gradlew} test`,
          build: `${gradlew} build`,
          lint: `${gradlew} checkstyleMain`,
          syntaxCheck: `${gradlew} compileJava`,
          typeCheck: `${gradlew} compileJava`,
        };
      }
      return {
        test: "mvn test",
        build: "mvn package -DskipTests",
        lint: "mvn checkstyle:check",
        syntaxCheck: "mvn compile",
        typeCheck: "mvn compile",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const content = existsSync(resolve(rootDir, "pom.xml"))
          ? readFileSync(resolve(rootDir, "pom.xml"), "utf8")
          : existsSync(resolve(rootDir, "build.gradle"))
            ? readFileSync(resolve(rootDir, "build.gradle"), "utf8")
            : "";
        if (/spring/i.test(content)) frameworks.push("spring");
        if (/quarkus/i.test(content)) frameworks.push("quarkus");
        if (/micronaut/i.test(content)) frameworks.push("micronaut");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "dotnet",
    label: ".NET",
    markers: ["*.csproj", "*.fsproj", "*.sln"],
    detectPackageManager() { return "dotnet"; },
    detectCommands() {
      return {
        test: "dotnet test",
        build: "dotnet build",
        lint: "dotnet format --verify-no-changes",
        syntaxCheck: "dotnet build --no-restore",
        typeCheck: "dotnet build --no-restore",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const files = readdirSync(rootDir).filter(f => f.endsWith(".csproj") || f.endsWith(".fsproj"));
        for (const f of files) {
          const content = readFileSync(resolve(rootDir, f), "utf8");
          if (content.includes("Microsoft.AspNetCore") || content.includes("Microsoft.NET.Sdk.Web")) frameworks.push("aspnet");
          if (content.includes("Microsoft.Maui")) frameworks.push("maui");
        }
      } catch {}
      return frameworks;
    },
  },
  {
    id: "ruby",
    label: "Ruby",
    markers: ["Gemfile"],
    detectPackageManager() { return "bundler"; },
    detectCommands() {
      return {
        test: "bundle exec rspec",
        build: "bundle exec rake build",
        lint: "bundle exec rubocop",
        syntaxCheck: "ruby -c",
        typeCheck: "",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const gemfile = readFileSync(resolve(rootDir, "Gemfile"), "utf8");
        if (/\brails\b/i.test(gemfile)) frameworks.push("rails");
        if (/\bsinatra\b/i.test(gemfile)) frameworks.push("sinatra");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "php",
    label: "PHP",
    markers: ["composer.json"],
    detectPackageManager() { return "composer"; },
    detectCommands() {
      return {
        test: "vendor/bin/phpunit",
        build: "composer install --no-dev",
        lint: "vendor/bin/phpcs",
        syntaxCheck: "php -l",
        typeCheck: "vendor/bin/phpstan analyse",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const composer = JSON.parse(readFileSync(resolve(rootDir, "composer.json"), "utf8"));
        const deps = { ...composer.require, ...composer["require-dev"] };
        if (deps["laravel/framework"]) frameworks.push("laravel");
        if (deps["symfony/framework-bundle"]) frameworks.push("symfony");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "make",
    label: "Makefile",
    markers: ["Makefile", "makefile", "GNUmakefile"],
    detectPackageManager() { return "make"; },
    detectCommands(rootDir) {
      const cmds = { test: "make test", build: "make", lint: "make lint", syntaxCheck: "make check", typeCheck: "" };
      try {
        // Try all known Makefile variants (case-sensitive filesystems may use different names)
        let mf = "";
        for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
          try { mf = readFileSync(resolve(rootDir, name), "utf8"); break; } catch {}
        }
        if (mf) {
          if (!mf.includes("test:")) cmds.test = "";
          if (!mf.includes("lint:")) cmds.lint = "";
          if (!mf.includes("check:")) cmds.syntaxCheck = "";
        }
      } catch {}
      return cmds;
    },
    detectFrameworks() { return []; },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readPackageJsonScripts(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    return pkg.scripts || {};
  } catch { return {}; }
}

function readPackageJsonDeps(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ]);
  } catch { return new Set(); }
}

function readAllPythonDeps(rootDir) {
  const parts = [];
  for (const f of ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
    try { parts.push(readFileSync(resolve(rootDir, f), "utf8")); } catch {}
  }
  return parts.join("\n");
}

function markerExists(rootDir, marker) {
  if (marker.includes("*")) {
    // Glob-style: *.csproj, *.sln etc.
    try {
      const ext = marker.replace(/\*/g, "");
      return readdirSync(rootDir).some(f => f.endsWith(ext));
    } catch { return false; }
  }
  return existsSync(resolve(rootDir, marker));
}

function buildPackageScriptCommand(packageManager, scriptName) {
  const pm = String(packageManager || "npm").trim().toLowerCase();
  if (pm === "yarn") return `yarn ${scriptName}`;
  if (pm === "pnpm") return `pnpm ${scriptName}`;
  if (pm === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function readMakefile(rootDir) {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      return readFileSync(resolve(rootDir, name), "utf8");
    } catch {}
  }
  return "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMakeTarget(rootDir, targetNames = []) {
  const makefile = readMakefile(rootDir);
  if (!makefile) return "";
  for (const name of targetNames) {
    const pattern = new RegExp(`^${escapeRegExp(name)}\\s*:`, "m");
    if (pattern.test(makefile)) return name;
  }
  return "";
}

function detectQualityGateCommand(rootDir, commands = {}, options = {}) {
  const packageManager = String(options.packageManager || "").trim().toLowerCase();
  const scripts = readPackageJsonScripts(rootDir);
  if (existsSync(resolve(rootDir, ".githooks", "pre-push"))) {
    return "bash .githooks/pre-push";
  }
  for (const scriptName of ["prepush:check", "prepush-check", "prepush", "pre-push", "verify", "validate", "check"]) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim()) {
      return buildPackageScriptCommand(packageManager, scriptName);
    }
  }

  const makeTarget = findMakeTarget(rootDir, ["prepush", "pre-push", "verify", "validate", "check"]);
  if (makeTarget) {
    return `make ${makeTarget}`;
  }

  return commands.test || commands.lint || commands.build || commands.syntaxCheck || "";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the project stack(s) at the given root directory.
 *
 * @param {string} rootDir - Absolute path to the project root
 * @returns {ProjectDetectionResult}
 *
 * @typedef {object} ProjectDetectionResult
 * @property {DetectedStack[]} stacks    - All detected stacks (may be >1 for monorepos)
 * @property {DetectedStack|null} primary - The primary/first detected stack
 * @property {CommandMap} commands       - Merged command map (primary stack wins)
 * @property {string[]} frameworks       - All detected frameworks
 * @property {boolean} isMonorepo        - True if multiple stacks detected
 *
 * @typedef {object} DetectedStack
 * @property {string} id             - Stack ID (e.g. "node", "python")
 * @property {string} label          - Human-readable label
 * @property {string} packageManager - Detected package manager
 * @property {CommandMap} commands    - Commands for this stack
 * @property {string[]} frameworks   - Detected frameworks
 *
 * @typedef {object} CommandMap
 * @property {string} test          - Test command
 * @property {string} build         - Build command
 * @property {string} lint          - Lint command
 * @property {string} syntaxCheck   - Syntax/compile check command
 * @property {string} [typeCheck]   - Type-check command
 * @property {string} [qualityGate] - Pre-push / pre-PR validation command
 * @property {string} [testFramework] - Detected test framework name
 */
export function detectProjectStack(rootDir) {
  if (!rootDir || !existsSync(rootDir)) {
    return { stacks: [], primary: null, commands: emptyCommands(), frameworks: [], isMonorepo: false };
  }

  const stacks = [];
  for (const def of STACK_DEFINITIONS) {
    const hasMarker = def.markers.some(m => markerExists(rootDir, m));
    if (!hasMarker) continue;

    const pm = def.detectPackageManager(rootDir);
    const commands = def.detectCommands(rootDir);
    commands.qualityGate = detectQualityGateCommand(rootDir, commands, { packageManager: pm });
    const frameworks = def.detectFrameworks(rootDir);
    stacks.push({
      id: def.id,
      label: def.label,
      packageManager: pm,
      commands,
      frameworks,
    });
  }

  const primary = stacks[0] || null;
  const commands = primary?.commands || emptyCommands();
  const allFrameworks = stacks.flatMap(s => s.frameworks);

  return {
    stacks,
    primary,
    commands,
    frameworks: [...new Set(allFrameworks)],
    isMonorepo: stacks.length > 1,
  };
}

/**
 * Get command presets for all supported stacks (for UI dropdowns).
 * Returns a list of { label, value } options for each command type.
 *
 * @param {ProjectDetectionResult} [detected] - Optional detected stack to put first
 * @returns {CommandPresets}
 */
export function getCommandPresets(detected) {
  const presets = {
    test: [],
    build: [],
    lint: [],
    syntaxCheck: [],
    qualityGate: [],
  };

  // If we have a detected stack, put its commands first as "Detected" options
  if (detected?.primary) {
    const cmds = detected.primary.commands;
    const label = `${detected.primary.label} (detected)`;
    if (cmds.test) presets.test.push({ label: `${label}: ${cmds.test}`, value: cmds.test, detected: true });
    if (cmds.build) presets.build.push({ label: `${label}: ${cmds.build}`, value: cmds.build, detected: true });
    if (cmds.lint) presets.lint.push({ label: `${label}: ${cmds.lint}`, value: cmds.lint, detected: true });
    if (cmds.syntaxCheck) presets.syntaxCheck.push({ label: `${label}: ${cmds.syntaxCheck}`, value: cmds.syntaxCheck, detected: true });
    if (cmds.qualityGate) presets.qualityGate.push({ label: `${label}: ${cmds.qualityGate}`, value: cmds.qualityGate, detected: true });
  }

  // Add additional detected stacks (monorepo)
  if (detected?.stacks?.length > 1) {
    for (const stack of detected.stacks.slice(1)) {
      const cmds = stack.commands;
      const label = `${stack.label} (detected)`;
      if (cmds.test) presets.test.push({ label: `${label}: ${cmds.test}`, value: cmds.test, detected: true });
      if (cmds.build) presets.build.push({ label: `${label}: ${cmds.build}`, value: cmds.build, detected: true });
      if (cmds.lint) presets.lint.push({ label: `${label}: ${cmds.lint}`, value: cmds.lint, detected: true });
      if (cmds.syntaxCheck) presets.syntaxCheck.push({ label: `${label}: ${cmds.syntaxCheck}`, value: cmds.syntaxCheck, detected: true });
      if (cmds.qualityGate) presets.qualityGate.push({ label: `${label}: ${cmds.qualityGate}`, value: cmds.qualityGate, detected: true });
    }
  }

  // Add universal presets from all known stacks
  const universalPresets = {
    test: [
      { label: "Node.js — npm test", value: "npm test" },
      { label: "Node.js — yarn test", value: "yarn test" },
      { label: "Node.js — pnpm test", value: "pnpm test" },
      { label: "Python — pytest", value: "pytest" },
      { label: "Python — poetry run pytest", value: "poetry run pytest" },
      { label: "Python — python -m pytest", value: "python -m pytest" },
      { label: "Go — go test ./...", value: "go test ./..." },
      { label: "Rust — cargo test", value: "cargo test" },
      { label: "Java/Maven — mvn test", value: "mvn test" },
      { label: "Java/Gradle — ./gradlew test", value: "./gradlew test" },
      { label: ".NET — dotnet test", value: "dotnet test" },
      { label: "Ruby — bundle exec rspec", value: "bundle exec rspec" },
      { label: "PHP — vendor/bin/phpunit", value: "vendor/bin/phpunit" },
      { label: "Make — make test", value: "make test" },
    ],
    build: [
      { label: "Node.js — npm run build", value: "npm run build" },
      { label: "Node.js — yarn build", value: "yarn build" },
      { label: "Node.js — pnpm build", value: "pnpm build" },
      { label: "Python — python -m build", value: "python -m build" },
      { label: "Python — poetry build", value: "poetry build" },
      { label: "Go — go build ./...", value: "go build ./..." },
      { label: "Rust — cargo build", value: "cargo build" },
      { label: "Java/Maven — mvn package -DskipTests", value: "mvn package -DskipTests" },
      { label: "Java/Gradle — ./gradlew build", value: "./gradlew build" },
      { label: ".NET — dotnet build", value: "dotnet build" },
      { label: "Ruby — bundle exec rake build", value: "bundle exec rake build" },
      { label: "PHP — composer install --no-dev", value: "composer install --no-dev" },
      { label: "Make — make", value: "make" },
    ],
    lint: [
      { label: "Node.js — npm run lint", value: "npm run lint" },
      { label: "Node.js — npx eslint .", value: "npx eslint ." },
      { label: "Python — ruff check .", value: "ruff check ." },
      { label: "Python — flake8", value: "flake8" },
      { label: "Python — pylint", value: "pylint" },
      { label: "Go — golangci-lint run", value: "golangci-lint run" },
      { label: "Rust — cargo clippy -- -D warnings", value: "cargo clippy -- -D warnings" },
      { label: "Java — mvn checkstyle:check", value: "mvn checkstyle:check" },
      { label: ".NET — dotnet format --verify-no-changes", value: "dotnet format --verify-no-changes" },
      { label: "Ruby — bundle exec rubocop", value: "bundle exec rubocop" },
      { label: "PHP — vendor/bin/phpcs", value: "vendor/bin/phpcs" },
      { label: "Make — make lint", value: "make lint" },
    ],
    syntaxCheck: [
      { label: "Node.js — node --check", value: "node --check" },
      { label: "Node.js — npx tsc --noEmit", value: "npx tsc --noEmit" },
      { label: "Python — python -m py_compile", value: "python -m py_compile" },
      { label: "Go — go vet ./...", value: "go vet ./..." },
      { label: "Rust — cargo check", value: "cargo check" },
      { label: "Java/Maven — mvn compile", value: "mvn compile" },
      { label: "Java/Gradle — ./gradlew compileJava", value: "./gradlew compileJava" },
      { label: ".NET — dotnet build --no-restore", value: "dotnet build --no-restore" },
      { label: "Ruby — ruby -c", value: "ruby -c" },
      { label: "PHP — php -l", value: "php -l" },
    ],
    qualityGate: [
      { label: "Node.js — npm run prepush:check", value: "npm run prepush:check" },
      { label: "Node.js — pnpm prepush:check", value: "pnpm prepush:check" },
      { label: "Repository hook — bash .githooks/pre-push", value: "bash .githooks/pre-push" },
      { label: "Go — go test ./...", value: "go test ./..." },
      { label: "Make — make test", value: "make test" },
    ],
  };

  // Merge: skip any universal presets whose value already appears in detected
  for (const key of Object.keys(presets)) {
    const existingValues = new Set(presets[key].map(p => p.value));
    for (const preset of universalPresets[key] || []) {
      if (!existingValues.has(preset.value)) {
        presets[key].push(preset);
      }
    }
  }

  return presets;
}

/**
 * Resolve an "auto" command placeholder to the detected command.
 * If the value isn't "auto", returns it unchanged.
 *
 * @param {string} value - The command value (may be "auto" or an actual command)
 * @param {string} commandType - One of "test", "build", "lint", "syntaxCheck", "qualityGate"
 * @param {string} rootDir - Project root for detection
 * @returns {string} The resolved command
 */
export function resolveAutoCommand(value, commandType, rootDir) {
  if (!value || value.toLowerCase().trim() !== "auto") return value;
  const detected = detectProjectStack(rootDir);
  return detected.commands?.[commandType] || "";
}

function emptyCommands() {
  return { test: "", build: "", lint: "", syntaxCheck: "", typeCheck: "", qualityGate: "" };
}

// Re-export the stack definitions for introspection
export { STACK_DEFINITIONS };
