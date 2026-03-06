import { NextRequest, NextResponse } from "next/server";
import { verifyJWT } from "@/lib/auth";
import { runMistralOCR } from "@/lib/ocr";
import { postProcessDocument } from "@/lib/post-process";
import { OCRRequestSchema } from "@/lib/request-schema";
import type { OCRDocument } from "@/lib/schemas";

export async function POST(request: NextRequest) {
  const totalStart = Date.now();

  // ── 1. Auth ──
  const auth = await verifyJWT(request.headers.get("authorization"));
  if (!auth.valid) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: 401 }
    );
  }

  // ── 2. Parse + validate request ──
  let body;
  try {
    const raw = await request.json();
    body = OCRRequestSchema.parse(raw);
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request body",
        details: err.errors || err.message,
      },
      { status: 400 }
    );
  }

  // ── 3. Run Mistral OCR (perception only — the ONLY AI cost) ──
  let ocrResult;
  try {
    ocrResult = await runMistralOCR(body.file_url, {
      model: body.ocr_config?.model || "mistral-ocr-latest",
      includeImageBase64: body.ocr_config?.include_image_base64 || false,
      bboxSchema: body.ocr_config?.bbox_schema,
    });
  } catch (err: any) {
    const isTimeout =
      err.message?.includes("timeout") || err.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? "OCR processing timed out"
          : "OCR processing failed",
        details: err.message,
      },
      { status: isTimeout ? 504 : 422 }
    );
  }

  // ── 4. Post-process (pure code, $0, <100ms) ──
  const postResult = postProcessDocument(ocrResult.pages);

  // ── 5. Assemble final document ──
  const now = Date.now();

  const document: OCRDocument = {
    file_info: {
      file_name: body.file_name || "unknown",
      mime_type: body.mime_type,
      file_url: body.file_url,
      source_path: body.source_path || "",
      content_hash: body.content_hash || null,
      loan_package_id: body.loan_package_id || null,
      metadata: body.metadata || null,
    },
    processing: {
      ocr_model: body.ocr_config?.model || "mistral-ocr-latest",
      ocr_duration_ms: ocrResult.ocrDurationMs,
      postprocess_duration_ms: postResult.postprocess_duration_ms,
      total_duration_ms: now - totalStart,
      processed_at: new Date().toISOString(),
      ocr_pages_processed: ocrResult.pages.length,
    },
    summary: postResult.summary,
    classification_hints: postResult.classification_hints,
    pages: postResult.pages,
    full_text: postResult.full_text,
  };

  return NextResponse.json({
    success: true,
    data: document,
    timing: {
      ocr_ms: ocrResult.ocrDurationMs,
      postprocess_ms: postResult.postprocess_duration_ms,
      total_ms: now - totalStart,
    },
  });
}