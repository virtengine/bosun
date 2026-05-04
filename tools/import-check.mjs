/**
 * import-check.mjs — ESM named-export validation gate.
 *
 * Uses vm.SourceTextModule.link() to validate that every named import
 * from a local module actually exists as an export in the target module.
 * This catches the class of errors where a named import is added but the
 * corresponding export doesn't exist (e.g., partial merges, abandoned WIP,
 * renames that missed a call-site).
 *
 * External dependencies (node: builtins, npm packages) are dynamically
 * imported and mirrored as SyntheticModules so that local module linking
 * succeeds without requiring the full dependency graph.
 */

import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const JS_EXTENSIONS = new Set([".mjs", ".js", ".cjs"]);

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildSyntaxError(rootDir, absPath, error) {
  const moduleFile = relative(rootDir, absPath);
  const syntaxError = new Error(`Syntax error in ${moduleFile}: ${toErrorMessage(error)}`);
  syntaxError.code = "module_syntax_error";
  syntaxError.moduleFile = moduleFile;
  return syntaxError;
}

/**
 * Discover all .mjs source modules via git, excluding test/bench/site/desktop.
 */
export function discoverSourceModules(rootDir) {
  try {
    const output = execSync("git ls-files --cached", {
      encoding: "utf8",
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(
        (f) =>
          f.endsWith(".mjs") &&
          !f.startsWith("tests/") &&
          !f.startsWith("bench/") &&
          !f.startsWith("site/") &&
          !f.startsWith("desktop/") &&
          !f.startsWith("tools/"),
      )
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Validate all ESM named imports by linking modules with vm.SourceTextModule.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir] — project root (default: cwd)
 * @param {string[]} [opts.files] — explicit list of relative .mjs paths to check
 * @returns {{ errors: Array<{file: string, error: string}>, moduleCount: number }}
 */
export async function validateImports({ rootDir, files } = {}) {
  rootDir = rootDir ?? process.cwd();

  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "vm.SourceTextModule is unavailable. Run with --experimental-vm-modules.",
    );
  }

  const context = vm.createContext({});
  const moduleCache = new Map(); // absolute path → SourceTextModule | SyntheticModule
  const externalCache = new Map(); // specifier → SyntheticModule
  const unresolvedExternals = new Set(); // specifiers that couldn't be dynamically imported
  const errors = [];
  const parseErrors = new Map(); // absolute path → Error

  const moduleFiles = files ?? discoverSourceModules(rootDir);
  const seenErrors = new Set();

  function recordError(file, error) {
    const message = toErrorMessage(error);
    const key = `${file}\n${message}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    errors.push({ file, error: message });
  }

  // Phase 1: Parse all source modules into SourceTextModules.
  for (const file of moduleFiles) {
    const absPath = resolve(rootDir, file);
    if (!existsSync(absPath)) continue;
    try {
      const source = readFileSync(absPath, "utf8");
      const mod = new vm.SourceTextModule(source, {
        identifier: absPath,
        context,
      });
      moduleCache.set(absPath, mod);
    } catch (error) {
      parseErrors.set(absPath, buildSyntaxError(rootDir, absPath, error));
    }
  }

  /**
   * Create a SyntheticModule stub for an external dependency.
   * Dynamically imports the real module to mirror its export names.
   */
  async function stubExternal(specifier) {
    if (externalCache.has(specifier)) return externalCache.get(specifier);

    let exportNames = ["default"];
    try {
      const real = await import(specifier);
      exportNames = Object.keys(real);
      if (!exportNames.includes("default")) exportNames.push("default");
    } catch {
      // Cannot import (optional dep, missing from node_modules, etc.).
      // Track as unresolved so we can suppress false-positive named-export
      // errors that occur when running from a worktree without node_modules.
      unresolvedExternals.add(specifier);
    }

    const synth = new vm.SyntheticModule(
      exportNames,
      function () {
        for (const name of exportNames) this.setExport(name, undefined);
      },
      { identifier: `external:${specifier}`, context },
    );
    // SyntheticModules have no dependencies, so linker is never called.
    await synth.link(() => {});
    externalCache.set(specifier, synth);
    return synth;
  }

  /**
   * Create a SyntheticModule stub for a non-JS file (e.g., .json, .node).
   */
  async function stubNonJs(absPath) {
    if (moduleCache.has(absPath)) return moduleCache.get(absPath);

    const synth = new vm.SyntheticModule(
      ["default"],
      function () {
        this.setExport("default", undefined);
      },
      { identifier: absPath, context },
    );
    await synth.link(() => {});
    moduleCache.set(absPath, synth);
    return synth;
  }

  /**
   * Linker callback for vm.SourceTextModule.link().
   * Resolves specifiers to cached modules or creates stubs.
   */
  async function linker(specifier, referencingModule) {
    // ── External dependency (node: builtin or npm package) ──
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      return stubExternal(specifier);
    }

    // ── Local import — resolve relative to referencing module ──
    const refDir = dirname(referencingModule.identifier);
    const resolved = resolve(refDir, specifier);

    // Already parsed / stubbed
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    if (parseErrors.has(resolved)) throw parseErrors.get(resolved);

    // Non-JS file (.json, .node, .wasm, etc.)
    if (!JS_EXTENSIONS.has(extname(resolved))) {
      return stubNonJs(resolved);
    }

    // JS file outside our initial scan (e.g., vendor/, tools/ dependency)
    if (existsSync(resolved)) {
      try {
        const source = readFileSync(resolved, "utf8");
        const mod = new vm.SourceTextModule(source, {
          identifier: resolved,
          context,
        });
        moduleCache.set(resolved, mod);
        return mod;
      } catch (error) {
        const syntaxError = buildSyntaxError(rootDir, resolved, error);
        parseErrors.set(resolved, syntaxError);
        throw syntaxError;
      }
    }

    // File doesn't exist — report clearly.
    throw new Error(
      `Cannot find module '${specifier}' imported from ${relative(rootDir, referencingModule.identifier)}`,
    );
  }

  // Phase 2: Link all modules — this validates named export bindings.
  for (const [absPath, syntaxError] of parseErrors) {
    recordError(relative(rootDir, absPath), syntaxError);
  }

  for (const [absPath, mod] of moduleCache) {
    // Already linked (as a transitive dependency of a previously linked module).
    if (mod.status !== "unlinked") continue;
    try {
      await mod.link(linker);
    } catch (err) {
      const rel = typeof err?.moduleFile === "string" && err.moduleFile
        ? err.moduleFile
        : relative(rootDir, absPath);
      recordError(rel, err);
    }
  }

  // Suppress errors caused by unresolvable external packages (e.g. missing
  // node_modules when running from a git worktree).  The pattern emitted by
  // vm.SourceTextModule is: "The requested module '<spec>' does not provide
  // an export named '<name>'".
  const filteredErrors = errors.filter(({ error }) => {
    for (const spec of unresolvedExternals) {
      if (error.includes(`'${spec}'`)) return false;
    }
    return true;
  });

  return { errors: filteredErrors, moduleCount: moduleCache.size };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let rootDir = process.cwd();
  let files = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      rootDir = resolve(args[++i]);
    } else if (args[i] === "--files" && args[i + 1]) {
      files = args[++i].split(",").filter(Boolean);
    }
  }

  const { errors, moduleCount } = await validateImports({ rootDir, files });

  if (errors.length > 0) {
    console.error("Import validation failed:\n");
    for (const { file, error } of errors) {
      console.error(`  \u2717 ${file}`);
      console.error(`    ${error}\n`);
    }
    process.exit(1);
  }

  console.log(
    `Imports OK: ${moduleCount} modules linked, 0 broken imports`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
