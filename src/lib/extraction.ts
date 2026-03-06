import { Mistral } from "@mistralai/mistralai";
import { responseFormatFromZodObject } from "@mistralai/mistralai/extra/structChat";
import { z } from "zod";
import type { RawPage } from "./ocr";

// ─────────────────────────────────────────────
// EXTRACTION — LLM reasoning on OCR markdown
// ─────────────────────────────────────────────
// After Mistral OCR produces raw markdown, this module
// sends it to Mistral Large via chat completion with
// Zod structured output to get:
//   - Classification hints (structural_type, form detection, signals)
//   - Per-page metadata (what's on each page)
//   - Summary statistics
//
// This is a SEPARATE call from OCR because:
//   1. OCR = vision model (perception), extraction = language model (reasoning)
//   2. Structured output via chat completion is proven & reliable
//   3. The OCR endpoint doesn't support documentAnnotationFormat

// ─── Schema for what we ask Mistral to extract ───

const PageAnnotationSchema = z.object({
  page_number: z.number().describe("1-indexed page number"),
  sheet_name: z.string().nullable().describe("Excel sheet name if XLSX, null otherwise"),
  content_type: z
    .enum([
      "tax_form",
      "financial_statement",
      "sba_form",
      "legal_document",
      "correspondence",
      "schedule_attachment",
      "depreciation_report",
      "k1_schedule",
      "code_reference",
      "cover_page",
      "signature_page",
      "blank",
      "other",
    ])
    .describe("Primary content type of this page"),
  has_tables: z.boolean().describe("Page contains pipe-delimited tables"),
  table_count: z.number().describe("Number of distinct tables on this page"),
  has_form_fields: z
    .boolean()
    .describe("Page contains labeled form fields (Label: Value patterns)"),
  form_field_count: z
    .number()
    .describe("Approximate number of form field label:value pairs"),
  has_checkboxes: z
    .boolean()
    .describe("Page contains checkboxes (☑/☐, [X]/[ ], Yes/No selections)"),
  checkbox_count: z.number().describe("Number of checkboxes on this page"),
  has_financial_data: z
    .boolean()
    .describe("Page contains dollar amounts, percentages, or financial line items"),
  has_pii: z
    .boolean()
    .describe(
      "Page contains PII (SSN, EIN, account numbers, addresses, DOB)"
    ),
  key_entities: z
    .array(z.string())
    .describe(
      "Names of people, businesses, or agencies mentioned on this page (max 5)"
    ),
  section_label: z
    .string()
    .nullable()
    .describe(
      "IRS form section/schedule name if identifiable (e.g., 'Schedule K', 'Form 1125-A', 'Schedule K-1 Shareholder 3')"
    ),
});

const DocumentAnnotationSchema = z.object({
  // ── Document-level classification ──
  classification: z.object({
    structural_type: z
      .enum([
        "fillable_form",
        "financial_table",
        "tax_document",
        "narrative",
        "spreadsheet",
        "legal_document",
        "identity_document",
        "mixed",
        "other",
      ])
      .describe("High-level structural classification of the document"),
    detected_form_id: z
      .string()
      .nullable()
      .describe(
        "IRS/SBA form number if detected (e.g., '1120S', '1040', '413', '1919', 'K-1', '8821'). Null if not a standard form."
      ),
    detected_form_name: z
      .string()
      .nullable()
      .describe(
        "Human-readable form name (e.g., 'U.S. Income Tax Return for an S Corporation'). Null if not a standard form."
      ),
    tax_year: z
      .string()
      .nullable()
      .describe("Tax year if this is a tax document (e.g., '2024')"),
    entity_name: z
      .string()
      .nullable()
      .describe("Primary business/person name on the document"),
    entity_ein: z
      .string()
      .nullable()
      .describe("EIN/TIN if visible (e.g., '59-2051580')"),
    preparer_name: z.string().nullable().describe("Tax preparer/CPA name if visible"),
    contains_k1s: z
      .boolean()
      .describe("Document contains Schedule K-1 forms for shareholders/partners"),
    k1_count: z.number().describe("Number of K-1 schedules found (0 if none)"),
    shareholder_count: z
      .number()
      .describe("Number of unique shareholders/partners identified (0 if N/A)"),
  }),

  // ── Financial signals ──
  financial_signals: z.object({
    has_currency: z.boolean().describe("Document contains dollar amounts ($)"),
    has_percentages: z.boolean().describe("Document contains percentage values (%)"),
    has_dates: z.boolean().describe("Document contains date values"),
    has_account_numbers: z.boolean().describe("Document contains bank account/routing numbers"),
    has_tax_ids: z.boolean().describe("Document contains SSN, EIN, or PTIN"),
    has_signatures: z.boolean().describe("Document contains signature blocks or signed areas"),
    gross_revenue: z
      .string()
      .nullable()
      .describe("Gross receipts/revenue if visible on first page (as string, e.g., '14,331,414')"),
    total_assets: z
      .string()
      .nullable()
      .describe("Total assets if visible (as string)"),
    ordinary_income: z
      .string()
      .nullable()
      .describe("Ordinary business income/loss if visible (as string)"),
  }),

  // ── Per-page annotations ──
  pages: z.array(PageAnnotationSchema).describe("One entry per page in the document"),

  // ── Summary ──
  summary: z.object({
    total_pages: z.number(),
    total_tables: z.number().describe("Sum of table_count across all pages"),
    total_form_fields: z.number().describe("Sum of form_field_count across all pages"),
    total_checkboxes: z.number().describe("Sum of checkbox_count across all pages"),
    pages_with_pii: z.number().describe("Number of pages containing PII"),
    pages_with_financial_data: z
      .number()
      .describe("Number of pages containing financial data"),
    unique_sections: z
      .array(z.string())
      .describe(
        "List of unique section_labels found across pages (deduplicated, e.g., ['Form 1120-S Page 1', 'Schedule K', 'Form 1125-A', 'Schedule K-1 Shareholder 1'])"
      ),
  }),
});

export type DocumentAnnotation = z.infer<typeof DocumentAnnotationSchema>;
export type PageAnnotation = z.infer<typeof PageAnnotationSchema>;

// ─── Extraction Prompt ───

function buildExtractionPrompt(pages: RawPage[]): string {
  // Build page-separated content with clear markers
  const pageContent = pages
    .map(
      (p) =>
        `\n========== PAGE ${p.pageNumber} of ${pages.length} ==========\n${p.markdown}`
    )
    .join("\n");

  return `You are a document analyst. Analyze the following OCR-extracted markdown and produce structured annotations.

RULES:
1. For each page, identify what content it contains (tables, forms, checkboxes, financial data, PII).
2. Detect the document type — if it's an IRS/SBA form, identify the specific form number.
3. Count accurately: count actual pipe-tables (| delimited), actual form fields (Label: Value), actual checkboxes (☑/☐/[X]/[ ]).
4. For PII detection: flag pages with SSNs (XXX-XX-XXXX), EINs (XX-XXXXXXX), account numbers, addresses.
5. For K-1 detection: each Schedule K-1 is for a separate shareholder — count them individually.
6. section_label should identify the IRS form section (e.g., "Schedule B", "Schedule K", "Schedule L", "Form 1125-A", "Schedule K-1 Shareholder 2", "Depreciation Report").
7. Boilerplate "List of Codes" reference pages that repeat for each K-1 should have content_type "code_reference".
8. key_entities: extract names of people, businesses, agencies. Max 5 per page.

DOCUMENT CONTENT (${pages.length} pages):
${pageContent}`;
}

// ─── Main Extraction Function ───

export async function extractDocumentAnnotation(
  pages: RawPage[],
  options?: {
    model?: string;
    maxInputChars?: number;
    client?: Mistral;
  }
): Promise<{
  annotation: DocumentAnnotation;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const model = options?.model || process.env.EXTRACTION_MODEL || "mistral-large-latest";
  const maxChars = options?.maxInputChars || 200000; // ~50K tokens, safe for 128K context

  const mistral =
    options?.client ??
    new Mistral({
      apiKey: process.env.MISTRAL_API_KEY!,
      ...(process.env.MISTRAL_BASE_URL
        ? { serverURL: process.env.MISTRAL_BASE_URL }
        : {}),
    });

  // For very large documents, truncate page content but keep all page markers
  let truncatedPages = pages;
  const totalChars = pages.reduce((n, p) => n + p.markdown.length, 0);

  if (totalChars > maxChars) {
    // Proportionally truncate each page
    const ratio = maxChars / totalChars;
    truncatedPages = pages.map((p) => ({
      ...p,
      markdown: p.markdown.substring(0, Math.max(200, Math.floor(p.markdown.length * ratio))),
    }));
  }

  const prompt = buildExtractionPrompt(truncatedPages);
  const responseFormat = responseFormatFromZodObject(DocumentAnnotationSchema);

  // Override name for clarity in Mistral dashboard
  if (responseFormat.jsonSchema) {
    responseFormat.jsonSchema.name = "DocumentAnnotation";
  }

  let result: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await mistral.chat.complete({
        model,
        messages: [{ role: "user", content: prompt }],
        responseFormat,
      });
      break;
    } catch (err: any) {
      const isRetryable =
        err.statusCode === 429 ||
        err.statusCode === 500 ||
        err.statusCode === 503;

      if (!isRetryable || attempt === 2) throw err;

      const backoffMs = Math.min(3000 * Math.pow(2, attempt), 20000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!result?.choices?.[0]?.message?.content) {
    throw new Error("Extraction call returned empty response");
  }

  const parsed: DocumentAnnotation = JSON.parse(result.choices[0].message.content);

  // Ensure pages array matches input length (pad if LLM missed some)
  while (parsed.pages.length < pages.length) {
    parsed.pages.push({
      page_number: parsed.pages.length + 1,
      sheet_name: null,
      content_type: "other",
      has_tables: false,
      table_count: 0,
      has_form_fields: false,
      form_field_count: 0,
      has_checkboxes: false,
      checkbox_count: 0,
      has_financial_data: false,
      has_pii: false,
      key_entities: [],
      section_label: null,
    });
  }

  const usage = {
    promptTokens: result.usage?.promptTokens ?? 0,
    completionTokens: result.usage?.completionTokens ?? 0,
    totalTokens: result.usage?.totalTokens ?? 0,
  };

  return { annotation: parsed, usage };
}