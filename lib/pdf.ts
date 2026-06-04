/* Client-side PDF → base64 image rendering and size helpers, extracted from
 * page.tsx. Browser-only: every function touches canvas/FileReader/Image at
 * call time (never at module load), so it is safe to import into the client
 * page component. */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";


/* ───────────── PDF → base64 images (client-side, pdfjs-dist) ───────────── */
let pdfjsLib: typeof import("pdfjs-dist") | null = null;
const PDF_RENDER_CONCURRENCY = 4;

export type RenderMode = "fast" | "balanced" | "accurate";
export type StudentProgressStatus = "waiting" | "rendering" | "analyzing" | "done" | "error";
export type StudentProgressItem = {
  index: number;
  name: string;
  startPage: number;
  endPage: number;
  status: StudentProgressStatus;
  detail: string;
  pageDone?: number;
  pageTotal?: number;
};

export const PDF_RENDER_PRESETS: Record<RenderMode, { label: string; scale: number; maxWidth: number; quality: number; hint: string }> = {
  fast: { label: "快速", scale: 1.15, maxWidth: 1200, quality: 0.66, hint: "最快，適合字體清楚的掃描檔" },
  balanced: { label: "標準", scale: 1.4, maxWidth: 1500, quality: 0.72, hint: "速度與辨識率較平均，建議預設使用" },
  accurate: { label: "高清", scale: 1.7, maxWidth: 1900, quality: 0.82, hint: "較慢，但手寫或細字會較清晰" },
};

export const STUDENT_STATUS_LABELS: Record<StudentProgressStatus, string> = {
  waiting: "等待中",
  rendering: "轉圖片",
  analyzing: "AI批改",
  done: "完成",
  error: "有錯誤",
};

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import("pdfjs-dist");
  // pdfjs-dist v3 uses .js worker file (Cloudflare Pages serves .js correctly)
  lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  pdfjsLib = lib;
  return lib;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getPdfParseTimeoutMs(file: File) {
  const sizeMb = file.size / 1024 / 1024;
  return Math.round(Math.max(25000, Math.min(90000, sizeMb * 10000)));
}

function getPdfErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/PDF_PARSE_TIMEOUT/i.test(message)) return "PDF 解析超時，請先壓縮或重新匯出 PDF，再重新上載。";
  if (/password|encrypted/i.test(message)) return "PDF 已加密或需要密碼，請先解除密碼後再上載。";
  if (/invalid|corrupt|damaged|bad XRef|Missing PDF/i.test(message)) return "PDF 檔案可能已損壞，請重新匯出 PDF 後再試。";
  // Show the real error to help diagnose
  return `PDF 解析失敗：${message || "未知錯誤"}`;
}

function readFileAsArrayBuffer(file: File, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("讀取 PDF 失敗"));
    reader.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

export async function loadPdfDocument(file: File, onProgress?: (message: string, percent?: number) => void): Promise<PDFDocumentProxy> {
  const lib = await loadPdfjs();
  const buf = await readFileAsArrayBuffer(file, (loaded, total) => {
    const percent = total ? Math.min(99, Math.round((loaded / total) * 100)) : undefined;
    onProgress?.(`讀取檔案 ${formatBytes(loaded)} / ${formatBytes(total || file.size)}`, percent);
  });
  onProgress?.("解析 PDF 頁數中", 99);
  const loadingTask = lib.getDocument({ data: new Uint8Array(buf) });
  loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
    if (total) onProgress?.(`解析 PDF ${Math.round((loaded / total) * 100)}%`, Math.min(99, Math.round((loaded / total) * 100)));
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = getPdfParseTimeoutMs(file);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      void loadingTask.destroy().catch(() => undefined);
      reject(new Error("PDF_PARSE_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([loadingTask.promise, timeoutPromise]);
  } catch (error) {
    throw new Error(getPdfErrorMessage(error));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getOptimizedViewport(page: PDFPageProxy, mode: RenderMode) {
  const preset = PDF_RENDER_PRESETS[mode];
  let targetScale = preset.scale;
  let viewport = page.getViewport({ scale: targetScale });
  if (viewport.width > preset.maxWidth) {
    targetScale = targetScale * (preset.maxWidth / viewport.width);
    viewport = page.getViewport({ scale: targetScale });
  }
  return viewport;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("圖片轉換失敗"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.split(",")[1] || "");
    };
    reader.readAsDataURL(blob);
  });
}

async function canvasToJpegBase64(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("未能輸出 JPEG 圖片"));
    }, "image/jpeg", quality);
  });
  return blobToBase64(blob);
}

async function renderPdfPageToImageOnce(doc: PDFDocumentProxy, pageNumber: number, mode: RenderMode): Promise<string> {
  const preset = PDF_RENDER_PRESETS[mode];
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = getOptimizedViewport(page, mode);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("未能建立圖片畫布");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // pdfjs v5 accepts { canvasContext, viewport } and also { canvas, viewport }; use both for compat.
    const renderArgs = { canvasContext: ctx, viewport, canvas } as unknown as Parameters<typeof page.render>[0];
    await page.render(renderArgs).promise;
    const image = await canvasToJpegBase64(canvas, preset.quality);
    canvas.width = 0;
    canvas.height = 0;
    return image;
  } finally {
    try { page.cleanup(); } catch { /* ignore */ }
  }
}

async function renderPdfPageToImage(doc: PDFDocumentProxy, pageNumber: number, mode: RenderMode): Promise<string> {
  const attempts: RenderMode[] = mode === "fast" ? ["fast"] : mode === "balanced" ? ["balanced", "fast"] : ["accurate", "balanced", "fast"];
  let lastErr: unknown = null;
  for (const m of attempts) {
    try {
      return await renderPdfPageToImageOnce(doc, pageNumber, m);
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? (lastErr.message || lastErr.name || "render failed") : String(lastErr);
  throw new Error(`第 ${pageNumber} 頁渲染失敗：${msg}`);
}

export async function renderPdfPagesToImages(
  doc: PDFDocumentProxy,
  startPage: number,
  endPage: number,
  mode: RenderMode,
  onPageDone?: (done: number, total: number) => void,
): Promise<string[]> {
  const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
  const images: string[] = [];
  let nextIndex = 0;
  let finished = 0;

  const workers = Array.from({ length: Math.min(PDF_RENDER_CONCURRENCY, pageNumbers.length) }, async () => {
    while (nextIndex < pageNumbers.length) {
      const index = nextIndex++;
      images[index] = await renderPdfPageToImage(doc, pageNumbers[index], mode);
      finished += 1;
      onPageDone?.(finished, pageNumbers.length);
    }
  });

  await Promise.all(workers);
  return images;
}

export async function pdfToImages(
  file: File,
  mode: RenderMode,
  onPageDone?: (done: number, total: number) => void,
  onLoadProgress?: (message: string, percent?: number) => void,
): Promise<string[]> {
  const doc = await loadPdfDocument(file, onLoadProgress);
  try {
    return await renderPdfPagesToImages(doc, 1, doc.numPages, mode, onPageDone);
  } finally {
    void doc.destroy();
  }
}

export async function imageToBase64(file: File): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("圖片讀取失敗"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve([dataUrl.split(",")[1] || ""]);
    };
    reader.readAsDataURL(file);
  });
}

/* ───────────── Image shrink + size helpers ───────────── */
export function approxBase64Mb(images: string[]): number {
  const bytes = images.reduce((s, b) => s + b.length, 0) * 0.75;
  return bytes / (1024 * 1024);
}

async function shrinkBase64Jpeg(b64: string, maxWidth: number, quality: number): Promise<string> {
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("圖片解碼失敗"));
    im.src = dataUrl;
  });
  const scale = Math.min(1, maxWidth / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("未能建立壓縮畫布");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const result = await canvasToJpegBase64(canvas, quality);
  canvas.width = 0; canvas.height = 0;
  return result;
}

/** Recompress images iteratively until total size ≤ targetMb (or give up). */
export async function shrinkImagesToFit(images: string[], targetMb: number): Promise<string[]> {
  const passes: Array<{ w: number; q: number }> = [
    { w: 1400, q: 0.7 }, { w: 1200, q: 0.62 }, { w: 1050, q: 0.55 }, { w: 900, q: 0.5 },
  ];
  let cur = images;
  for (const p of passes) {
    if (approxBase64Mb(cur) <= targetMb) return cur;
    cur = await Promise.all(cur.map(b => shrinkBase64Jpeg(b, p.w, p.q)));
  }
  return cur;
}

/** Split images into N sub-batches so each batch's base64 ≤ targetMb. */
export function splitImagesByBudget(images: string[], targetMb: number): string[][] {
  if (approxBase64Mb(images) <= targetMb) return [images];
  const budget = targetMb * 1024 * 1024 / 0.75; // budget in base64 chars
  const batches: string[][] = [];
  let cur: string[] = []; let curBytes = 0;
  for (const im of images) {
    if (cur.length && curBytes + im.length > budget) {
      batches.push(cur); cur = []; curBytes = 0;
    }
    cur.push(im); curBytes += im.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
