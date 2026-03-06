#!/usr/bin/env npx tsx
/**
 * OCR + Post-Process test script
 *
 * Usage:
 *   npx tsx scripts/sba-ocr.ts <file_url> [output_file]
 */

import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { runMistralOCR } from "../src/lib/ocr";
import { postProcessDocument } from "../src/lib/post-process";
import type { OCRDocument } from "../src/lib/schemas";

// ─── Load .env.local ───
try {
  const envPath = resolve(process.cwd(), ".env.local");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

// Cost: $1 per 1000 pages (OCR is the only AI cost)
const OCR_COST_PER_PAGE = 1 / 1000;

// ─── MAIN ───
async function main() {
  const fileUrl = process.argv[2];
  const outputPath = process.argv[3];

  if (!fileUrl) {
    console.error("Usage: npx tsx scripts/sba-ocr.ts <file_url> [output_file]");
    process.exit(1);
  }

  if (!process.env.MISTRAL_API_KEY) {
    console.error("ERROR: MISTRAL_API_KEY not set. Check .env.local");
    process.exit(1);
  }

  const totalStart = Date.now();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   OCR + Post-Process — Mistral OCR + Code Heuristics   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`File URL:   ${fileUrl}`);
  console.log(`OCR Model:  mistral-ocr-latest`);
  console.log("");

  // ── Step 1: Mistral OCR (perception only — the ONLY AI cost) ──
  console.log("Step 1: Running Mistral OCR...");
  const ocrResult = await runMistralOCR(fileUrl, {
    model: "mistral-ocr-latest",
    includeImageBase64: false,
  });

  const ocrPages = ocrResult.pages.length;
  const ocrCost = ocrPages * OCR_COST_PER_PAGE;
  console.log(`  Done in ${ocrResult.ocrDurationMs}ms — ${ocrPages} pages ($${ocrCost.toFixed(4)})`);
  console.log("");

  // ── Step 2: Post-process (pure code, $0, <100ms) ──
  console.log("Step 2: Running post-process (regex/heuristics)...");
  const postResult = postProcessDocument(ocrResult.pages);
  console.log(`  Done in ${postResult.postprocess_duration_ms}ms`);
  console.log("");

  // ── Assemble final document (mirrors route.ts) ──
  const now = Date.now();

  const document: OCRDocument = {
    file_info: {
      file_name: fileUrl.split("/").pop() || "unknown",
      mime_type: "application/pdf",
      file_url: fileUrl,
      source_path: "",
      content_hash: null,
      loan_package_id: null,
      metadata: null,
    },
    processing: {
      ocr_model: "mistral-ocr-latest",
      ocr_duration_ms: ocrResult.ocrDurationMs,
      postprocess_duration_ms: postResult.postprocess_duration_ms,
      total_duration_ms: now - totalStart,
      processed_at: new Date().toISOString(),
      ocr_pages_processed: ocrPages,
    },
    summary: postResult.summary,
    classification_hints: postResult.classification_hints,
    pages: postResult.pages,
    full_text: postResult.full_text,
  };

  // ─── Print summary ───
  const totalMs = now - totalStart;

  console.log("═══════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════");
  console.log("");

  console.log("── Timing & Cost ──");
  console.log(`  OCR:          ${ocrResult.ocrDurationMs}ms  ($${ocrCost.toFixed(4)})`);
  console.log(`  Post-process: ${postResult.postprocess_duration_ms}ms  ($0.0000)`);
  console.log(`  Total:        ${totalMs}ms  ($${ocrCost.toFixed(4)})`);
  console.log("");

  const { summary, classification_hints: cls } = postResult;

  console.log("── Summary ──");
  console.log(`  Pages:      ${summary.total_pages}`);
  console.log(`  Tables:     ${summary.total_tables}`);
  console.log(`  Checkboxes: ${summary.total_checkboxes}`);
  console.log(`  Chars:      ${summary.total_chars.toLocaleString()}`);
  console.log(`  Est Tokens: ${summary.estimated_tokens.toLocaleString()}`);
  console.log("");

  console.log("── Classification ──");
  console.log(`  Type:      ${cls.structural_type}`);
  if (cls.detected_form_id) console.log(`  Form ID:   ${cls.detected_form_id}`);
  if (cls.detected_form_name) console.log(`  Form Name: ${cls.detected_form_name}`);
  if (cls.tax_year) console.log(`  Tax Year:  ${cls.tax_year}`);
  if (cls.entity_name) console.log(`  Entity:    ${cls.entity_name}`);
  if (cls.entity_ein) console.log(`  EIN:       ${cls.entity_ein}`);
  if (cls.contains_k1s) console.log(`  K-1s:      ${cls.k1_count} (${cls.shareholder_count} shareholders)`);
  const signals = Object.entries(cls.financial_signals)
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace("has_", ""));
  if (signals.length) console.log(`  Signals:   ${signals.join(", ")}`);
  console.log("");

  console.log("── Per-page Breakdown ──");
  for (const page of postResult.pages) {
    const pm = page.page_metadata;
    const parts = [
      `${pm.char_count} chars`,
      pm.content_type,
      pm.table_count > 0 ? `${pm.table_count} tables` : null,
      pm.has_pii ? "PII" : null,
      pm.section_label || null,
    ].filter(Boolean);
    console.log(`  Page ${String(page.page_number).padStart(3)}: ${parts.join(" | ")}`);
  }

  // ─── Save output ───
  const outFile = outputPath || `output/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const outDir = dirname(outFile);
  mkdirSync(outDir, { recursive: true });

  const output = {
    success: true,
    data: document,
    timing: {
      ocr_ms: ocrResult.ocrDurationMs,
      postprocess_ms: postResult.postprocess_duration_ms,
      total_ms: totalMs,
    },
  };
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log("");
  console.log(`JSON saved to: ${outFile} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);

  const textFile = outFile.replace(/\.json$/, ".txt");
  writeFileSync(textFile, postResult.full_text);
  console.log(`Text saved to: ${textFile} (${(postResult.full_text.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("Script failed:", err.message || err);
  process.exit(1);
});
