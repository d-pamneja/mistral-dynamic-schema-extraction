// ============================================================================
// post-process.ts — Step 1: Code-Only Post-Processing ($0, <100ms)
// ============================================================================
//
// Runs AFTER Mistral OCR returns raw markdown pages.
// Produces STRUCTURAL METADATA via regex/heuristics — no LLM calls.
//
// What this produces (for Step 2 Classification):
//   - Per-page: table count, checkbox count, financial/PII flags, content type,
//     section label
//   - Document-level: detected form ID, entity name, EIN, tax year, structural
//     type, financial signals, K-1 count, shareholder count
//
// What this does NOT produce (left for Step 3 Extraction):
//   - Parsed table JSON (headers/rows) — Step 3 uses type-specific schemas
//   - Form field label:value pairs — Step 3 extracts with domain knowledge
//   - Third-person narrative summaries — Step 3's job
//   - Red flag detection — Step 3 + evaluation layer
//
// Design principle: COUNT and CLASSIFY, don't EXTRACT.
//   If a regex can reliably detect presence/count, do it here.
//   If it requires semantic understanding, leave it for the LLM.
// ============================================================================

import type { RawPage } from "./ocr";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PageMetadata {
  char_count: number;
  line_count: number;
  is_blank: boolean;
  has_tables: boolean;
  table_count: number;
  has_checkboxes: boolean;
  checkbox_count: number;
  has_financial_data: boolean;
  has_pii: boolean;
  has_images: boolean;
  estimated_tokens: number;
  content_type: string;
  section_label: string | null;
}

export interface ProcessedPage {
  page_number: number;
  sheet_name: string | null;
  markdown: string;
  images: any[];
  page_metadata: PageMetadata;
}

export interface FinancialSignals {
  has_currency: boolean;
  has_percentages: boolean;
  has_dates: boolean;
  has_account_numbers: boolean;
  has_tax_ids: boolean;
  has_signatures: boolean;
  gross_revenue: string | null;
  total_assets: string | null;
  ordinary_income: string | null;
}

export interface ClassificationHints {
  preview_text: string;
  structural_type: string;
  detected_form_id: string | null;
  detected_form_name: string | null;
  tax_year: string | null;
  entity_name: string | null;
  entity_ein: string | null;
  preparer_name: string | null;
  contains_k1s: boolean;
  k1_count: number;
  shareholder_count: number;
  sheet_names: string[];
  financial_signals: FinancialSignals;
}

export interface DocumentSummary {
  total_pages: number;
  total_tables: number;
  total_checkboxes: number;
  total_images: number;
  total_chars: number;
  estimated_tokens: number;
  pages_with_pii: number;
  pages_with_financial_data: number;
  unique_sections: string[];
}

export interface PostProcessResult {
  pages: ProcessedPage[];
  full_text: string;
  summary: DocumentSummary;
  classification_hints: ClassificationHints;
  postprocess_duration_ms: number;
}

// ─────────────────────────────────────────────
// Known SBA/IRS Form Patterns
// ─────────────────────────────────────────────
// Order matters: more specific patterns first to avoid partial matches.
// Each pattern matches against the full_text (first ~10K chars for speed).

interface FormPattern {
  id: string;
  name: string;
  patterns: RegExp[];
}

const KNOWN_FORMS: FormPattern[] = [
  {
    id: "1120S",
    name: "U.S. Income Tax Return for an S Corporation",
    patterns: [
      /Form\s+1120[\s-]S\b/i,
      /1120-S\s*\(/,
      /Income Tax Return for an S Corporation/i,
    ],
  },
  {
    id: "1120",
    name: "U.S. Corporation Income Tax Return",
    patterns: [
      /Form\s+1120\b(?![\s-]S)/i,
      /Corporation Income Tax Return(?!\s+for an S)/i,
    ],
  },
  {
    id: "1065",
    name: "U.S. Return of Partnership Income",
    patterns: [/Form\s+1065\b/i, /Return of Partnership Income/i],
  },
  {
    id: "1040",
    name: "U.S. Individual Income Tax Return",
    patterns: [/Form\s+1040\b/i, /Individual Income Tax Return/i],
  },
  {
    id: "1919",
    name: "Borrower Information Form (SBA 1919)",
    patterns: [
      /SBA\s+Form\s+1919\b/i,
      /Form\s+1919\b/i,
      /Borrower Information Form/i,
    ],
  },
  {
    id: "413",
    name: "Personal Financial Statement (SBA 413)",
    patterns: [
      /SBA\s+Form\s+413\b/i,
      /Form\s+413\b/i,
      /Personal Financial Statement/i,
    ],
  },
  {
    id: "912",
    name: "Statement of Personal History (SBA 912)",
    patterns: [
      /SBA\s+Form\s+912\b/i,
      /Statement of Personal History/i,
    ],
  },
  {
    id: "8821",
    name: "Tax Information Authorization (IRS 8821)",
    patterns: [/Form\s+8821\b/i, /Tax Information Authorization/i],
  },
  {
    id: "4506-T",
    name: "Request for Transcript of Tax Return",
    patterns: [/Form\s+4506[\s-]?T\b/i, /Request for Transcript/i],
  },
  {
    id: "4562",
    name: "Depreciation and Amortization (IRS 4562)",
    patterns: [/Form\s+4562\b/i, /Depreciation and Amortization/i],
  },
  {
    id: "1125-A",
    name: "Cost of Goods Sold (IRS 1125-A)",
    patterns: [/Form\s+1125[\s-]A\b/i, /Cost of Goods Sold/i],
  },
  {
    id: "1125-E",
    name: "Compensation of Officers (IRS 1125-E)",
    patterns: [/Form\s+1125[\s-]E\b/i, /Compensation of Officers/i],
  },
  {
    id: "K-1",
    name: "Schedule K-1 (Partner/Shareholder Share)",
    patterns: [/Schedule\s+K[\s-]1\b/i],
  },
  {
    id: "Schedule-C",
    name: "Schedule C (Profit or Loss from Business)",
    patterns: [/Schedule\s+C\b(?!\s*-)/i, /Profit or Loss [Ff]rom Business/i],
  },
  {
    id: "Schedule-E",
    name: "Schedule E (Supplemental Income and Loss)",
    patterns: [/Schedule\s+E\b/i, /Supplemental Income and Loss/i],
  },
];

// ─────────────────────────────────────────────
// Section Label Patterns (per-page)
// ─────────────────────────────────────────────
// Detects IRS form sections, schedule names, statement numbers.
// Returns the FIRST strong match found on a page.

interface SectionPattern {
  label: string;
  pattern: RegExp;
}

const SECTION_PATTERNS: SectionPattern[] = [
  // Specific form pages (check these first)
  { label: "Form 1125-A Cost of Goods Sold", pattern: /Form\s+1125[\s-]A\b.*Cost of Goods/i },
  { label: "Form 1125-E Compensation of Officers", pattern: /Form\s+1125[\s-]E\b.*Compensation/i },
  { label: "Form 4562 Depreciation and Amortization", pattern: /Form\s+4562\b.*Depreciation/i },

  // Schedule sections
  { label: "Schedule B Other Information", pattern: /Schedule\s+B\s+Other Information/i },
  { label: "Schedule K Shareholders' Pro Rata Share Items", pattern: /Schedule\s+K[\s\n]+Shareholders/i },
  { label: "Schedule L Balance Sheets per Books", pattern: /Schedule\s+L[\s\n]+Balance Sheets/i },
  { label: "Schedule M-1 and M-2", pattern: /Schedule\s+M-1\s+Reconciliation/i },
  { label: "Schedule M-2", pattern: /Schedule\s+M-2\s+Analysis/i },

  // K-1 schedules (will be enriched with shareholder number)
  { label: "Schedule K-1", pattern: /Schedule\s+K[\s-]1\s+\(Form/i },

  // Depreciation reports
  { label: "Alternative Minimum Tax Depreciation Report", pattern: /ALTERNATIVE MINIMUM TAX DEPRECIATION/i },
  { label: "Depreciation and Amortization Report", pattern: /DEPRECIATION AND AMORTIZATION REPORT/i },

  // QBI / Elections
  { label: "Qualified Business Income (Section 199A)", pattern: /Qualified Business Income.*Section 199A/i },
  { label: "De Minimis Safe Harbor Election", pattern: /DE MINIMIS SAFE HARBOR ELECTION/i },

  // Statement pages
  { label: "Statements", pattern: /^(?:COM-JET|[A-Z\s]+)\n\d{2}-\d{7}\n\n\|.*STATEMENT\s+\d/m },

  // List of Codes (K-1 reference pages)
  { label: "List of Codes", pattern: /^(?:\d\n\n)?#?\s*List of Codes/m },

  // Form 1120-S main pages
  { label: "Form 1120-S Page 1", pattern: /Form\s+1120[\s-]S\n.*Income Tax Return for an S Corp/i },
];

// ─────────────────────────────────────────────
// Regex Constants
// ─────────────────────────────────────────────

// Pipe-table detection: a line that starts/ends with | or has multiple |
const PIPE_LINE_RE = /^[\s]*\|.+\|[\s]*$/;
// Separator row: | --- | --- | or similar
const SEPARATOR_RE = /^\|[\s:]*-{2,}[\s:]*\|/;

// Checkbox symbols
const CHECKBOX_CHECKED_RE = /☑|✓|✔|\[X\]|\[x\]|\(X\)|\(x\)/g;
const CHECKBOX_UNCHECKED_RE = /☐|✗|✘|\[\s\]|\(\s\)/g;

// Financial patterns
const DOLLAR_RE = /\$\s*[\d,]+\.?\d*/g;
const LARGE_NUMBER_RE = /[\d,]{4,}\./g; // 1,234. or 14,331,414.
const PERCENTAGE_RE = /\d+\.?\d*\s*%/g;

// Date patterns
const DATE_SLASH_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
const DATE_ISO_RE = /\d{4}-\d{2}-\d{2}/g;

// PII patterns
const SSN_RE = /\d{3}-\d{2}-\d{4}/g;
const EIN_RE = /\d{2}-\d{7}/g;
const PTIN_RE = /P\d{8}/g;
const ACCOUNT_NUM_RE = /(?:account|acct|routing)\s*(?:#|number|no\.?)?\s*:?\s*\d{6,}/gi;

// Signature detection
const SIGNATURE_RE = /(?:signature|sign\s+here|signed|under penalties of perjury)/i;

// Entity detection: ALL CAPS multi-word (2+ words, 3+ chars each)
const ALLCAPS_ENTITY_RE = /\b([A-Z][A-Z\s&.,'-]{5,}[A-Z])\b/g;

// Tax year detection
const TAX_YEAR_RE = /(?:tax\s+year|calendar\s+year|for\s+)\s*(\d{4})/i;
const STANDALONE_YEAR_RE = /\b(20[12]\d)\b/;

// EIN in context: "Employer identification number\nXX-XXXXXXX" or "EIN: XX-XXXXXXX"
const EIN_CONTEXT_RE = /(?:Employer\s+identification\s+number|EIN)[:\s]*\n?\s*(\d{2}-\d{7})/i;

// Entity name in context: "Name\nENTITY NAME" or near "Corporation" header
const ENTITY_NAME_RE = /(?:^|\|)\s*Name\s*\n\s*([A-Z][A-Z\s&.,'-]+[A-Z])\b/m;

// Preparer name
const PREPARER_RE = /(?:preparer'?s?\s+name|Print\/Type preparer)\s*\n?\s*([A-Z][A-Za-z\s.]+)/i;

// K-1 shareholder name pattern
const K1_SHAREHOLDER_RE = /F1\s+Shareholder'?s?\s+name.*?\n\s*([A-Z][A-Z\s.,'-]+)/gi;

// ─────────────────────────────────────────────
// Pipe-Table Block Detection
// ─────────────────────────────────────────────
// Counts distinct table BLOCKS, not individual pipe-lines.
// A table block = consecutive lines containing |, with at least one separator row
// or at least 3 consecutive pipe lines.

function countTableBlocks(markdown: string): number {
  const lines = markdown.split("\n");
  let tableCount = 0;
  let consecutivePipeLines = 0;
  let hasSeparator = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (PIPE_LINE_RE.test(trimmed)) {
      consecutivePipeLines++;
      if (SEPARATOR_RE.test(trimmed)) {
        hasSeparator = true;
      }
    } else {
      // End of a potential table block
      if (consecutivePipeLines >= 3 || (consecutivePipeLines >= 2 && hasSeparator)) {
        tableCount++;
      }
      consecutivePipeLines = 0;
      hasSeparator = false;
    }
  }

  // Handle table at end of page
  if (consecutivePipeLines >= 3 || (consecutivePipeLines >= 2 && hasSeparator)) {
    tableCount++;
  }

  return tableCount;
}

// ─────────────────────────────────────────────
// Checkbox Counting
// ─────────────────────────────────────────────

function countCheckboxes(markdown: string): number {
  const checked = (markdown.match(CHECKBOX_CHECKED_RE) || []).length;
  const unchecked = (markdown.match(CHECKBOX_UNCHECKED_RE) || []).length;
  return checked + unchecked;
}

// ─────────────────────────────────────────────
// Financial Data Detection
// ─────────────────────────────────────────────

function hasFinancialData(markdown: string): boolean {
  // Dollar amounts
  if (DOLLAR_RE.test(markdown)) return true;
  // Reset lastIndex (global regex)
  DOLLAR_RE.lastIndex = 0;

  // Large numbers with decimal (financial formatting: "14,331,414.")
  LARGE_NUMBER_RE.lastIndex = 0;
  const numbers = markdown.match(LARGE_NUMBER_RE);
  if (numbers && numbers.length >= 2) return true;

  return false;
}

// ─────────────────────────────────────────────
// PII Detection
// ─────────────────────────────────────────────

function hasPII(markdown: string): boolean {
  // Reset global regexes
  SSN_RE.lastIndex = 0;
  EIN_RE.lastIndex = 0;
  PTIN_RE.lastIndex = 0;
  ACCOUNT_NUM_RE.lastIndex = 0;

  // SSN pattern (strongest PII signal)
  if (SSN_RE.test(markdown)) return true;
  SSN_RE.lastIndex = 0;

  // PTIN (preparer tax identification number)
  if (PTIN_RE.test(markdown)) return true;
  PTIN_RE.lastIndex = 0;

  // Account numbers
  if (ACCOUNT_NUM_RE.test(markdown)) return true;
  ACCOUNT_NUM_RE.lastIndex = 0;

  // EIN in PII-sensitive contexts:
  const hasEIN = EIN_RE.test(markdown);
  EIN_RE.lastIndex = 0;
  if (!hasEIN) return false;

  // EIN + shareholder/officer personal info = PII page
  if (/Compensation of Officers/i.test(markdown)) return true;
  if (/Social\s+security|identif\w+\s+number/i.test(markdown)) return true;
  if (/Shareholder'?s?\s+(?:name|identifying)/i.test(markdown)) return true;
  if (/EMPLOYER\s+IDENTIFICATION\s+NUMBER/i.test(markdown)) return true;

  return false;
}

// ─────────────────────────────────────────────
// Content Type Classification (per page)
// ─────────────────────────────────────────────
// Heuristic classification based on content patterns.
// This gives Step 2 a hint but isn't the final classification.

function detectContentType(markdown: string): string {
  const md = markdown.substring(0, 3000); // First 3K chars for speed

  // Blank page
  if (markdown.replace(/\s/g, "").length < 50) return "blank";

  // K-1 schedule (check before generic tax_form)
  if (/Schedule\s+K[\s-]1\s+\(Form/i.test(md)) return "k1_schedule";

  // List of Codes reference pages
  if (/List of Codes/i.test(md) && /Box\s+\d+\./i.test(md)) return "code_reference";

  // Depreciation report
  if (/DEPRECIATION AND AMORTIZATION REPORT/i.test(md)) return "depreciation_report";

  // AMT depreciation
  if (/ALTERNATIVE MINIMUM TAX DEPRECIATION/i.test(md)) return "depreciation_report";

  // Tax forms (IRS)
  if (/Form\s+(?:1120|1040|1065|1125|4562|8821|4506)\b/i.test(md)) return "tax_form";

  // SBA forms
  if (/SBA\s+Form|Form\s+(?:1919|413|912)\b/i.test(md)) return "sba_form";

  // Schedule/Statement attachment pages (check before table density fallback)
  if (/STATEMENT\s+\d/i.test(md) && /TOTAL\s+TO\s+(?:FORM|SCHEDULE)/i.test(md)) {
    return "schedule_attachment";
  }
  if (/^[A-Z\s&.,'-]+\n\d{2}-\d{7}/m.test(md) && /STATEMENT\s+\d/i.test(md)) {
    return "schedule_attachment";
  }

  // QBI section
  if (/Qualified Business Income|Section 199A/i.test(md)) return "tax_form";

  // Election statements
  if (/ELECTION|DE MINIMIS SAFE HARBOR/i.test(md)) return "legal_document";

  // Signature/cover pages
  if (/SHAREHOLDERS['']?\s+COPY/i.test(md)) return "cover_page";

  // If mostly tables with financial data
  const tableCount = countTableBlocks(md);
  const lineCount = md.split("\n").length;
  const pipeLineCount = md.split("\n").filter((l) => PIPE_LINE_RE.test(l.trim())).length;

  if (tableCount > 0 && pipeLineCount / lineCount > 0.5) {
    if (hasFinancialData(md)) return "financial_statement";
    return "financial_statement";
  }

  // Narrative/prose
  if (tableCount === 0 && md.length > 200) return "narrative";

  return "other";
}

// ─────────────────────────────────────────────
// Section Label Detection (per page)
// ─────────────────────────────────────────────

function detectSectionLabel(markdown: string, pageNumber: number): string | null {
  const md = markdown.substring(0, 2000);

  for (const { label, pattern } of SECTION_PATTERNS) {
    if (pattern.test(md)) {
      // For K-1s, try to detect shareholder number
      if (label === "Schedule K-1") {
        const shNum = detectShareholderNumber(md);
        return shNum ? `Schedule K-1 Shareholder ${shNum}` : "Schedule K-1";
      }

      // For Form 1120-S, detect page number
      if (label === "Form 1120-S Page 1") {
        const pageMatch = md.match(/Page\s+(\d)/);
        if (pageMatch) return `Form 1120-S Page ${pageMatch[1]}`;
        return label;
      }

      // For depreciation reports, detect variant
      if (label === "Depreciation and Amortization Report") {
        if (/CURRENT YEAR BOOK/i.test(md)) return "Depreciation Report - Current Year Book";
        if (/NEXT YEAR BOOK/i.test(md)) return "Depreciation Report - Next Year Book";
        if (/BOOK\s+Depreciation/i.test(md)) return "Form 4562 Book Depreciation";
        if (/OTHER DEPRECIATION/i.test(md)) return "Depreciation and Amortization Report";
        return label;
      }

      // For statement pages, detect which statements
      if (label === "Statements") {
        const stmtNums = [...md.matchAll(/STATEMENT\s+(\d+)/gi)]
          .map((m) => m[1])
          .filter((v, i, a) => a.indexOf(v) === i);
        if (stmtNums.length > 0) {
          return `Statements ${stmtNums[0]}-${stmtNums[stmtNums.length - 1]}`;
        }
      }

      return label;
    }
  }

  // Fallback: detect K-1 attachment pages (follow a K-1 page)
  if (/SCHEDULE K-1\s+(?:NONDEDUCTIBLE|SECTION 199A|GROSS RECEIPTS|EXCESS BUSINESS)/i.test(md)) {
    const shNum = detectShareholderFromFooter(md);
    return shNum
      ? `Schedule K-1 Shareholder ${shNum} Attachments`
      : "Schedule K-1 Attachments";
  }

  // Form 1120-S continuation pages
  if (/Form\s+1120[\s-]?S\s*\(\d{4}\).*Page\s+(\d)/i.test(md)) {
    const m = md.match(/Page\s+(\d)/);
    if (m) return `Form 1120-S Page ${m[1]}`;
  }

  return null;
}

function detectShareholderNumber(markdown: string): string | null {
  // Look for allocation percentage to determine shareholder order
  // Or look for shareholder name and match against running count
  // Simpler: look for footer pattern "SHAREHOLDER N" or page number hints
  const footer = detectShareholderFromFooter(markdown);
  if (footer) return footer;

  // Try allocation percentage as identifier
  const allocMatch = markdown.match(/allocation percentage\s+([\d.]+)%/i);
  if (allocMatch) return null; // Can't determine number from percentage alone

  return null;
}

function detectShareholderFromFooter(markdown: string): string | null {
  const match = markdown.match(/SHAREHOLDER\s+(\d+)/i);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────
// Document-Level Detection
// ─────────────────────────────────────────────

function detectKnownForm(text: string): { id: string | null; name: string | null } {
  // Check first 10K chars for speed
  const sample = text.substring(0, 10000);

  for (const form of KNOWN_FORMS) {
    for (const pattern of form.patterns) {
      if (pattern.test(sample)) {
        return { id: form.id, name: form.name };
      }
    }
  }

  return { id: null, name: null };
}

function detectStructuralType(pages: ProcessedPage[]): string {
  if (pages.length === 0) return "other";

  const totalTables = pages.reduce((n, p) => n + p.page_metadata.table_count, 0);
  const totalCheckboxes = pages.reduce((n, p) => n + p.page_metadata.checkbox_count, 0);
  const financialPages = pages.filter((p) => p.page_metadata.has_financial_data).length;
  const hasSheets = pages.some((p) => p.sheet_name !== null);

  // Content type distribution
  const types = pages.map((p) => p.page_metadata.content_type);
  const taxFormPages = types.filter((t) => t === "tax_form" || t === "k1_schedule").length;
  const depreciationPages = types.filter((t) => t === "depreciation_report").length;
  const codeRefPages = types.filter((t) => t === "code_reference").length;
  const narrativePages = types.filter((t) => t === "narrative").length;
  const financialStmtPages = types.filter((t) => t === "financial_statement").length;

  if (hasSheets) return "spreadsheet";
  if (taxFormPages + depreciationPages > pages.length * 0.3) return "tax_document";
  if (totalCheckboxes > 10 && totalTables > 3) return "fillable_form";
  if (financialStmtPages + financialPages > pages.length * 0.5) return "financial_table";
  if (narrativePages > pages.length * 0.5) return "narrative";

  // Mixed content (common for full tax returns with K-1s + depreciation + statements)
  const uniqueTypes = new Set(types.filter((t) => t !== "other" && t !== "blank"));
  if (uniqueTypes.size >= 3) return "tax_document"; // Tax returns are mixed by nature

  return "mixed";
}

function detectFinancialSignals(fullText: string): FinancialSignals {
  // Use first 20K chars for speed
  const text = fullText.substring(0, 20000);

  // Reset global regexes
  DOLLAR_RE.lastIndex = 0;
  PERCENTAGE_RE.lastIndex = 0;
  DATE_SLASH_RE.lastIndex = 0;
  DATE_ISO_RE.lastIndex = 0;
  EIN_RE.lastIndex = 0;
  SSN_RE.lastIndex = 0;
  SIGNATURE_RE.lastIndex = 0;

  const hasCurrency = DOLLAR_RE.test(text) || LARGE_NUMBER_RE.test(text);
  DOLLAR_RE.lastIndex = 0;
  LARGE_NUMBER_RE.lastIndex = 0;

  const hasPercentages = PERCENTAGE_RE.test(text);
  PERCENTAGE_RE.lastIndex = 0;

  const hasDates = DATE_SLASH_RE.test(text) || DATE_ISO_RE.test(text);
  DATE_SLASH_RE.lastIndex = 0;
  DATE_ISO_RE.lastIndex = 0;

  const hasAccountNumbers = ACCOUNT_NUM_RE.test(text);
  ACCOUNT_NUM_RE.lastIndex = 0;

  const hasTaxIds = EIN_RE.test(text) || SSN_RE.test(text);
  EIN_RE.lastIndex = 0;
  SSN_RE.lastIndex = 0;

  const hasSignatures = SIGNATURE_RE.test(text);

  // Try to extract key financial figures from page 1 (for tax returns)
  const page1 = fullText.substring(0, 8000);

  // Gross receipts/revenue: line 1c on Form 1120-S
  let grossRevenue: string | null = null;
  const revenueMatch = page1.match(
    /(?:Gross receipts|1c|Total income).*?([\d,]{4,})\.?\s*$/m
  );
  if (revenueMatch) grossRevenue = revenueMatch[1];

  // Total assets: Schedule L or Form header
  let totalAssets: string | null = null;
  const assetMatch = page1.match(
    /(?:Total assets|total\s+assets).*?\$?\s*([\d,]{4,})\.?\s*$/m
  );
  if (assetMatch) totalAssets = assetMatch[1];

  // Ordinary income: line 22 on Form 1120-S
  let ordinaryIncome: string | null = null;
  const incomeMatch = page1.match(
    /(?:Ordinary business income|line 22).*?([\d,]{3,})\.?\s*$/m
  );
  if (incomeMatch) ordinaryIncome = incomeMatch[1];

  return {
    has_currency: hasCurrency,
    has_percentages: hasPercentages,
    has_dates: hasDates,
    has_account_numbers: hasAccountNumbers,
    has_tax_ids: hasTaxIds,
    has_signatures: hasSignatures,
    gross_revenue: grossRevenue,
    total_assets: totalAssets,
    ordinary_income: ordinaryIncome,
  };
}

function extractDocumentInfo(fullText: string): {
  entity_name: string | null;
  entity_ein: string | null;
  tax_year: string | null;
  preparer_name: string | null;
} {
  // Focus on first 5K chars (page 1 of most forms)
  const text = fullText.substring(0, 5000);

  // Entity name: look for "Name\nENTITY" pattern in form header tables
  let entityName: string | null = null;
  const nameMatch = text.match(ENTITY_NAME_RE);
  if (nameMatch) {
    entityName = nameMatch[1].trim();
  } else {
    // Fallback: first ALL-CAPS multi-word string that looks like a company
    const capsMatches = [...text.matchAll(ALLCAPS_ENTITY_RE)];
    for (const m of capsMatches) {
      const candidate = m[1].trim();
      // Filter out form labels, IRS boilerplate
      if (
        candidate.length >= 8 &&
        !/^(FORM|SCHEDULE|DEPARTMENT|INTERNAL|INCOME TAX|RETURN|DEDUCTIONS|CREDITS|INSTRUCTIONS)/.test(candidate) &&
        !/^(INCOME|TAX AND|PAID|SIGN|OTHER|ATTACH|CHECK|ENTER)/.test(candidate) &&
        /(?:CORP|LLC|INC|LTD|LP|PARTNERS|GROUP|COMPANY|ENTERPRISE|TRUST)/.test(candidate)
      ) {
        entityName = candidate;
        break;
      }
    }
  }

  // EIN: "Employer identification number" context
  let entityEIN: string | null = null;
  const einMatch = text.match(EIN_CONTEXT_RE);
  if (einMatch) {
    entityEIN = einMatch[1];
  } else {
    // Fallback: first EIN-format number (XX-XXXXXXX) that's not an SSN
    EIN_RE.lastIndex = 0;
    const allEINs = [...text.matchAll(/\b(\d{2}-\d{7})\b/g)];
    if (allEINs.length > 0) entityEIN = allEINs[0][1];
  }

  // Tax year
  let taxYear: string | null = null;
  const yearMatch = text.match(TAX_YEAR_RE);
  if (yearMatch) {
    taxYear = yearMatch[1];
  } else {
    // Look for standalone 4-digit year in first 500 chars
    const early = text.substring(0, 500);
    const standaloneMatch = early.match(STANDALONE_YEAR_RE);
    if (standaloneMatch) taxYear = standaloneMatch[1];
  }

  // Preparer name
  let preparerName: string | null = null;
  const preparerMatch = fullText.substring(0, 8000).match(PREPARER_RE);
  if (preparerMatch) {
    preparerName = preparerMatch[1].trim();
  }

  return { entity_name: entityName, entity_ein: entityEIN, tax_year: taxYear, preparer_name: preparerName };
}

function countK1sAndShareholders(pages: ProcessedPage[]): {
  contains_k1s: boolean;
  k1_count: number;
  shareholder_count: number;
  shareholder_names: string[];
} {
  let k1Count = 0;
  const shareholderNames: string[] = [];

  for (const page of pages) {
    // Only count actual K-1 form pages, not attachments or code reference pages
    if (
      page.page_metadata.content_type === "k1_schedule" &&
      /Schedule\s+K[\s-]1\s+\(Form/i.test(page.markdown.substring(0, 500))
    ) {
      k1Count++;

      // Extract shareholder name from Part II
      K1_SHAREHOLDER_RE.lastIndex = 0;
      const nameMatches = [...page.markdown.matchAll(K1_SHAREHOLDER_RE)];
      for (const m of nameMatches) {
        const name = m[1].trim();
        if (name.length > 3 && !shareholderNames.includes(name)) {
          shareholderNames.push(name);
        }
      }
    }
  }

  return {
    contains_k1s: k1Count > 0,
    k1_count: k1Count,
    shareholder_count: shareholderNames.length || k1Count, // Fallback to K-1 count
    shareholder_names: shareholderNames,
  };
}

// ─────────────────────────────────────────────
// Sheet Name Detection (for XLSX files)
// ─────────────────────────────────────────────

function detectSheetNames(pages: RawPage[]): Map<number, string> {
  const sheetMap = new Map<number, string>();
  let currentSheet: string | null = null;

  for (const page of pages) {
    // Mistral marks sheet boundaries with "## Sheet: Name" headers
    const sheetMatch = page.markdown.match(/^#+\s+Sheet:\s*(.+)$/m);
    if (sheetMatch) {
      currentSheet = sheetMatch[1].trim();
    }

    // Also check for "**Sheet: Name**" pattern
    if (!currentSheet) {
      const boldSheet = page.markdown.match(/\*\*Sheet:\s*(.+?)\*\*/);
      if (boldSheet) {
        currentSheet = boldSheet[1].trim();
      }
    }

    if (currentSheet) {
      sheetMap.set(page.pageNumber, currentSheet);
    }
  }

  return sheetMap;
}

// ─────────────────────────────────────────────
// MAIN: Post-Process Document
// ─────────────────────────────────────────────

export function postProcessDocument(pages: RawPage[]): PostProcessResult {
  const start = Date.now();

  // Detect sheet names for XLSX files
  const sheetMap = detectSheetNames(pages);

  // Process each page
  const processedPages: ProcessedPage[] = pages.map((rawPage) => {
    const md = rawPage.markdown;
    const lines = md.split("\n");
    const tableCount = countTableBlocks(md);
    const checkboxCount = countCheckboxes(md);
    const financialData = hasFinancialData(md);
    const pii = hasPII(md);
    const contentType = detectContentType(md);
    const sectionLabel = detectSectionLabel(md, rawPage.pageNumber);

    return {
      page_number: rawPage.pageNumber,
      sheet_name: sheetMap.get(rawPage.pageNumber) || null,
      markdown: md, // Raw OCR markdown — NEVER modified
      images: rawPage.images,
      page_metadata: {
        char_count: md.length,
        line_count: lines.length,
        is_blank: md.replace(/\s/g, "").length < 50,
        has_tables: tableCount > 0,
        table_count: tableCount,
        has_checkboxes: checkboxCount > 0,
        checkbox_count: checkboxCount,
        has_financial_data: financialData,
        has_pii: pii,
        has_images: rawPage.images.length > 0,
        estimated_tokens: Math.ceil(md.length / 4),
        content_type: contentType,
        section_label: sectionLabel,
      },
    };
  });

  // Build full text
  const fullText = processedPages
    .map((p) => `\n--- PAGE ${p.page_number} ---\n${p.markdown}`)
    .join("\n");

  // Document-level detection
  const form = detectKnownForm(fullText);
  const structuralType = detectStructuralType(processedPages);
  const financialSignals = detectFinancialSignals(fullText);
  const docInfo = extractDocumentInfo(fullText);
  const k1Info = countK1sAndShareholders(processedPages);

  // Collect unique sheet names
  const sheetNames = [
    ...new Set(processedPages.map((p) => p.sheet_name).filter(Boolean) as string[]),
  ];

  // Collect unique section labels
  const uniqueSections = [
    ...new Set(
      processedPages
        .map((p) => p.page_metadata.section_label)
        .filter(Boolean) as string[]
    ),
  ];

  // Summary stats
  const totalChars = processedPages.reduce((n, p) => n + p.page_metadata.char_count, 0);

  const summary: DocumentSummary = {
    total_pages: processedPages.length,
    total_tables: processedPages.reduce((n, p) => n + p.page_metadata.table_count, 0),
    total_checkboxes: processedPages.reduce(
      (n, p) => n + p.page_metadata.checkbox_count,
      0
    ),
    total_images: processedPages.reduce((n, p) => n + p.images.length, 0),
    total_chars: totalChars,
    estimated_tokens: Math.ceil(totalChars / 4),
    pages_with_pii: processedPages.filter((p) => p.page_metadata.has_pii).length,
    pages_with_financial_data: processedPages.filter(
      (p) => p.page_metadata.has_financial_data
    ).length,
    unique_sections: uniqueSections,
  };

  // Classification hints (for Step 2)
  const classificationHints: ClassificationHints = {
    preview_text: fullText.substring(0, 2000),
    structural_type: structuralType,
    detected_form_id: form.id,
    detected_form_name: form.name,
    tax_year: docInfo.tax_year,
    entity_name: docInfo.entity_name,
    entity_ein: docInfo.entity_ein,
    preparer_name: docInfo.preparer_name,
    contains_k1s: k1Info.contains_k1s,
    k1_count: k1Info.k1_count,
    shareholder_count: k1Info.shareholder_count,
    sheet_names: sheetNames,
    financial_signals: financialSignals,
  };

  return {
    pages: processedPages,
    full_text: fullText,
    summary,
    classification_hints: classificationHints,
    postprocess_duration_ms: Date.now() - start,
  };
}