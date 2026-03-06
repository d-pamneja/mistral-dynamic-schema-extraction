import { z } from "zod";

export const OCRRequestSchema = z.object({
  // ─── Required ───
  file_url: z.string().url(),
  mime_type: z.string().min(1),

  // ─── OCR config ───
  ocr_config: z
    .object({
      model: z.string().optional(),              // Default: "mistral-ocr-latest"
      include_image_base64: z.boolean().optional(), // Default: false
      bbox_schema: z.record(z.any()).optional(),  // JSON Schema for image annotations
    })
    .optional(),

  // ─── Passthrough metadata (not used by OCR, stored in output) ───
  metadata: z.record(z.any()).optional(),
  file_name: z.string().optional(),
  source_path: z.string().optional(),
  loan_package_id: z.union([z.string(), z.number()]).transform(String).optional(),
  content_hash: z.string().optional(),
});

export type ValidatedOCRRequest = z.infer<typeof OCRRequestSchema>;