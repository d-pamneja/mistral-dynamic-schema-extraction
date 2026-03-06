import { z } from "zod";

// ─────────────────────────────────────────────
// Image Annotation (sent to Mistral OCR via bboxAnnotationFormat)
// ─────────────────────────────────────────────

export const ImageAnnotationSchema = z.object({
  id: z.string(),
  type: z.enum([
    "signature", "stamp", "logo", "photo", "chart", "graph",
    "table_image", "map", "diagram", "barcode", "qr_code",
    "check_image", "id_document", "letterhead", "seal",
    "handwriting", "other",
  ]),
  context: z.string(),
  topLeft: z.tuple([z.number(), z.number()]),
  bottomRight: z.tuple([z.number(), z.number()]),
});

// ─────────────────────────────────────────────
// Page Schema (Step 1 output — code-produced metadata)
// ─────────────────────────────────────────────

export const PageMetadataSchema = z.object({
  // Code-computed (always accurate)
  char_count: z.number(),
  line_count: z.number(),
  is_blank: z.boolean(),
  has_images: z.boolean(),
  estimated_tokens: z.number(),

  // Code-detected (regex/heuristic — reliable for structured docs)
  has_tables: z.boolean(),
  table_count: z.number(),
  has_checkboxes: z.boolean(),
  checkbox_count: z.number(),
  has_financial_data: z.boolean(),
  has_pii: z.boolean(),
  content_type: z.string(),
  section_label: z.string().nullable(),
});

export const OCRPageSchema = z.object({
  page_number: z.number(),
  sheet_name: z.string().nullable(),
  markdown: z.string(), // Raw OCR markdown — AUTHORITATIVE, never modified
  images: z.array(z.any()),
  page_metadata: PageMetadataSchema,
});

// ─────────────────────────────────────────────
// Financial Signals
// ─────────────────────────────────────────────

export const FinancialSignalsSchema = z.object({
  has_currency: z.boolean(),
  has_percentages: z.boolean(),
  has_dates: z.boolean(),
  has_account_numbers: z.boolean(),
  has_tax_ids: z.boolean(),
  has_signatures: z.boolean(),
  // Key figures extracted from page 1 (tax returns)
  gross_revenue: z.string().nullable(),
  total_assets: z.string().nullable(),
  ordinary_income: z.string().nullable(),
});

// ─────────────────────────────────────────────
// Classification Hints (what Step 2 receives)
// ─────────────────────────────────────────────

export const ClassificationHintsSchema = z.object({
  preview_text: z.string(),
  structural_type: z.string(),
  detected_form_id: z.string().nullable(),
  detected_form_name: z.string().nullable(),
  tax_year: z.string().nullable(),
  entity_name: z.string().nullable(),
  entity_ein: z.string().nullable(),
  preparer_name: z.string().nullable(),
  contains_k1s: z.boolean(),
  k1_count: z.number(),
  shareholder_count: z.number(),
  sheet_names: z.array(z.string()),
  financial_signals: FinancialSignalsSchema,
});

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────

export const SummarySchema = z.object({
  total_pages: z.number(),
  total_tables: z.number(),
  total_checkboxes: z.number(),
  total_images: z.number(),
  total_chars: z.number(),
  estimated_tokens: z.number(),
  pages_with_pii: z.number(),
  pages_with_financial_data: z.number(),
  unique_sections: z.array(z.string()),
});

// ─────────────────────────────────────────────
// File Info & Processing
// ─────────────────────────────────────────────

export const FileInfoSchema = z.object({
  file_name: z.string(),
  mime_type: z.string(),
  file_url: z.string(),
  source_path: z.string(),
  content_hash: z.string().nullable(),
  loan_package_id: z.string().nullable(),
  metadata: z.record(z.any()).nullable(),
});

export const ProcessingMetadataSchema = z.object({
  ocr_model: z.string(),
  ocr_duration_ms: z.number(),
  postprocess_duration_ms: z.number(),
  total_duration_ms: z.number(),
  processed_at: z.string(),
  ocr_pages_processed: z.number(),
});

// ─────────────────────────────────────────────
// Full OCR Document (THE API response)
// ─────────────────────────────────────────────

export const OCRDocumentSchema = z.object({
  file_info: FileInfoSchema,
  processing: ProcessingMetadataSchema,
  summary: SummarySchema,
  classification_hints: ClassificationHintsSchema,
  pages: z.array(OCRPageSchema),
  full_text: z.string(),
});

// ─── Inferred Types ───

export type ImageAnnotation = z.infer<typeof ImageAnnotationSchema>;
export type PageMetadata = z.infer<typeof PageMetadataSchema>;
export type OCRPage = z.infer<typeof OCRPageSchema>;
export type FinancialSignals = z.infer<typeof FinancialSignalsSchema>;
export type ClassificationHints = z.infer<typeof ClassificationHintsSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type FileInfo = z.infer<typeof FileInfoSchema>;
export type ProcessingMetadata = z.infer<typeof ProcessingMetadataSchema>;
export type OCRDocument = z.infer<typeof OCRDocumentSchema>;