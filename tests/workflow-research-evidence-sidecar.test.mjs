import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractPdfTextHeuristically,
  runResearchEvidenceSidecar,
} from "../workflow/research-evidence-sidecar.mjs";

function escapePdfLiteral(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildSimplePdf(text) {
  const contentStream = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `(${escapePdfLiteral(text)}) Tj`,
    "ET",
    "",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(contentStream, "ascii")} >>\nstream\n${contentStream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, objectBody] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function makeTempRepoRoot() {
  return mkdtempSync(join(tmpdir(), "bosun-research-sidecar-"));
}

describe("research-evidence-sidecar pdf ingestion", () => {
  const tempRoots = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  it("extracts text from inline PDF content streams without external tooling", () => {
    const result = extractPdfTextHeuristically(
      buildSimplePdf("Bosun keeps research answers grounded in citations."),
    );

    expect(result.text).toContain("Bosun keeps research answers grounded in citations.");
    expect(result.pageCount).toBe(1);
    expect(result.ingestionMethod).toBe("pdf-inline-parser");
  });

  it("ingests PDF corpus files into the evidence bundle with stable metadata", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(
      join(repoRoot, "docs", "evidence.pdf"),
      buildSimplePdf("Grounded citations reduce hallucination during retrieval-augmented synthesis."),
    );

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "How do grounded citations reduce hallucination in retrieval-augmented research synthesis?",
      domain: "computer-science",
      evidenceMode: "answer",
      searchLiterature: false,
      corpusPaths: ["docs/evidence.pdf"],
      maxEvidenceSources: 4,
    });

    expect(result.success).toBe(true);
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(result.bundle.metrics.corpusSourceCount).toBe(1);
    expect(result.bundle.metrics.runtimeLogSourceCount).toBe(0);
    expect(result.bundle.metrics.retainedSourceCount).toBe(1);
    expect(result.citationsMarkdown).toContain("[E1]");
    expect(result.researchToolBundle?.id).toBe("scientific-evidence");
    expect(result.toolBundleBrief).toContain("recommended MCP");
    expect(result.researchToolBundle?.recommendedServerIds).toEqual(
      expect.arrayContaining(["fetch", "filesystem", "context7"]),
    );

    const [source] = result.bundle.sources;
    expect(source.citation).toBe("docs/evidence.pdf");
    expect(source.excerpt.toLowerCase()).toContain("grounded citations reduce hallucination");
    expect(source.score).toBeGreaterThan(0);
    expect(source.metadata).toMatchObject({
      relativePath: "docs/evidence.pdf",
      sourceKind: "pdf",
      contentType: "application/pdf",
      fileExtension: ".pdf",
      pageCount: 1,
    });
    expect(source.metadata.fileSizeBytes).toBeGreaterThan(0);
    expect(source.metadata.extractedCharacters).toBeGreaterThan(20);
    expect(["pdftotext", "pdf-inline-parser"]).toContain(source.metadata.ingestionMethod);

    const artifact = JSON.parse(readFileSync(result.artifactPath, "utf8"));
    expect(artifact.bundle.sources[0].metadata.sourceKind).toBe("pdf");
    expect(artifact.bundle.sources[0].metadata.contentType).toBe("application/pdf");
    expect(artifact.bundle.sources[0].metadata.relativePath).toBe("docs/evidence.pdf");
    expect(artifact.bundle.researchToolBundle?.id).toBe("scientific-evidence");
  });

  it("keeps running and records a warning when a PDF corpus file is unreadable", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);
    writeFileSync(join(repoRoot, "broken.pdf"), "%PDF-1.4\nbroken\n", "ascii");

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "Check unreadable PDF handling.",
      domain: "computer-science",
      searchLiterature: false,
      corpusPaths: ["broken.pdf"],
      maxEvidenceSources: 3,
    });

    expect(result.success).toBe(true);
    expect(result.bundle.sources).toEqual([]);
    expect(
      result.bundle.warnings.some((warning) =>
        warning.includes("Failed to read corpus file") && warning.includes("broken.pdf"),
      ),
    ).toBe(true);
  });

  it("builds a synthesized local answer summary with citations and highlights", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "Do grounded citations reduce hallucination in retrieval-augmented research answers?",
      domain: "computer-science",
      evidenceMode: "answer",
      searchLiterature: true,
      literatureResults: [
        {
          title: "Study A",
          url: "https://example.com/study-a",
          snippet:
            "Grounded citations reduced hallucination and improved factual accuracy in retrieval-augmented research answers.",
        },
        {
          title: "Study B",
          url: "https://example.com/study-b",
          snippet:
            "Audited citation trails improved verifier confidence and reduced unsupported claims during research synthesis.",
        },
      ],
      maxEvidenceSources: 4,
    });

    expect(result.success).toBe(true);
    expect(result.bundle.summary.startsWith("Mode:")).toBe(false);
    expect(result.bundle.summary).toContain("[E1]");
    expect(result.bundle.summary.toLowerCase()).toContain("strongest retained evidence");
    expect(Array.isArray(result.bundle.highlights)).toBe(true);
    expect(result.bundle.highlights.length).toBeGreaterThan(0);
    expect(result.bundle.highlights[0]).toMatchObject({
      citationKey: "[E1]",
    });
    expect(result.evidenceBrief).toContain("Mode: answer");
    expect(result.evidenceBrief).toContain("[E1] Study A");
    expect(typeof result.bundle.uncertaintySummary).toBe("string");
  });

  it("pulls bounded runtime log evidence into the bundle when logs match the research problem", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);
    mkdirSync(join(repoRoot, ".bosun", "logs"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".bosun", "logs", "monitor.log"),
      [
        "scheduler started",
        "retrieval hallucination mitigation enabled for literature synthesis",
        "grounded citations reduce unsupported claims in retrieval workflows",
      ].join("\n"),
      "utf8",
    );

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "How do grounded citations reduce hallucination in retrieval workflows?",
      domain: "computer-science",
      searchLiterature: false,
      corpusPaths: [],
      includeRuntimeLogEvidence: true,
    });

    expect(result.success).toBe(true);
    expect(result.bundle.metrics.runtimeLogSourceCount).toBe(1);
    const runtimeSource = result.bundle.sources.find((source) => source.metadata?.sourceKind === "runtime-log");
    expect(runtimeSource).toBeTruthy();
    expect(runtimeSource.citation).toBe(".bosun/logs/monitor.log");
    expect(runtimeSource.excerpt.toLowerCase()).toContain("grounded citations");
    expect(runtimeSource.metadata.ingestionMethod).toBe("tail-line-query");
  });

  it("builds contradiction-focused summaries and conflict records when sources disagree", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "Do grounded citations improve factual accuracy and reduce hallucination in retrieval systems?",
      domain: "computer-science",
      evidenceMode: "contradictions",
      searchLiterature: true,
      literatureResults: [
        {
          title: "Supportive Trial",
          url: "https://example.com/supportive",
          snippet:
            "Grounded citations improved factual accuracy and reduced hallucination in retrieval systems across benchmark tasks.",
        },
        {
          title: "Negative Trial",
          url: "https://example.com/negative",
          snippet:
            "Grounded citations did not improve factual accuracy and may increase hallucination when retrieval quality is poor.",
        },
      ],
      maxEvidenceSources: 4,
    });

    expect(result.success).toBe(true);
    expect(result.bundle.conflicts.length).toBeGreaterThan(0);
    expect(result.bundle.summary).toContain("[E1]");
    expect(result.bundle.summary).toContain("[E2]");
    expect(result.bundle.summary.toLowerCase()).toMatch(/mixed|disagree/);
    expect(result.bundle.reviewHints.toLowerCase()).toContain("conflicting evidence");
  });

  it("populates review hints when evidence is sparse or indirect", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "Do grounded citations reduce hallucination in retrieval-augmented medical research answers?",
      domain: "medical-informatics",
      evidenceMode: "answer",
      searchLiterature: true,
      literatureResults: [
        {
          title: "General Team Notes",
          url: "https://example.com/notes",
          snippet: "Literature reviews are useful for team learning and project communication.",
        },
      ],
      maxEvidenceSources: 3,
    });

    expect(result.success).toBe(true);
    expect(result.bundle.reviewHints.toLowerCase()).toMatch(/only one retained evidence source|weak|indirect|missing direct evidence/);
    expect(result.bundle.metrics.problemTokenCoverageRatio).toBeLessThan(0.45);
  });

  it("preserves external summary and review hints while still merging local evidence", async () => {
    const repoRoot = makeTempRepoRoot();
    tempRoots.push(repoRoot);
    const sidecarScriptPath = join(repoRoot, "emit-sidecar.mjs");
    writeFileSync(
      sidecarScriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        "  summary: 'External synthesis summary [E1]',",
        "  reviewHints: 'External verifier hint',",
        "  sources: [{ citation: 'External Source', locator: 'https://example.com/external', excerpt: 'External sidecar evidence excerpt about grounded citations reducing hallucination.' }]",
        "}));",
      ].join("\n"),
      "utf8",
    );

    const result = await runResearchEvidenceSidecar({
      repoRoot,
      problem: "Do grounded citations reduce hallucination in retrieval-augmented research answers?",
      domain: "computer-science",
      evidenceMode: "answer",
      searchLiterature: true,
      literatureResults: [
        {
          title: "Local Source",
          url: "https://example.com/local",
          snippet: "Local evidence says grounded citations reduce unsupported claims in retrieval workflows.",
        },
      ],
      maxEvidenceSources: 4,
      sidecarCommand: `"${process.execPath}" "${sidecarScriptPath}"`,
    });

    expect(result.success).toBe(true);
    expect(result.delegation?.success).toBe(true);
    expect(result.bundle.summary).toBe("External synthesis summary [E1]");
    expect(result.bundle.reviewHints).toBe("External verifier hint");
    expect(result.bundle.sources.length).toBeGreaterThan(1);
    expect(result.evidenceBrief).toContain("[E1]");
    expect(result.evidenceBrief).toContain("External Source");
  });
});
