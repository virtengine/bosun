import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import vm from "node:vm";
import { discoverSourceModules, validateImports } from "./import-check.mjs";
import { collectPromptLintViolations, formatPromptLintViolations } from "./prompt-lint.mjs";

function discoverSyntaxModules(rootDir, files) {
  if (Array.isArray(files) && files.length > 0) {
    return [...new Set(files.map((file) => String(file || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }
  const discovered = discoverSourceModules(rootDir);
  if (discovered.length > 0) return discovered;
  return readdirSync(rootDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort((a, b) => a.localeCompare(b));
}

function parseArgs(argv = []) {
  const parsed = {
    rootDir: process.cwd(),
    files: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      parsed.rootDir = resolve(argv[++i]);
    } else if (argv[i] === "--files" && argv[i + 1]) {
      parsed.files = argv[++i].split(",").map((file) => file.trim()).filter(Boolean);
    }
  }
  return parsed;
}

/**
 * Recursively collect *.js files from a directory.
 */
function listJsFilesRecursive(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip vendor directories — those are third-party bundles
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      results.push(...listJsFilesRecursive(fullPath));
    } else if (entry.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

function validateModuleSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  // Construction parses source and throws on syntax errors without executing module code.
  new vm.SourceTextModule(source, { identifier: filePath });
}

function validateBrowserModuleSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  const mod = new vm.SourceTextModule(source, { identifier: filePath });
  let hasTLA = false;
  const tlaProp = mod.hasTopLevelAwait;
  if (typeof tlaProp === "function") {
    hasTLA = !!tlaProp.call(mod);
  } else if (typeof tlaProp === "boolean") {
    hasTLA = tlaProp;
  }
  if (hasTLA) {
    throw new Error(
      "Top-level await is not allowed in browser-served modules because embedded WebViews can fail with 'Unexpected reserved word'.",
    );
  }
}

/**
 * Parse a JS file using the Module compiler.
 * Catches syntax errors such as unterminated statements or bad tokens.
 * UI files use ES module syntax (import/export) via browser importmaps.
 */
function validateScriptSyntax(filePath) {
  validateBrowserModuleSyntax(filePath);
}

async function main() {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "vm.SourceTextModule is unavailable. Run with --experimental-vm-modules.",
    );
  }

  const { rootDir, files: requestedFiles } = parseArgs(process.argv.slice(2));
  const files = discoverSyntaxModules(rootDir, requestedFiles);
  let failed = false;

  for (const file of files) {
    const filePath = resolve(rootDir, file);
    try {
      validateModuleSyntax(filePath);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Syntax error: ${file}`);
      console.error(message);
    }
  }

  if (failed) {
    process.exit(1);
  }

  // ── Phase 2: Parse-check browser JavaScript files ─────────────────────
  // These files are loaded directly in the browser via import maps. Keep
  // them free of syntax that older embedded WebViews reject at parse time.
  const browserRoots = [
    resolve(rootDir, "ui"),
    resolve(rootDir, "site", "ui"),
  ];
  const browserFiles = [...new Set(browserRoots.flatMap((dir) => listJsFilesRecursive(dir)))];
  let uiFailed = false;

  for (const filePath of browserFiles) {
    try {
      validateScriptSyntax(filePath);
    } catch (error) {
      uiFailed = true;
      const rel = relative(rootDir, filePath);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Syntax error: ${rel}`);
      console.error(message);
    }
  }

  if (uiFailed) {
    process.exit(1);
  }

  console.log(`Syntax OK: ${files.length} modules + ${browserFiles.length} browser files checked`);

  // ── Phase 3: ESM import binding validation ────────────────────────────
  // Link all local modules together using vm.SourceTextModule.link() to
  // verify that every named import actually exists as an export in the
  // target module.  This catches ghost imports from partial merges, WIP
  // saves, and renames that missed a call-site.
  const { errors: importErrors, moduleCount } = await validateImports({ rootDir, files });

  if (importErrors.length > 0) {
    console.error("\nImport validation failed:\n");
    for (const { file, error } of importErrors) {
      console.error(`  \u2717 ${file}`);
      console.error(`    ${error}\n`);
    }
    process.exit(1);
  }

  console.log(`Imports OK: ${moduleCount} modules linked, 0 broken imports`);

  const promptLintViolations = collectPromptLintViolations(rootDir);
  if (promptLintViolations.length > 0) {
    console.error("\nPrompt lint failed:\n");
    console.error(formatPromptLintViolations(promptLintViolations));
    process.exit(1);
  }

  console.log("Prompt lint OK: no narration anti-patterns found in .bosun/agents");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
