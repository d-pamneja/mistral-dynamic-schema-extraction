import { PDFDocument } from "pdf-lib";

// ─────────────────────────────────────────────
// OCR ONLY — pure perception, no reasoning
// ─────────────────────────────────────────────
// Uses Azure-deployed Mistral OCR endpoint.
// Downloads documents, converts to base64 data URIs,
// and caps PDFs at 30 pages (Azure limit).

const MAX_PDF_PAGES = 30;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_MS = 60_000;

const DEFAULT_AZURE_ENDPOINT =
  "https://aman-7900-resource.services.ai.azure.com/providers/mistral/azure/ocr";

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

// ─── Helpers ────────────────────────────────────────

function inferMimeType(
  contentType: string | null,
  url: string,
): { category: "pdf" | "image"; mime: string } {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";

  if (ct === "application/pdf" || ext === "pdf") {
    return { category: "pdf", mime: "application/pdf" };
  }

  const imageMap: Record<string, string> = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/png": "image/png",
    "image/gif": "image/gif",
    "image/webp": "image/webp",
    "image/tiff": "image/tiff",
    "image/bmp": "image/bmp",
  };

  if (imageMap[ct]) return { category: "image", mime: imageMap[ct] };

  const extMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    tiff: "image/tiff",
    tif: "image/tiff",
    bmp: "image/bmp",
  };

  if (extMap[ext]) return { category: "image", mime: extMap[ext] };

  // Default to PDF if unknown
  return { category: "pdf", mime: "application/pdf" };
}

async function downloadAndPrepareDocument(fileUrl: string): Promise<{
  dataUri: string;
  docType: "pdf" | "image";
  originalPageCount: number | null;
  wasTruncated: boolean;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(fileUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Failed to download document: HTTP ${res.status} ${res.statusText}`);
  }

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Document too large: ${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit`,
    );
  }

  const { category, mime } = inferMimeType(
    res.headers.get("content-type"),
    fileUrl,
  );

  let bytes = new Uint8Array(arrayBuf);
  let originalPageCount: number | null = null;
  let wasTruncated = false;

  if (category === "pdf") {
    try {
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      originalPageCount = pdfDoc.getPageCount();

      if (originalPageCount > MAX_PDF_PAGES) {
        console.log(
          `PDF has ${originalPageCount} pages, truncating to ${MAX_PDF_PAGES}`,
        );
        const truncated = await PDFDocument.create();
        const copiedPages = await truncated.copyPages(
          pdfDoc,
          Array.from({ length: MAX_PDF_PAGES }, (_, i) => i),
        );
        for (const page of copiedPages) {
          truncated.addPage(page);
        }
        bytes = new Uint8Array(await truncated.save());
        wasTruncated = true;
      }
    } catch (err: any) {
      throw new Error(`Failed to process PDF: ${err.message}`);
    }
  }

  const base64 = Buffer.from(bytes).toString("base64");
  const dataUri = `data:${mime};base64,${base64}`;

  return { dataUri, docType: category, originalPageCount, wasTruncated };
}

// ─── Main OCR function ──────────────────────────────

export async function runMistralOCR(
  fileUrl: string,
  config: OCRConfig,
): Promise<OCRResult> {
  const azureKey = process.env.AZURE_API_KEY;
  if (!azureKey) {
    throw new Error("AZURE_API_KEY environment variable is not set");
  }
  const endpoint = process.env.AZURE_OCR_ENDPOINT || DEFAULT_AZURE_ENDPOINT;

  const startMs = Date.now();

  // Download and prepare document
  const { dataUri, docType } = await downloadAndPrepareDocument(fileUrl);

  // Build request body
  const requestBody: any = {
    model: config.model,
    document:
      docType === "pdf"
        ? { type: "document_url", document_url: dataUri }
        : { type: "image_url", image_url: dataUri },
    include_image_base64: config.includeImageBase64,
  };

  if (config.bboxSchema) {
    requestBody.bbox_annotation_format = {
      type: "json_schema",
      json_schema: {
        name: "ImageAnnotation",
        schema: config.bboxSchema,
        strict: true,
      },
    };
  }

  // Call Azure endpoint with retry logic
  let response: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${azureKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const body = await res.text();
        const isRetryable =
          res.status === 429 || res.status === 500 || res.status === 503;

        if (!isRetryable || attempt === 2) {
          throw new Error(
            `Azure OCR request failed: HTTP ${res.status} — ${body}`,
          );
        }

        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 15000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      response = await res.json();
      break;
    } catch (err: any) {
      const isTimeout =
        err.name === "AbortError" || err.message?.includes("timeout");
      const isRetryable = isTimeout || err.message?.includes("fetch failed");

      if (!isRetryable || attempt === 2) throw err;

      const backoffMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!response) throw new Error("OCR call failed after 3 attempts");

  // Map Azure response (snake_case) → RawPage[]
  const pages: RawPage[] = (response.pages || []).map((p: any, i: number) => ({
    pageNumber: i + 1,
    markdown: p.markdown || "",
    images: (p.images || [])
      .map((img: any) => {
        // Azure returns image_annotation (snake_case)
        const annotation = img.image_annotation || img.imageAnnotation || "{}";
        try {
          return JSON.parse(annotation);
        } catch {
          return { raw: annotation };
        }
      })
      .filter(Boolean),
  }));

  return { pages, ocrDurationMs: Date.now() - startMs };
}
