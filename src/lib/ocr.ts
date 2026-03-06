import { Mistral } from "@mistralai/mistralai";

// ─────────────────────────────────────────────
// OCR ONLY — pure perception, no reasoning
// ─────────────────────────────────────────────
// The Mistral OCR endpoint supports:
//   - model, document, includeImageBase64, bboxAnnotationFormat
// It does NOT support documentAnnotationFormat or documentAnnotationPrompt.
// All structured extraction happens in extraction.ts via chat completion.

export interface OCRConfig {
  model: string;
  includeImageBase64: boolean;
  bboxSchema?: Record<string, any>;
}

export interface RawPage {
  pageNumber: number;
  markdown: string;
  images: any[];
}

export interface OCRResult {
  pages: RawPage[];
  ocrDurationMs: number;
}

export async function runMistralOCR(
  fileUrl: string,
  config: OCRConfig,
  client?: Mistral,
): Promise<OCRResult> {
  const mistral =
    client ??
    new Mistral({
      apiKey: process.env.MISTRAL_API_KEY!,
      ...(process.env.MISTRAL_BASE_URL
        ? { serverURL: process.env.MISTRAL_BASE_URL }
        : {}),
    });

  const startMs = Date.now();

  const ocrRequest: any = {
    model: config.model,
    document: { type: "document_url", documentUrl: fileUrl },
    includeImageBase64: config.includeImageBase64,
  };

  // bboxAnnotationFormat: tells Mistral how to structure image annotations
  if (config.bboxSchema) {
    ocrRequest.bboxAnnotationFormat = {
      type: "json_schema",
      jsonSchema: {
        name: "ImageAnnotation",
        schemaDefinition: config.bboxSchema,
      },
    };
  }

  let response: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await mistral.ocr.process(ocrRequest);
      break;
    } catch (err: any) {
      const isRetryable =
        err.statusCode === 429 ||
        err.statusCode === 500 ||
        err.statusCode === 503 ||
        err.message?.includes("timeout");

      if (!isRetryable || attempt === 2) throw err;

      const backoffMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!response) throw new Error("OCR call failed after 3 attempts");

  const pages: RawPage[] = (response.pages || []).map((p: any, i: number) => ({
    pageNumber: i + 1,
    markdown: p.markdown || "",
    images: (p.images || [])
      .map((img: any) => {
        try {
          return JSON.parse(img.imageAnnotation || "{}");
        } catch {
          return { raw: img.imageAnnotation };
        }
      })
      .filter(Boolean),
  }));

  return { pages, ocrDurationMs: Date.now() - startMs };
}