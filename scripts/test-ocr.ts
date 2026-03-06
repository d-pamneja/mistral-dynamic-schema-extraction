import { SignJWT } from "jose";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
try {
  const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
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

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const JWT_SECRET = process.env.JWT_SECRET!;

async function generateToken(): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ sub: "test-user", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

async function test1_fullSBARequest(token: string) {
  console.log("\n=== Test 1: Full SBA Request ===");
  const body = {
    file_url: "https://arxiv.org/pdf/2201.04234",
    mime_type: "application/pdf",
    file_name: "test_document.pdf",
    source_path: "/test/test_document.pdf",
    loan_package_id: "test-001",
    post_process: {
      table_context_rules: [
        { context: "debt_schedule", header_keywords: ["creditor", "balance", "payment", "debt"], min_matches: 2 },
        { context: "balance_sheet", header_keywords: ["assets", "liabilities", "net worth", "equity"], min_matches: 2 },
      ],
      form_field_patterns: [
        { pattern: "^\\*\\*([^*]{2,60})\\*\\*[:\\s]+(.+)$", flags: "", label_group: 1, value_group: 2 },
        { pattern: "^([A-Z][A-Za-z\\s/&(),'.-]{2,60}):\\s+(.+)$", flags: "", label_group: 1, value_group: 2 },
      ],
      form_field_exclusions: [
        { pattern: "^(Section|Part|Article)\\b", flags: "i" },
      ],
      form_field_type_rules: [
        { field_type: "currency", value_pattern: "\\$[\\d,]+", flags: "", is_pii: false },
        { field_type: "date", value_pattern: "\\d{1,2}/\\d{1,2}/\\d{2,4}", flags: "", is_pii: false },
      ],
      checkbox_patterns: [
        {
          checked_pattern: "☑|\\[X\\]|\\[x\\]|✓",
          unchecked_pattern: "☐|\\[ \\]|✗",
          label_pattern: "(?:☑|☐|\\[.\\]|✓|✗)\\s*(.+)",
          flags: "",
        },
      ],
      signal_patterns: [
        { signal_name: "has_currency", pattern: "\\$[\\d,]+(?:\\.\\d{2})?", flags: "g", report_count: true },
        { signal_name: "has_dates", pattern: "\\d{1,2}/\\d{1,2}/\\d{2,4}", flags: "g", report_count: true },
      ],
      pii_patterns: [
        { pii_type: "ssn", pattern: "\\d{3}-\\d{2}-\\d{4}", flags: "g" },
      ],
      structural_type_rules: {
        rules: [
          { type: "fillable_form", conditions: { min_form_fields: 10, min_checkboxes: 3 }, priority: 10 },
          { type: "financial_table", conditions: { min_tables: 3, min_table_ratio: 0.6 }, priority: 8 },
          { type: "narrative", conditions: {}, priority: 1 },
        ],
        default_type: "unknown",
      },
      preview_config: { max_chars: 2000, strip_excessive_whitespace: true },
    },
  };

  const res = await fetch(`${BASE_URL}/api/ocr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(`Success: ${data.success}`);
  if (data.success) {
    console.log(`Pages: ${data.data.summary.total_pages}`);
    console.log(`Tables: ${data.data.summary.total_tables}`);
    console.log(`Form fields: ${data.data.summary.total_form_fields}`);
    console.log(`Checkboxes: ${data.data.summary.total_checkboxes}`);
    console.log(`Signals:`, JSON.stringify(data.data.classification_hints.signals));
    console.log(`Structural type: ${data.data.classification_hints.structural_type}`);
    console.log(`Modules run: ${data.data.processing.post_process_modules.join(", ")}`);
    console.log(`Timing: OCR ${data.timing.ocr_ms}ms, Post-process ${data.timing.postprocess_ms}ms, Total ${data.timing.total_ms}ms`);
  } else {
    console.log(`Error: ${data.error}`);
    console.log(`Details:`, JSON.stringify(data.details));
  }
  return res.status === 200;
}

async function test2_minimalRequest(token: string) {
  console.log("\n=== Test 2: Minimal Request ===");
  const body = {
    file_url: "https://arxiv.org/pdf/2201.04234",
    mime_type: "application/pdf",
  };

  const res = await fetch(`${BASE_URL}/api/ocr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(`Success: ${data.success}`);
  if (data.success) {
    console.log(`Pages: ${data.data.summary.total_pages}`);
    console.log(`Post-process enabled: ${data.data.processing.post_process_enabled}`);
    console.log(`Timing: Total ${data.timing.total_ms}ms`);
  } else {
    console.log(`Error: ${data.error}`);
  }
  return res.status === 200;
}

async function test3_badRegex(token: string) {
  console.log("\n=== Test 3: Bad Regex Rejection ===");
  const body = {
    file_url: "https://example.com/doc.pdf",
    mime_type: "application/pdf",
    post_process: {
      form_field_patterns: [
        { pattern: "([unclosed", flags: "", label_group: 1, value_group: 2 },
      ],
    },
  };

  const res = await fetch(`${BASE_URL}/api/ocr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(`Success: ${data.success}`);
  console.log(`Error: ${data.error}`);
  if (data.details) console.log(`Details:`, JSON.stringify(data.details));
  return res.status === 400;
}

async function test4_noAuth() {
  console.log("\n=== Test 4: No Auth ===");
  const res = await fetch(`${BASE_URL}/api/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_url: "https://example.com/doc.pdf", mime_type: "application/pdf" }),
  });

  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(`Success: ${data.success}`);
  console.log(`Error: ${data.error}`);
  return res.status === 401;
}

async function main() {
  console.log("Generating JWT token...");
  const token = await generateToken();
  console.log("Token generated.");

  const results: Record<string, boolean> = {};

  results["Test 4: No Auth"] = await test4_noAuth();
  results["Test 3: Bad Regex"] = await test3_badRegex(token);
  results["Test 2: Minimal Request"] = await test2_minimalRequest(token);
  results["Test 1: Full SBA Request"] = await test1_fullSBARequest(token);

  console.log("\n=== Summary ===");
  for (const [name, passed] of Object.entries(results)) {
    console.log(`${passed ? "PASS" : "FAIL"} - ${name}`);
  }

  const allPassed = Object.values(results).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
