"use client";
import { useState, useRef, useCallback } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ResponsiveContainer, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar, ReferenceLine,
} from "recharts";
import { aggregateStudentResults } from "@/lib/aggregate";
import type { StudentResult, ClassAggregated, ClassInsights, AnswerKeyQuestion, PracticeResult, QuestionStat } from "@/lib/types";
import { downloadPracticeDocx } from "@/lib/practice-docx";

/* ───────────── PDF → base64 images (client-side, pdfjs-dist) ───────────── */
let pdfjsLib: typeof import("pdfjs-dist") | null = null;
const PDF_RENDER_CONCURRENCY = 2;

type RenderMode = "fast" | "balanced" | "accurate";
type StudentProgressStatus = "waiting" | "rendering" | "analyzing" | "done" | "error";
type StudentProgressItem = {
  index: number;
  name: string;
  startPage: number;
  endPage: number;
  status: StudentProgressStatus;
  detail: string;
  pageDone?: number;
  pageTotal?: number;
};

const PDF_RENDER_PRESETS: Record<RenderMode, { label: string; scale: number; maxWidth: number; quality: number; hint: string }> = {
  fast: { label: "快速", scale: 1.15, maxWidth: 1200, quality: 0.66, hint: "最快，適合字體清楚的掃描檔" },
  balanced: { label: "標準", scale: 1.4, maxWidth: 1500, quality: 0.72, hint: "速度與辨識率較平均，建議預設使用" },
  accurate: { label: "高清", scale: 1.7, maxWidth: 1900, quality: 0.82, hint: "較慢，但手寫或細字會較清晰" },
};

const STUDENT_STATUS_LABELS: Record<StudentProgressStatus, string> = {
  waiting: "等待中",
  rendering: "轉圖片",
  analyzing: "AI批改",
  done: "完成",
  error: "有錯誤",
};

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
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
  if (/worker|fetch|network|404/i.test(message)) return "PDF 解析器載入失敗，請重新整理頁面後再試。";
  return message || "PDF 解析失敗，請重新匯出 PDF 後再試。";
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

async function loadPdfDocument(file: File, onProgress?: (message: string, percent?: number) => void): Promise<PDFDocumentProxy> {
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

async function renderPdfPagesToImages(
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

async function pdfToImages(
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

async function imageToBase64(file: File): Promise<string[]> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve([dataUrl.split(",")[1]]);
    };
    reader.readAsDataURL(file);
  });
}

/* ───────────── Image shrink + size helpers ───────────── */
function approxBase64Mb(images: string[]): number {
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
async function shrinkImagesToFit(images: string[], targetMb: number): Promise<string[]> {
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
function splitImagesByBudget(images: string[], targetMb: number): string[][] {
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

/* ───────────── PIE CHART COLORS ───────────── */
const PIE_COLORS: Record<string, string> = {
  "優秀(≥85%)": "#43a047",
  "良好(70-84%)": "#1e88e5",
  "一般(55-69%)": "#f9a825",
  "需要改善(<55%)": "#e53935",
};
const STRAND_COLORS = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFB74D", "#BA68C8"];

/* ───────────── Practice worksheet HTML export ───────────── */
function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}
function formatChineseDate(d = new Date()) {
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
}
const PRACTICE_WORKSHEET_CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Source Han Sans TC", sans-serif; font-size: 12pt; color: #1a1a1a; background: #d8dce0; }
.print-controls { background: #1e3a5f; color: #fff; text-align: center; padding: 14px 20px; position: sticky; top: 0; z-index: 100; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
.print-controls p { font-size: 13px; opacity: 0.85; margin-right: 8px; }
.btn { padding: 8px 22px; border: none; border-radius: 5px; font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 600; }
.btn-primary { background: #f0a500; color: #1a1a1a; }
.btn-primary:hover { background: #e09400; }
.page { width: 210mm; min-height: 297mm; margin: 10mm auto; background: white; padding: 14mm 16mm 22mm 16mm; box-shadow: 0 4px 20px rgba(0,0,0,0.2); position: relative; page-break-after: always; }
.ws-header { border-bottom: 3px double #1e3a5f; padding-bottom: 10px; margin-bottom: 12px; }
.ws-super { text-align: center; font-size: 9.5pt; color: #1e3a5f; letter-spacing: 0.5px; margin-bottom: 4px; }
.ws-title { text-align: center; font-size: 17pt; font-weight: 700; color: #1e3a5f; margin-bottom: 12px; }
.ws-fields { display: flex; gap: 8px; }
.ws-field { flex: 1; border-bottom: 1.5px solid #555; padding: 2px 0 3px 0; font-size: 11pt; min-height: 26px; }
.ws-field-label { font-size: 9pt; color: #555; margin-right: 3px; }
.weakness-note { background: #fff8e1; border-left: 4px solid #e09400; border-radius: 0 4px 4px 0; padding: 6px 12px; margin: 10px 0 4px 0; font-size: 10pt; color: #5d3a00; line-height: 1.5; }
.q-block { border: 1px solid #bbb; border-radius: 5px; margin: 11px 0; overflow: hidden; break-inside: avoid; }
.q-head { background: #1e3a5f; color: #fff; padding: 5px 12px; font-size: 10pt; display: flex; justify-content: space-between; align-items: center; }
.q-num { font-weight: 700; font-size: 12pt; }
.q-type-tag { display: inline-block; background: rgba(255,255,255,0.2); padding: 1px 8px; border-radius: 3px; font-size: 9pt; margin-left: 6px; }
.q-topic { font-size: 9pt; opacity: 0.8; }
.q-body { padding: 10px 14px 8px 14px; }
.q-text { font-size: 12.5pt; line-height: 1.75; margin-bottom: 8px; white-space: pre-wrap; }
.hint-box { background: #e3f2fd; border-radius: 4px; padding: 4px 10px; font-size: 9.5pt; color: #1a3c5c; margin-bottom: 8px; }
.work-space { border: 1px dashed #bbb; border-radius: 4px; background: #fafafa; min-height: 50px; padding: 6px 10px; font-size: 9pt; color: #aaa; }
.tips-box { margin-top: 14px; background: #e8f5e9; border: 1px solid #a5d6a7; border-radius: 5px; padding: 8px 14px; font-size: 10pt; }
.tips-title { font-weight: 700; color: #2e7d32; margin-bottom: 6px; font-size: 11pt; }
.tip-item { padding: 2px 0; line-height: 1.5; }
.tip-item::before { content: "📌 "; }
.pg-footer { position: absolute; bottom: 10mm; left: 16mm; right: 16mm; border-top: 1px solid #ddd; padding-top: 4px; display: flex; justify-content: space-between; font-size: 8pt; color: #999; }
@media print { body { background: white; } .print-controls { display: none !important; } .page { width: 100%; margin: 0; padding: 12mm 14mm 22mm 14mm; box-shadow: none; min-height: unset; } }`;

function buildPracticeWorksheetHtml(entries: { studentName: string; result: PracticeResult }[], grade: string): string {
  const dateStr = formatChineseDate();
  const pages = entries.map(({ studentName, result }) => {
    const qs = result.practice_questions || [];
    const tips = result.study_tips || [];
    const totalScore = Math.max(qs.length * 2, 10);
    const note = result.weakness_summary
      ? `<div class="weakness-note">🎯 <strong>練習重點：</strong>${escapeHtml(result.weakness_summary)}</div>`
      : "";
    const qBlocks = qs.map(q => `<div class="q-block">
  <div class="q-head">
    <span><span class="q-num">第 ${q.question_number} 題</span><span class="q-type-tag">${escapeHtml(q.question_type || "")}</span></span>
    <span class="q-topic">${escapeHtml(q.strand || "")}&nbsp;·&nbsp;${escapeHtml(q.topic || "")}</span>
  </div>
  <div class="q-body">
    <div class="q-text">${escapeHtml(q.question_text || "")}</div>
    ${q.hints ? `<div class="hint-box">💡 提示：${escapeHtml(q.hints)}</div>` : ""}
    <div class="work-space">（計算工作空間）</div>
  </div>
</div>`).join("\n");
    const tipsBlock = tips.length
      ? `<div class="tips-box">
  <div class="tips-title">📚 學習建議</div>
  ${tips.map(t => `<div class="tip-item">${escapeHtml(t)}</div>`).join("")}
</div>`
      : "";
    return `<div class="page">
<div class="ws-header">
  <div class="ws-super">小學數學 弱點針對練習 · ${escapeHtml(grade)} · 【學生練習版】</div>
  <div class="ws-title">📝 數學弱點鞏固練習題</div>
  <div class="ws-fields">
    <div class="ws-field"><span class="ws-field-label">姓名：</span>${escapeHtml(studentName)}</div>
    <div class="ws-field"><span class="ws-field-label">班別：</span>&nbsp;</div>
    <div class="ws-field"><span class="ws-field-label">日期：</span>${dateStr}</div>
    <div class="ws-field"><span class="ws-field-label">得分：</span>_____ / ${totalScore}</div>
  </div>
</div>
${note}
${qBlocks}
${tipsBlock}
<div class="pg-footer">
  <span>${escapeHtml(studentName)}　${escapeHtml(grade)}</span>
  <span>弱點針對練習 — 小學數學分析系統</span>
  <span>${dateStr}</span>
</div>
</div>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>數學弱點練習 · ${escapeHtml(grade)} · 學生練習版</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body, {delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});"></script>
<style>${PRACTICE_WORKSHEET_CSS}</style>
</head>
<body>
<div class="print-controls">
  <p>共 <strong>${entries.length}</strong> 位學生的練習題 · 學生練習版 · ${dateStr}</p>
  <button class="btn btn-primary" onclick="window.print()">🖨️ 列印全部（${entries.length} 頁）</button>
</div>
${pages}
</body>
</html>`;
}

function downloadHtmlFile(filename: string, html: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildClassReportHtml(agg: ClassAggregated | null, insights: ClassInsights | null, grade: string, classLabel: string): string {
  const dateStr = formatChineseDate();
  if (!agg) {
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>數學分析報告</title></head><body style="font-family:system-ui;padding:40px;text-align:center;color:#666;"><p>暫無分析資料。</p></body></html>`;
  }
  const dist = agg.class_distribution || {};
  const distOrder = ["優秀(≥85%)", "良好(70-84%)", "一般(55-69%)", "需要改善(<55%)"];
  const distColors: Record<string, string> = {
    "優秀(≥85%)": "#43a047",
    "良好(70-84%)": "#1e88e5",
    "一般(55-69%)": "#f9a825",
    "需要改善(<55%)": "#e53935",
  };
  const totalValid = agg.valid_students || agg.student_results?.filter(s => !s.parse_error).length || 0;
  const totalStudents = agg.total_students || totalValid || 0;
  const classAvg = agg.class_average ?? 0;
  const weakCount = (agg.weak_questions || []).length;

  // 成績分佈 — 堆疊水平條 + 圖例
  const distSegments = distOrder.map(k => {
    const c = dist[k] || 0;
    const pct = totalValid ? (100 * c / totalValid) : 0;
    return { key: k, count: c, pct, color: distColors[k] };
  });
  const distBar = `
    <div class="dist-stack" role="img" aria-label="成績分佈">
      ${distSegments.filter(s => s.pct > 0).map(s => `
        <div class="dist-seg" style="flex:${s.pct};background:${s.color};" title="${escapeHtml(s.key)} ${s.count} 人 (${s.pct.toFixed(1)}%)">
          ${s.pct >= 8 ? `<span>${s.pct.toFixed(0)}%</span>` : ""}
        </div>
      `).join("")}
    </div>
    <div class="dist-legend">
      ${distSegments.map(s => `
        <div class="legend-item"><span class="dot" style="background:${s.color};"></span>${escapeHtml(s.key)}<strong>${s.count} 人</strong><span class="muted">(${s.pct.toFixed(1)}%)</span></div>
      `).join("")}
    </div>
  `;

  // 排行：徽章
  const rankingRows = (agg.student_ranking || []).map(r => {
    const pctNum = typeof r.percentage === "number" ? r.percentage : parseFloat(String(r.percentage)) || 0;
    const lv = pctNum >= 85 ? "excellent" : pctNum >= 70 ? "good" : pctNum >= 55 ? "average" : "weak";
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `${r.rank}`;
    return `
      <tr class="lv-${lv}">
        <td class="rank-cell">${medal}</td>
        <td><strong>${escapeHtml(r.student_name)}</strong></td>
        <td class="num">${r.total_marks_awarded}/${r.total_marks_possible}</td>
        <td class="num"><span class="pct-pill lv-${lv}">${pctNum.toFixed(1)}%</span></td>
        <td><span class="level-tag lv-${lv}">${escapeHtml(r.performance_level)}</span></td>
      </tr>
    `;
  }).join("");

  // 各範疇 — 用條形圖
  const strandBars = (agg.strand_stats || []).map(s => {
    const rate = s.class_average_rate ?? 0;
    const cls = rate >= 70 ? "strong" : rate >= 55 ? "mid" : "weak";
    return `
      <div class="strand-row strand-${cls}">
        <div class="strand-head">
          <span class="strand-name">${escapeHtml(s.strand)}</span>
          <span class="strand-meta">${rate.toFixed(1)}% · <em>${escapeHtml(s.status || "")}</em></span>
        </div>
        <div class="strand-track"><div class="strand-fill" style="width:${Math.min(100, Math.max(0, rate)).toFixed(1)}%;"></div></div>
        ${(s.questions || []).length ? `<div class="strand-qs">包含題目：${(s.questions || []).map(q => `<span class="chip">${escapeHtml(q)}</span>`).join("")}</div>` : ""}
      </div>
    `;
  }).join("");

  // 弱項題目卡片
  const weakCards = (agg.weak_questions || []).map(q => {
    const rate = q.class_correct_rate ?? 0;
    return `
      <div class="weak-card">
        <div class="weak-head">
          <span class="q-ref">${escapeHtml(q.question_ref)}</span>
          <span class="weak-rate">${rate.toFixed(1)}%</span>
        </div>
        <div class="weak-meta">${escapeHtml(q.strand)} · ${escapeHtml(q.topic)}</div>
        <div class="weak-track"><div class="weak-fill" style="width:${Math.min(100, rate).toFixed(1)}%;"></div></div>
        ${(q.common_errors || []).length ? `<ul class="weak-errors">${q.common_errors.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
      </div>
    `;
  }).join("");

  // 逐題正確率 heatmap-style 表格
  const qStatRows = (agg.question_stats || []).map(q => {
    const rate = q.class_correct_rate ?? 0;
    const cls = rate >= 70 ? "ok" : rate >= 55 ? "warn" : "bad";
    return `
      <tr>
        <td><strong>${escapeHtml(q.question_ref)}</strong></td>
        <td>${escapeHtml(q.strand)}</td>
        <td>${escapeHtml(q.topic)}</td>
        <td class="num">${q.marks_possible}</td>
        <td class="num">${q.class_correct_count}</td>
        <td class="rate-cell">
          <div class="rate-bar"><div class="rate-fill rate-${cls}" style="width:${Math.min(100, rate).toFixed(1)}%;"></div></div>
          <span class="rate-num rate-${cls}">${rate.toFixed(1)}%</span>
        </td>
        <td class="num">${q.class_average_marks != null ? q.class_average_marks.toFixed(2) : "—"}</td>
      </tr>
    `;
  }).join("");

  const insightsHtml = insights && !insights.parse_error ? `
    <section id="sec-ai" class="section">
      <h2><span class="sec-icon">🧠</span>AI 弱點深度分析</h2>
      ${insights.overall_diagnosis ? `<div class="info-box"><strong>診斷摘要：</strong>${escapeHtml(insights.overall_diagnosis)}</div>` : ""}
      ${(insights.weak_strand_analysis || []).length ? `
        <h3>📊 各課程範疇弱點</h3>
        <div class="card-grid">
          ${insights.weak_strand_analysis.map(ws => `
            <div class="ai-card">
              <div class="ai-card-head">
                <strong>${escapeHtml(ws.strand)}</strong>
                <span class="pct-pill ${(ws.class_average_rate ?? 0) >= 55 ? "lv-average" : "lv-weak"}">${(ws.class_average_rate ?? 0).toFixed(1)}%</span>
              </div>
              ${ws.misconception ? `<p><span class="hl">常見誤解：</span>${escapeHtml(ws.misconception)}</p>` : ""}
              ${(ws.key_issues || []).length ? `<ul>${ws.key_issues.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : ""}
              ${ws.curriculum_link ? `<p class="muted small"><span class="hl">課綱連結：</span>${escapeHtml(ws.curriculum_link)}</p>` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${insights.error_type_analysis ? `
        <h3>🧩 錯誤類型分析</h3>
        <div class="two-col">
          <div class="ai-card"><div class="ai-card-head"><strong>概念性誤解</strong><span class="emoji">💭</span></div><p>${escapeHtml(insights.error_type_analysis.conceptual || "—")}</p></div>
          <div class="ai-card"><div class="ai-card-head"><strong>程序性錯誤</strong><span class="emoji">⚙️</span></div><p>${escapeHtml(insights.error_type_analysis.procedural || "—")}</p></div>
        </div>
      ` : ""}
      ${insights.attention_students_note ? `<h3>👀 需要個別關注的學生</h3><div class="warn-box">${escapeHtml(insights.attention_students_note)}</div>` : ""}
      ${insights.positive_findings ? `<h3>💪 全班亮點</h3><div class="success-box">${escapeHtml(insights.positive_findings)}</div>` : ""}
    </section>
    ${(insights.teaching_recommendations || []).length ? `
      <section id="sec-teach" class="section">
        <h2><span class="sec-icon">💡</span>教學建議</h2>
        <div class="card-grid">
          ${insights.teaching_recommendations.map(t => {
            const pri = (t.priority || "").toString();
            const priCls = pri.includes("高") || pri.toLowerCase().includes("high") ? "pri-high" : pri.includes("中") || pri.toLowerCase().includes("med") ? "pri-mid" : "pri-low";
            return `
              <div class="ai-card teach-card ${priCls}">
                <div class="ai-card-head">
                  <span class="pri-tag ${priCls}">${escapeHtml(pri || "建議")}</span>
                  <strong>${escapeHtml(t.strand || "")}</strong>
                </div>
                ${t.strategy ? `<p><span class="hl">策略：</span>${escapeHtml(t.strategy)}</p>` : ""}
                ${(t.activities || []).length ? `<div class="hl">活動：</div><ul>${t.activities.map(a => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : ""}
                ${t.timeline ? `<p class="muted small"><span class="hl">時程：</span>${escapeHtml(t.timeline)}</p>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </section>
    ` : ""}
  ` : "";

  const studentDetailHtml = (agg.student_results || []).filter(s => !s.parse_error).map((s, idx) => {
    const pctNum = typeof s.percentage === "number" ? s.percentage : parseFloat(String(s.percentage)) || 0;
    const lv = pctNum >= 85 ? "excellent" : pctNum >= 70 ? "good" : pctNum >= 55 ? "average" : "weak";
    return `
    <details class="student-block lv-${lv}" ${idx < 3 ? "open" : ""}>
      <summary>
        <span class="stu-icon">🧑‍🎓</span>
        <span class="stu-name">${escapeHtml(s.student_name)}</span>
        <span class="stu-score">${s.total_marks_awarded}/${s.total_marks_possible}</span>
        <span class="pct-pill lv-${lv}">${pctNum.toFixed(1)}%</span>
        <span class="level-tag lv-${lv}">${escapeHtml(s.performance_level || "")}</span>
      </summary>
      <div class="stu-body">
        ${(s.question_results || []).length ? `
          <table class="qr-table">
            <thead><tr><th>題號</th><th>範疇</th><th>課題</th><th class="num">得分</th><th>結果</th><th>學生答案</th><th>正確答案</th><th>錯誤類型</th></tr></thead>
            <tbody>
              ${s.question_results.map(q => `
                <tr class="${q.is_correct ? "correct" : "wrong"}">
                  <td><strong>${escapeHtml(q.question_ref)}</strong></td>
                  <td>${escapeHtml(q.strand)}</td>
                  <td>${escapeHtml(q.topic)}</td>
                  <td class="num">${q.marks_awarded}/${q.marks_possible}</td>
                  <td class="result-cell">${q.is_correct ? "<span class='ok'>✅</span>" : "<span class='ng'>❌</span>"}</td>
                  <td>${escapeHtml(q.student_answer || "")}</td>
                  <td>${escapeHtml(q.correct_answer || "")}</td>
                  <td>${escapeHtml(q.error_type || "")}${q.error_description ? `<div class="muted small">${escapeHtml(q.error_description)}</div>` : ""}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : `<p class="muted">無逐題資料</p>`}
      </div>
    </details>
  `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>數學分析報告 · ${escapeHtml(grade)} · ${escapeHtml(classLabel || "全班")}</title>
<style>
  @page { size: A4; margin: 14mm; }
  :root {
    --accent: #667eea;
    --accent2: #764ba2;
    --green: #43a047;
    --blue: #1e88e5;
    --yellow: #f9a825;
    --red: #e53935;
    --fg: #1a2230;
    --fg2: #5b6573;
    --border: #e2e8f0;
    --card: #ffffff;
    --bg: #f0f2f5;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    color: var(--fg);
    line-height: 1.6;
    background: var(--bg);
    padding-bottom: 60px;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px; }
  /* Hero */
  .hero {
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    color: #fff;
    padding: 40px 28px 30px;
    border-radius: 0 0 24px 24px;
    margin-bottom: 20px;
    box-shadow: 0 4px 20px rgba(102,126,234,0.25);
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: "";
    position: absolute; right: -60px; top: -60px;
    width: 240px; height: 240px;
    background: rgba(255,255,255,0.08);
    border-radius: 50%;
  }
  .hero::after {
    content: "";
    position: absolute; right: 60px; bottom: -100px;
    width: 200px; height: 200px;
    background: rgba(255,255,255,0.06);
    border-radius: 50%;
  }
  .hero-inner { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 0 20px; }
  .hero h1 { font-size: 1.9rem; margin-bottom: 8px; letter-spacing: 0.5px; }
  .hero .meta { font-size: 0.95rem; opacity: 0.92; }
  .hero .meta .pill {
    display: inline-block; background: rgba(255,255,255,0.2);
    padding: 3px 10px; border-radius: 999px; margin-right: 8px; font-weight: 600;
    backdrop-filter: blur(4px);
  }
  /* TOC */
  .toc {
    display: flex; gap: 8px; flex-wrap: wrap;
    margin: 14px 0 20px; padding: 10px 14px;
    background: #fff; border-radius: 12px;
    border: 1px solid var(--border);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .toc a {
    text-decoration: none; color: var(--accent);
    padding: 5px 12px; border-radius: 999px;
    font-size: 0.85rem; font-weight: 600;
    background: rgba(102,126,234,0.08);
    transition: all 0.2s;
  }
  .toc a:hover { background: var(--accent); color: #fff; transform: translateY(-1px); }
  /* Section card */
  .section {
    background: #fff;
    border-radius: 14px;
    padding: 22px 24px;
    margin-bottom: 18px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    animation: slideUp 0.45s ease both;
  }
  .section:nth-child(2) { animation-delay: 0.05s; }
  .section:nth-child(3) { animation-delay: 0.1s; }
  .section:nth-child(4) { animation-delay: 0.15s; }
  @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  .section h2 {
    font-size: 1.2rem; color: var(--fg);
    display: flex; align-items: center; gap: 10px;
    padding-bottom: 12px; margin-bottom: 14px;
    border-bottom: 2px solid var(--border);
  }
  .section h2 .sec-icon { font-size: 1.4rem; }
  .section h3 { font-size: 1rem; margin: 16px 0 10px; color: var(--fg); }
  /* Metric tiles */
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 4px 0 8px; }
  .metric {
    background: linear-gradient(135deg, #fafbff 0%, #eef1ff 100%);
    border: 1px solid #dde3ff;
    border-radius: 12px;
    padding: 16px 14px;
    text-align: center;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .metric:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(102,126,234,0.18); }
  .metric .label { font-size: 0.78rem; color: var(--fg2); font-weight: 600; }
  .metric .value {
    font-size: 1.9rem; font-weight: 800;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text; background-clip: text; color: transparent;
    margin-top: 4px;
  }
  .metric .sub { font-size: 0.72rem; color: var(--fg2); margin-top: 2px; }
  /* Distribution */
  .dist-stack {
    display: flex; height: 32px;
    border-radius: 999px; overflow: hidden;
    background: #eee; margin: 12px 0 10px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.06);
  }
  .dist-seg {
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 0.78rem;
    transition: flex 0.5s ease;
  }
  .dist-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.85rem; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-item .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .legend-item strong { color: var(--fg); }
  .legend-item .muted { color: var(--fg2); font-size: 0.78rem; }
  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  thead th {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff; padding: 10px 12px;
    text-align: left; font-weight: 600; font-size: 0.85rem;
  }
  thead th:first-child { border-top-left-radius: 8px; }
  thead th:last-child { border-top-right-radius: 8px; }
  tbody td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafbfc; }
  tbody tr:hover td { background: #f0f4ff; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Pills & badges */
  .pct-pill {
    display: inline-block; padding: 2px 10px;
    border-radius: 999px; font-weight: 700; font-size: 0.8rem;
    color: #fff; min-width: 56px; text-align: center;
  }
  .pct-pill.lv-excellent { background: var(--green); }
  .pct-pill.lv-good { background: var(--blue); }
  .pct-pill.lv-average { background: var(--yellow); color: #5a3a00; }
  .pct-pill.lv-weak { background: var(--red); }
  .level-tag {
    display: inline-block; padding: 2px 8px; border-radius: 6px;
    font-size: 0.78rem; font-weight: 600;
  }
  .level-tag.lv-excellent { background: #e8f5e9; color: #2e7d32; }
  .level-tag.lv-good { background: #e3f2fd; color: #1565c0; }
  .level-tag.lv-average { background: #fff8e1; color: #8a5a00; }
  .level-tag.lv-weak { background: #ffebee; color: #c62828; }
  .rank-cell { text-align: center; font-size: 1.05rem; font-weight: 700; }
  /* Strand bars */
  .strand-row {
    background: #fafbfc; border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
    transition: transform 0.2s;
  }
  .strand-row:hover { transform: translateX(2px); }
  .strand-row.strand-strong { border-left: 4px solid var(--green); background: #f1f8e9; }
  .strand-row.strand-mid { border-left: 4px solid var(--yellow); background: #fff8e1; }
  .strand-row.strand-weak { border-left: 4px solid var(--red); background: #ffebee; }
  .strand-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .strand-name { font-weight: 700; font-size: 0.95rem; }
  .strand-meta { font-size: 0.85rem; color: var(--fg2); }
  .strand-meta em { font-style: normal; font-weight: 600; color: var(--fg); }
  .strand-track { height: 10px; background: rgba(0,0,0,0.06); border-radius: 999px; overflow: hidden; }
  .strand-fill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    animation: grow 0.8s ease both;
  }
  .strand-strong .strand-fill { background: linear-gradient(90deg, #66bb6a, #43a047); }
  .strand-mid .strand-fill { background: linear-gradient(90deg, #ffb74d, #f9a825); }
  .strand-weak .strand-fill { background: linear-gradient(90deg, #ef5350, #e53935); }
  @keyframes grow { from { width: 0; } }
  .strand-qs { margin-top: 8px; font-size: 0.82rem; color: var(--fg2); }
  .chip {
    display: inline-block; padding: 1px 8px; margin: 2px 3px 0 0;
    background: #fff; border: 1px solid var(--border); border-radius: 999px;
    font-size: 0.75rem; color: var(--fg);
  }
  /* Weak question cards */
  .weak-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .weak-card {
    background: linear-gradient(135deg, #fff5f5 0%, #ffe8e8 100%);
    border: 1px solid #ffcdd2; border-radius: 12px; padding: 14px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .weak-card:hover { transform: translateY(-3px); box-shadow: 0 8px 18px rgba(229,57,53,0.15); }
  .weak-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .q-ref { font-weight: 800; font-size: 1.05rem; color: var(--red); }
  .weak-rate { font-weight: 700; color: var(--red); font-size: 1.1rem; }
  .weak-meta { font-size: 0.82rem; color: var(--fg2); margin-bottom: 8px; }
  .weak-track { height: 6px; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
  .weak-fill { height: 100%; background: linear-gradient(90deg, #ef5350, #e53935); border-radius: 999px; animation: grow 0.8s ease both; }
  .weak-errors { margin: 6px 0 0 18px; font-size: 0.82rem; color: var(--fg); }
  .weak-errors li { margin-bottom: 3px; }
  /* Per-Q rate cell */
  .rate-cell { min-width: 160px; }
  .rate-bar { display: inline-block; width: 80px; height: 8px; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden; vertical-align: middle; margin-right: 8px; }
  .rate-fill { height: 100%; border-radius: 999px; }
  .rate-fill.rate-ok { background: linear-gradient(90deg, #66bb6a, #43a047); }
  .rate-fill.rate-warn { background: linear-gradient(90deg, #ffb74d, #f9a825); }
  .rate-fill.rate-bad { background: linear-gradient(90deg, #ef5350, #e53935); }
  .rate-num { font-weight: 700; font-size: 0.85rem; }
  .rate-num.rate-ok { color: var(--green); }
  .rate-num.rate-warn { color: #b07300; }
  .rate-num.rate-bad { color: var(--red); }
  /* Boxes */
  .info-box { background: #e8f4fd; border-left: 4px solid var(--blue); padding: 12px 16px; border-radius: 8px; margin: 10px 0; }
  .success-box { background: #e8f5e9; border-left: 4px solid var(--green); padding: 12px 16px; border-radius: 8px; margin: 10px 0; }
  .warn-box { background: #fff8e1; border-left: 4px solid var(--yellow); padding: 12px 16px; border-radius: 8px; margin: 10px 0; }
  /* AI cards */
  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, 1fr); } }
  .ai-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .ai-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.08); }
  .ai-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
  .ai-card .emoji { font-size: 1.2rem; }
  .ai-card p { margin: 6px 0; font-size: 0.9rem; }
  .ai-card ul { margin: 6px 0 6px 20px; font-size: 0.88rem; }
  .ai-card ul li { margin-bottom: 3px; }
  .hl { font-weight: 700; color: var(--accent2); }
  .muted { color: var(--fg2); }
  .small { font-size: 0.82rem; }
  .teach-card.pri-high { border-top: 4px solid var(--red); }
  .teach-card.pri-mid { border-top: 4px solid var(--yellow); }
  .teach-card.pri-low { border-top: 4px solid var(--green); }
  .pri-tag {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    font-size: 0.75rem; font-weight: 700; color: #fff;
  }
  .pri-tag.pri-high { background: var(--red); }
  .pri-tag.pri-mid { background: var(--yellow); color: #5a3a00; }
  .pri-tag.pri-low { background: var(--green); }
  /* Student details */
  .student-block {
    background: #fff;
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    margin-bottom: 10px;
    overflow: hidden;
    transition: box-shadow 0.2s;
  }
  .student-block:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
  .student-block.lv-excellent { border-left-color: var(--green); }
  .student-block.lv-good { border-left-color: var(--blue); }
  .student-block.lv-average { border-left-color: var(--yellow); }
  .student-block.lv-weak { border-left-color: var(--red); }
  .student-block summary {
    cursor: pointer;
    padding: 12px 16px;
    list-style: none;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    font-weight: 600;
    background: #fafbfc;
    transition: background 0.2s;
  }
  .student-block summary::-webkit-details-marker { display: none; }
  .student-block summary::before {
    content: "▶"; color: var(--accent); font-size: 0.7rem;
    transition: transform 0.2s;
  }
  .student-block[open] summary::before { transform: rotate(90deg); }
  .student-block summary:hover { background: #f0f4ff; }
  .stu-icon { font-size: 1.1rem; }
  .stu-name { font-size: 0.98rem; color: var(--fg); }
  .stu-score { color: var(--fg2); font-size: 0.88rem; font-weight: 500; }
  .stu-body { padding: 12px 16px 16px; }
  .qr-table { font-size: 0.84rem; }
  .qr-table thead th { background: #f1f3f5; color: var(--fg); border-bottom: 2px solid var(--border); }
  .qr-table tr.correct td { background: #f1f8e9; }
  .qr-table tr.wrong td { background: #ffebee; }
  .qr-table tr:hover td { background: #fff7d6 !important; }
  .result-cell { text-align: center; font-size: 1rem; }
  .result-cell .ok { color: var(--green); }
  .result-cell .ng { color: var(--red); }
  /* Print btn / FAB */
  .fab {
    position: fixed; bottom: 20px; right: 20px;
    display: flex; flex-direction: column; gap: 10px; z-index: 100;
  }
  .fab button {
    border: none; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff; padding: 12px 18px;
    border-radius: 999px; font-weight: 700; font-size: 0.9rem;
    box-shadow: 0 6px 18px rgba(102,126,234,0.45);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .fab button:hover { transform: translateY(-2px); box-shadow: 0 10px 22px rgba(102,126,234,0.55); }
  .fab .top-btn { background: #fff; color: var(--accent); border: 1px solid var(--border); box-shadow: 0 4px 10px rgba(0,0,0,0.08); }
  .footer { text-align: center; color: var(--fg2); font-size: 0.85rem; padding: 24px 0 10px; }
  /* Print */
  @media print {
    body { background: #fff; padding-bottom: 0; }
    .fab, .toc { display: none !important; }
    .hero { box-shadow: none; border-radius: 0; padding: 18px 0; }
    .section { box-shadow: none; border: 1px solid #ddd; page-break-inside: avoid; animation: none; }
    .student-block { page-break-inside: avoid; }
    details { page-break-inside: avoid; }
    details:not([open]) > summary { display: none; }
    details > div { display: block !important; }
    .ai-card:hover, .metric:hover, .strand-row:hover, .weak-card:hover, .student-block:hover, tbody tr:hover td { transform: none; box-shadow: none; background: inherit; }
    h2 { page-break-after: avoid; }
    .strand-fill, .weak-fill, .rate-fill { animation: none !important; }
  }
</style>
</head>
<body>
<header class="hero">
  <div class="hero-inner">
    <h1>📊 數學學生表現分析報告</h1>
    <div class="meta">
      <span class="pill">${escapeHtml(grade)}</span>
      <span class="pill">${escapeHtml(classLabel || "全班")}</span>
      <span>產生日期：${dateStr}</span>
    </div>
  </div>
</header>
<div class="wrap">
  <nav class="toc" aria-label="目錄">
    <a href="#sec-overview">📋 整體概覽</a>
    <a href="#sec-rank">🏅 學生成績</a>
    <a href="#sec-strand">📊 各範疇</a>
    ${weakCount ? `<a href="#sec-weak">🎯 弱項題目</a>` : ""}
    <a href="#sec-qstats">📝 逐題統計</a>
    ${insights && !insights.parse_error ? `<a href="#sec-ai">🧠 AI 分析</a>` : ""}
    ${insights && (insights.teaching_recommendations || []).length ? `<a href="#sec-teach">💡 教學建議</a>` : ""}
    <a href="#sec-students">🧑‍🎓 個別批改</a>
  </nav>

  <section id="sec-overview" class="section">
    <h2><span class="sec-icon">📋</span>整體概覽</h2>
    <div class="metrics">
      <div class="metric"><div class="label">學生總數</div><div class="value">${totalStudents}</div><div class="sub">含未批改</div></div>
      <div class="metric"><div class="label">成功批改</div><div class="value">${totalValid}</div><div class="sub">有效樣本</div></div>
      <div class="metric"><div class="label">全班平均</div><div class="value">${classAvg.toFixed(1)}%</div><div class="sub">總得分率</div></div>
      <div class="metric"><div class="label">弱項題目</div><div class="value">${weakCount}</div><div class="sub">需重點關注</div></div>
    </div>
    <h3>📈 成績分佈</h3>
    ${distBar}
  </section>

  <section id="sec-rank" class="section">
    <h2><span class="sec-icon">🏅</span>學生成績排行</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th class="num" style="width:60px;">名次</th><th>姓名</th><th class="num">得分</th><th class="num">百分比</th><th>等級</th></tr></thead>
        <tbody>${rankingRows || `<tr><td colspan="5" class="muted" style="text-align:center;padding:20px;">暫無排名資料</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  <section id="sec-strand" class="section">
    <h2><span class="sec-icon">📊</span>各範疇表現</h2>
    ${strandBars || `<p class="muted">暫無範疇資料</p>`}
  </section>

  ${weakCount ? `
    <section id="sec-weak" class="section">
      <h2><span class="sec-icon">🎯</span>全班弱項題目</h2>
      <div class="weak-grid">${weakCards}</div>
    </section>
  ` : ""}

  <section id="sec-qstats" class="section">
    <h2><span class="sec-icon">📝</span>逐題統計</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>題號</th><th>範疇</th><th>課題</th><th class="num">滿分</th><th class="num">答對</th><th>正確率</th><th class="num">平均分</th></tr></thead>
        <tbody>${qStatRows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px;">暫無逐題資料</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  ${insightsHtml}

  <section id="sec-students" class="section">
    <h2><span class="sec-icon">🧑‍🎓</span>學生個別批改詳情</h2>
    <p class="muted small" style="margin-bottom:12px;">前 3 位預設展開，其餘點擊姓名可展開／收合。列印時自動全部展開。</p>
    ${studentDetailHtml || `<p class="muted">暫無學生資料</p>`}
  </section>

  <div class="footer">本報告由「數學學生表現分析系統」自動生成 · ${dateStr}</div>
</div>

<div class="fab">
  <button class="top-btn" onclick="window.scrollTo({top:0,behavior:'smooth'})" aria-label="回到頂部">⬆ 頂部</button>
  <button onclick="document.querySelectorAll('details').forEach(d=>d.open=true);window.print()">🖨️ 列印 / 儲存 PDF</button>
</div>
</body>
</html>`;
}

export default function MathAnalyzer() {
  // Config state
  const [grade, setGrade] = useState("P4");
  const [pagesPerStudent, setPagesPerStudent] = useState(4);
  const [renderMode, setRenderMode] = useState<RenderMode>("balanced");
  const [classLabel, setClassLabel] = useState("");
  const [namesText, setNamesText] = useState("");

  // File state
  const [studentPdf, setStudentPdf] = useState<File | null>(null);
  const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
  const studentPdfRef = useRef<HTMLInputElement>(null);
  const answerKeyRef = useRef<HTMLInputElement>(null);

  // Analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [studentProgress, setStudentProgress] = useState<StudentProgressItem[]>([]);
  const [errorLog, setErrorLog] = useState<string[]>([]);

  // Results
  const [agg, setAgg] = useState<ClassAggregated | null>(null);
  const [insights, setInsights] = useState<ClassInsights | null>(null);

  // Tab
  const [activeTab, setActiveTab] = useState(0);
  const TABS = ["📋 整體概覽", "🏅 學生成績", "✏️ 自動批改", "📝 逐題分析", "🔥 弱點熱圖", "🎯 弱點診斷", "💡 教學建議", "📝 弱點練習", "📥 匯出報告"];

  // Practice state
  const [practiceNumQ, setPracticeNumQ] = useState(5);
  const [practiceDiff, setPracticeDiff] = useState("適中");
  const [practiceResults, setPracticeResults] = useState<Record<string, PracticeResult>>({});
  const [practiceLoading, setPracticeLoading] = useState<string | null>(null);
  const [batchPracticeRunning, setBatchPracticeRunning] = useState(false);
  const [batchPracticeProgress, setBatchPracticeProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  // Estimate student count
  const [totalPdfPages, setTotalPdfPages] = useState(0);
  const handleStudentPdf = useCallback(async (file: File) => {
    setStudentPdf(file);
    try {
      const doc = await loadPdfDocument(file);
      setTotalPdfPages(doc.numPages);
      void doc.destroy();
    } catch { setTotalPdfPages(0); }
  }, []);

  const estStudents = totalPdfPages ? Math.ceil(totalPdfPages / pagesPerStudent) : 0;

  function updateStudentProgress(index: number, patch: Partial<StudentProgressItem>) {
    setStudentProgress(prev => prev.map(item => item.index === index ? { ...item, ...patch } : item));
  }

  /* ───────────── MAIN ANALYSIS ───────────── */
  async function runAnalysis() {
    if (!studentPdf) return;
    if (!answerKeyFile) {
      alert("請先上傳答案鍵（必填）。AI 會根據答案鍵批改，速度更快、結果更準。");
      return;
    }
    setAnalyzing(true);
    setProgress(0);
    setStatusMsg("準備中…");
    setErrorLog([]);
    setStudentProgress([]);
    setAgg(null);
    setInsights(null);
    setPracticeResults({});
    let studentDoc: PDFDocumentProxy | null = null;

    try {
      // Step 1: Load PDF once; pages are rendered per student to avoid a long blocking conversion.
      setStatusMsg("📖 正在讀取試卷 PDF（準備讀檔）…");
      studentDoc = await loadPdfDocument(studentPdf, (message, percent) => {
        setStatusMsg(`📖 正在讀取試卷 PDF：${message}`);
        if (typeof percent === "number") setProgress(Math.min(5, Math.max(1, Math.round(percent * 0.05))));
      });
      const totalPages = studentDoc.numPages;
      setTotalPdfPages(totalPages);
      setProgress(5);

      // Step 2: Optional answer key
      let questionSchema: AnswerKeyQuestion[] = [];
      if (answerKeyFile) {
        setStatusMsg("📋 正在分析答案鍵…");
        let keyImages: string[];
        if (answerKeyFile.type === "application/pdf") {
          keyImages = await pdfToImages(
            answerKeyFile,
            renderMode,
            (done, total) => setStatusMsg(`📋 正在轉換答案鍵圖片 ${done}/${total} 頁…`),
            (message) => setStatusMsg(`📋 正在讀取答案鍵：${message}`),
          );
        } else {
          keyImages = await imageToBase64(answerKeyFile);
        }
        const keyResp = await fetch("/api/analyze-answer-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: keyImages, grade }),
        });
        const keyData = await keyResp.json();
        if (keyData.question_schema) {
          questionSchema = keyData.question_schema;
          setStatusMsg(`✅ 已從答案鍵識別 ${questionSchema.length} 題`);
        }
        setProgress(15);
      }

      // Step 3: Split into per-student chunks
      const studentNames = namesText.trim().split("\n").filter(Boolean).map(n => n.trim());
      const chunks: { index: number; startPage: number; endPage: number; name: string }[] = [];
      for (let page = 1; page <= totalPages; page += pagesPerStudent) {
        const idx = chunks.length;
        const name = studentNames[idx] || `學生${idx + 1}`;
        chunks.push({ index: idx + 1, startPage: page, endPage: Math.min(page + pagesPerStudent - 1, totalPages), name });
      }
      setStudentProgress(chunks.map(chunk => ({
        ...chunk,
        status: "waiting",
        detail: `第 ${chunk.startPage}–${chunk.endPage} 頁`,
        pageDone: 0,
        pageTotal: chunk.endPage - chunk.startPage + 1,
      })));

      // Step 4: Analyze each student (concurrency-limited pipeline)
      const allResults: StudentResult[] = [];
      const baseProgress = answerKeyFile ? 15 : 5;
      const progressPerStudent = (85 - baseProgress) / Math.max(chunks.length, 1);
      const errors: string[] = [];
      const STUDENT_CONCURRENCY = 4;
      let doneCount = 0;

      const processChunk = async (chunk: typeof chunks[number]) => {
        let stage = "init";
        const TARGET_MB = 3.6;
        const callApi = async (imgs: string[], label: string): Promise<Record<string, unknown>> => {
          const body = JSON.stringify({ images: imgs, questionSchema, grade, studentName: chunk.name });
          let lastErr: unknown = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const resp = await fetch("/api/analyze-student", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              });
              const ct = resp.headers.get("content-type") || "";
              if (!ct.includes("application/json")) {
                const txt = await resp.text();
                throw new Error(`Server returned non-JSON (HTTP ${resp.status}): ${txt.slice(0, 160)}`);
              }
              const data = await resp.json();
              if (!resp.ok) throw new Error((data.error as string) || `HTTP ${resp.status}`);
              return data as Record<string, unknown>;
            } catch (e) {
              lastErr = e;
              if (attempt === 1) await new Promise(r => setTimeout(r, 800));
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        };

        try {
          stage = "render";
          updateStudentProgress(chunk.index, { status: "rendering", detail: "正在轉成圖片", pageDone: 0 });
          let chunkImages = await renderPdfPagesToImages(studentDoc!, chunk.startPage, chunk.endPage, renderMode, (done, total) => {
            updateStudentProgress(chunk.index, { pageDone: done, pageTotal: total, detail: `已轉 ${done}/${total} 頁` });
          });

          stage = "shrink";
          if (approxBase64Mb(chunkImages) > TARGET_MB) {
            updateStudentProgress(chunk.index, { detail: `壓縮圖片中（${approxBase64Mb(chunkImages).toFixed(1)}MB）` });
            chunkImages = await shrinkImagesToFit(chunkImages, TARGET_MB);
          }

          stage = "split";
          const subBatches = splitImagesByBudget(chunkImages, TARGET_MB);

          stage = "fetch";
          updateStudentProgress(chunk.index, { status: "analyzing", detail: subBatches.length > 1 ? `AI 並行批改（${subBatches.length} 段）` : "AI 正在批改" });

          const subResults = await Promise.all(subBatches.map((b, i) => callApi(b, `seg${i + 1}/${subBatches.length}`)));

          stage = "merge";
          // Merge question_results across sub-batches; dedupe by question_ref.
          const seen: Record<string, Record<string, unknown>> = {};
          let totalAwarded = 0; let totalPossible = 0; let repaired = false; let parseErr = false;
          let firstError: string | undefined;
          for (const r of subResults) {
            if (r._repaired) repaired = true;
            if (r.parse_error) { parseErr = true; firstError = firstError || (r.error as string) || (r.raw_response as string)?.slice(0, 120); continue; }
            const qr = (r.question_results as Record<string, unknown>[]) || [];
            for (const q of qr) seen[String(q.question_ref || Math.random())] = q;
            totalAwarded += Number(r.total_marks_awarded) || 0;
            totalPossible += Number(r.total_marks_possible) || 0;
          }
          const merged = Object.values(seen);
          if (!merged.length && parseErr) {
            throw new Error(`AI 回傳未能解析：${firstError || "未知"}`);
          }
          if (!totalPossible) totalPossible = merged.reduce((s, q) => s + (Number(q.marks_possible) || 1), 0);
          if (!totalAwarded) totalAwarded = merged.reduce((s, q) => s + (Number(q.marks_awarded) || 0), 0);
          const pct = totalPossible ? Math.round(1000 * totalAwarded / totalPossible) / 10 : 0;
          const level = pct >= 85 ? "優秀(≥85%)" : pct >= 70 ? "良好(70-84%)" : pct >= 55 ? "一般(55-69%)" : "需要改善(<55%)";

          const finalResult: StudentResult = {
            student_name: chunk.name,
            student_index: chunk.index,
            total_marks_awarded: totalAwarded,
            total_marks_possible: totalPossible,
            percentage: pct,
            performance_level: level,
            question_results: merged as unknown as StudentResult["question_results"],
          };
          allResults.push(finalResult);
          updateStudentProgress(chunk.index, {
            status: "done",
            detail: `完成 ${pct}%${subBatches.length > 1 ? `（${subBatches.length} 段合併）` : ""}${repaired ? "（已修復截斷 JSON）" : ""}`,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const labeled = `[${stage}] ${msg}`;
          errors.push(`${chunk.name}：${labeled}`);
          allResults.push({ student_name: chunk.name, student_index: chunk.index, parse_error: true, error: labeled } as StudentResult);
          updateStudentProgress(chunk.index, { status: "error", detail: labeled });
        } finally {
          doneCount++;
          setProgress(Math.min(99, Math.round(baseProgress + doneCount * progressPerStudent)));
          setStatusMsg(`🤖 已完成 ${doneCount}/${chunks.length} 位學生（並發 ${STUDENT_CONCURRENCY} 路）`);
        }
      };

      // Concurrency-limited pipeline
      const queue = [...chunks];
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(STUDENT_CONCURRENCY, queue.length); w++) {
        workers.push((async () => {
          while (queue.length) {
            const c = queue.shift();
            if (!c) break;
            await processChunk(c);
          }
        })());
      }
      await Promise.all(workers);
      // Restore order by student_index
      allResults.sort((a, b) => (a.student_index || 0) - (b.student_index || 0));

      // Step 5: Aggregate
      setStatusMsg("📊 正在計算全班統計數據…");
      const expectedQs = questionSchema.length ? questionSchema.map(q => q.question_ref) : undefined;
      const aggregated = aggregateStudentResults(allResults, expectedQs);

      // Step 6: AI insights
      setStatusMsg("🧠 AI 正在生成教學診斷建議…");
      try {
        const insResp = await fetch("/api/generate-insights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aggregated, grade }),
        });
        const insData = await insResp.json();
        setInsights(insData as ClassInsights);
      } catch {}

      setProgress(100);
      const ok = allResults.filter(r => !r.parse_error).length;
      setStatusMsg(`✅ 完成！成功批改 ${ok} / ${chunks.length} 份試卷`);
      setAgg(aggregated);
      setErrorLog(errors);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg(`❌ 分析時發生錯誤：${msg}`);
    } finally {
      if (studentDoc) void studentDoc.destroy();
      setAnalyzing(false);
    }
  }

  /* ───────────── PRACTICE QUESTIONS ───────────── */
  async function generatePractice(studentName: string, weakQs: Record<string, unknown>[], genType: string, allQs?: Record<string, unknown>[]) {
    setPracticeLoading(studentName);
    try {
      const resp = await fetch("/api/generate-practice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName,
          grade,
          weakQuestions: genType === "weakness" ? weakQs : undefined,
          allQuestions: genType === "consolidation" ? allQs : undefined,
          numQuestions: practiceNumQ,
          difficulty: practiceDiff,
          genType,
        }),
      });
      const data = await resp.json();
      data._gen_type = genType;
      setPracticeResults(prev => ({ ...prev, [studentName]: data as PracticeResult }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPracticeResults(prev => ({ ...prev, [studentName]: { student_name: studentName, parse_error: true, error: msg } as unknown as PracticeResult }));
    }
    setPracticeLoading(null);
  }

  async function generateAllPractice() {
    if (!agg) return;
    const targets = agg.student_results
      .filter(s => !s.parse_error)
      .map(s => ({ s, wrong: (s.question_results || []).filter(q => !q.is_correct) }))
      .filter(({ s, wrong }) => wrong.length > 0 && !(practiceResults[s.student_name] && !practiceResults[s.student_name].parse_error && (practiceResults[s.student_name].practice_questions?.length || 0) > 0));
    if (!targets.length) {
      alert("沒有需要生成的學生（已全部生成或無弱點）。");
      return;
    }
    setBatchPracticeRunning(true);
    setBatchPracticeProgress({ done: 0, total: targets.length });
    const PRACTICE_CONCURRENCY = 3;
    let next = 0;
    let done = 0;
    const workers = Array.from({ length: Math.min(PRACTICE_CONCURRENCY, targets.length) }, async () => {
      while (next < targets.length) {
        const idx = next++;
        const { s, wrong } = targets[idx];
        try {
          const resp = await fetch("/api/generate-practice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentName: s.student_name,
              grade,
              weakQuestions: wrong as unknown as Record<string, unknown>[],
              numQuestions: practiceNumQ,
              difficulty: practiceDiff,
              genType: "weakness",
            }),
          });
          const data = await resp.json();
          data._gen_type = "weakness";
          setPracticeResults(prev => ({ ...prev, [s.student_name]: data as PracticeResult }));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setPracticeResults(prev => ({ ...prev, [s.student_name]: { student_name: s.student_name, parse_error: true, error: msg } as unknown as PracticeResult }));
        } finally {
          done++;
          setBatchPracticeProgress({ done, total: targets.length });
        }
      }
    });
    await Promise.all(workers);
    setBatchPracticeRunning(false);
  }

  /* ───────────── RENDER ───────────── */
  return (
    <div>
      {/* Header */}
      <div className="header">
        <img src="/logo.png" alt="校徽" />
        <div>
          <h1>📊 中華基督教會基慈小學 · 數學學生表現分析系統</h1>
          <p>上傳全班學生試卷 PDF · AI 逐份批改 · 自動生成全班弱點診斷報告 · 基於香港小學數學課程綱要</p>
        </div>
      </div>

      <div className="container">
        {/* Upload Section */}
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 12 }}>📁 上傳全班試卷</h2>
          <div className="two-col">
            <div>
              <h3 style={{ marginBottom: 8 }}>📄 全班試卷 PDF（必填）</h3>
              <div className={`upload-zone ${studentPdf ? "has-file" : ""}`} onClick={() => studentPdfRef.current?.click()}>
                <input ref={studentPdfRef} type="file" accept=".pdf" onChange={e => { if (e.target.files?.[0]) handleStudentPdf(e.target.files[0]); }} />
                {studentPdf ? `✅ ${studentPdf.name}` : "點擊選擇或拖放全班試卷 PDF"}
              </div>
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>📋 答案鍵（必填）</h3>
              <div className={`upload-zone ${answerKeyFile ? "has-file" : ""}`} onClick={() => answerKeyRef.current?.click()}>
                <input ref={answerKeyRef} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => { if (e.target.files?.[0]) setAnswerKeyFile(e.target.files[0]); }} />
                {answerKeyFile ? `✅ ${answerKeyFile.name}` : "點擊選擇答案鍵（PDF/JPG/PNG）— 必須提供，AI 會根據答案鍵批改"}
              </div>
            </div>
          </div>

          {totalPdfPages > 0 && (
            <div className="info-box" style={{ marginTop: 12 }}>
              📄 共 <strong>{totalPdfPages}</strong> 頁 · 每人 <strong>{pagesPerStudent}</strong> 頁 · 估計 <strong>{estStudents}</strong> 位學生
            </div>
          )}
        </div>

        {/* Config */}
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>⚙️ 試卷設定</h2>
          <div className="form-row">
            <div className="form-group">
              <label>年級</label>
              <select value={grade} onChange={e => setGrade(e.target.value)}>
                {["P1","P2","P3","P4","P5","P6"].map(g => <option key={g}>{g}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>每位學生的試卷頁數</label>
              <input type="number" min={1} max={20} value={pagesPerStudent} onChange={e => setPagesPerStudent(parseInt(e.target.value) || 4)} />
            </div>
            <div className="form-group">
              <label>備註（可選）</label>
              <input value={classLabel} onChange={e => setClassLabel(e.target.value)} placeholder="例：2025-26 上學期" />
            </div>
          </div>
          <div className="form-group full">
            <label>🏷️ 學生姓名（可選，每行一個）</label>
            <textarea rows={4} value={namesText} onChange={e => setNamesText(e.target.value)} placeholder={"陳大文\n李小明\n黃美玲\n（留空則自動命名為學生1、學生2…）"} />
          </div>
        </div>

        {/* Analyze Button */}
        <div style={{ textAlign: "center", margin: "16px 0" }}>
          <button className="btn btn-primary" style={{ fontSize: "1.1rem", padding: "14px 40px" }} disabled={!studentPdf || !answerKeyFile || analyzing} onClick={runAnalysis}>
            {analyzing ? "⏳ 分析中…" : "🔍 開始批改全班試卷"}
          </button>
        </div>

        {/* Progress */}
        {(analyzing || progress > 0) && (
          <div className="card">
            <div className="progress-bar"><div className="fill" style={{ width: `${progress}%` }} /></div>
            <div className="progress-head">
              <div>{statusMsg}</div>
              <strong>{progress}%</strong>
            </div>
            {studentProgress.length > 0 && (
              <div className="student-progress-list">
                {studentProgress.map(item => (
                  <div className={`student-progress-row ${item.status}`} key={item.index}>
                    <div className="student-progress-main">
                      <strong>{item.index}. {item.name}</strong>
                      <span>第 {item.startPage}–{item.endPage} 頁</span>
                    </div>
                    <div className="student-progress-detail">
                      <span className={`student-status ${item.status}`}>{STUDENT_STATUS_LABELS[item.status]}</span>
                      <span>{item.detail}</span>
                    </div>
                    {item.pageTotal ? (
                      <div className="mini-progress"><div style={{ width: `${Math.round(((item.pageDone || 0) / item.pageTotal) * 100)}%` }} /></div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {errorLog.length > 0 && <div className="warn-box">{errorLog.map((e, i) => <div key={i}>⚠️ {e}</div>)}</div>}
          </div>
        )}

        {/* ───── RESULTS ───── */}
        {agg && !agg.error && (
          <>
            <h2 style={{ margin: "20px 0 12px" }}>📊 {grade}{classLabel ? `（${classLabel}）` : ""} 全班數學表現分析報告</h2>
            <div className="tabs">
              {TABS.map((t, i) => <div key={i} className={`tab ${activeTab === i ? "active" : ""}`} onClick={() => setActiveTab(i)}>{t}</div>)}
            </div>

            {/* Tab 0: Overview */}
            {activeTab === 0 && <TabOverview agg={agg} insights={insights} />}
            {/* Tab 1: Ranking */}
            {activeTab === 1 && <TabRanking agg={agg} />}
            {/* Tab 2: Auto-marking */}
            {activeTab === 2 && <TabAutoMarking agg={agg} />}
            {/* Tab 3: Per-question */}
            {activeTab === 3 && <TabQuestionStats agg={agg} />}
            {/* Tab 4: Heatmap */}
            {activeTab === 4 && <TabHeatmap agg={agg} />}
            {/* Tab 5: Weak diagnosis */}
            {activeTab === 5 && <TabWeakDiagnosis agg={agg} insights={insights} />}
            {/* Tab 6: Teaching */}
            {activeTab === 6 && <TabTeaching insights={insights} />}
            {/* Tab 7: Practice */}
            {activeTab === 7 && (
              <TabPractice
                agg={agg}
                grade={grade}
                practiceNumQ={practiceNumQ}
                setPracticeNumQ={setPracticeNumQ}
                practiceDiff={practiceDiff}
                setPracticeDiff={setPracticeDiff}
                practiceResults={practiceResults}
                practiceLoading={practiceLoading}
                generatePractice={generatePractice}
                generateAllPractice={generateAllPractice}
                batchPracticeRunning={batchPracticeRunning}
                batchPracticeProgress={batchPracticeProgress}
              />
            )}
            {/* Tab 8: Export */}
            {activeTab === 8 && (
              <div className="card">
                <h3>📥 匯出分析報告</h3>
                <p style={{ margin: "10px 0", fontSize: "0.9rem", color: "var(--fg2)" }}>下載完整 HTML 分析報告，可供老師離線閱讀或直接列印。</p>
                <button className="btn btn-primary" onClick={() => downloadHtmlFile(`數學分析報告_${grade}_${classLabel || "全班"}_${formatChineseDate()}.html`, buildClassReportHtml(agg, insights, grade, classLabel))}>📄 下載 HTML 分析報告</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════ TAB COMPONENTS ═══════════════════════ */

function TabOverview({ agg, insights }: { agg: ClassAggregated; insights: ClassInsights | null }) {
  const dist = agg.class_distribution;
  const pieData = Object.entries(dist).filter(([, v]) => v > 0).map(([k, v]) => ({ name: k, value: v }));
  const strandData = agg.strand_stats.map((s, i) => ({ name: s.strand, value: s.class_average_rate, fill: STRAND_COLORS[i % STRAND_COLORS.length] }));

  return (
    <div className="card">
      <div className="metrics">
        <div className="metric"><div className="label">分析學生數</div><div className="value">{agg.total_students} 人</div></div>
        <div className="metric"><div className="label">全班平均分</div><div className="value">{agg.class_average}%</div></div>
        <div className="metric"><div className="label">弱題數目（&lt;60%）</div><div className="value">{agg.weak_questions.length}</div></div>
        <div className="metric"><div className="label">需要關注學生</div><div className="value">{dist["需要改善(<55%)"] || 0} 人</div></div>
      </div>
      {insights && !insights.parse_error && insights.overall_diagnosis && (
        <div className="info-box">🔬 <strong>診斷摘要：</strong> {insights.overall_diagnosis}</div>
      )}
      <div className="two-col" style={{ marginTop: 16 }}>
        <div>
          <h3>全班成績等級分佈</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, value, percent }) => `${name} ${value}人 (${((percent ?? 0) * 100).toFixed(0)}%)`}>
                {pieData.map((e) => <Cell key={e.name} fill={PIE_COLORS[e.name] || "#999"} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div>
          <h3>各課程範疇全班正確率</h3>
          {strandData.length >= 3 ? (
            <ResponsiveContainer width="100%" height={280}>
              <RadarChart data={strandData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="name" tick={{ fontSize: 12 }} />
                <PolarRadiusAxis domain={[0, 100]} />
                <Radar dataKey="value" stroke="#667eea" fill="#667eea" fillOpacity={0.25} />
              </RadarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={strandData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <ReferenceLine y={60} stroke="red" strokeDasharray="3 3" label="60%" />
                <Bar dataKey="value" name="正確率 (%)" fill="#667eea" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function TabRanking({ agg }: { agg: ClassAggregated }) {
  const ranking = agg.student_ranking;
  const icon = (l: string) => l.includes("優秀") ? "🟢" : l.includes("良好") ? "🔵" : l.includes("一般") ? "🟡" : l.includes("失敗") ? "❌" : "🔴";
  const barData = [...ranking].sort((a, b) => (a.percentage as number) - (b.percentage as number)).map(s => ({ name: s.student_name, value: s.percentage }));

  return (
    <div className="card">
      <h3>🏅 全班成績排名（共 {ranking.length} 位學生）</h3>
      <table>
        <thead><tr><th>排名</th><th>學生</th><th>得分率</th><th>得分</th><th>表現等級</th></tr></thead>
        <tbody>
          {ranking.map(s => (
            <tr key={s.rank}><td>{s.rank}</td><td>{s.student_name}</td><td>{typeof s.percentage === "number" ? `${s.percentage.toFixed(1)}%` : "—"}</td><td>{s.total_marks_awarded} / {s.total_marks_possible}</td><td>{icon(s.performance_level)} {s.performance_level}</td></tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: 16 }}>全班學生得分率排行</h3>
      <ResponsiveContainer width="100%" height={Math.max(300, ranking.length * 28)}>
        <BarChart data={barData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" domain={[0, 100]} />
          <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
          <Tooltip />
          <ReferenceLine x={60} stroke="red" strokeDasharray="3 3" />
          <ReferenceLine x={agg.class_average} stroke="blue" strokeDasharray="3 3" />
          <Bar dataKey="value" name="得分率 (%)" fill="#667eea" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TabAutoMarking({ agg }: { agg: ClassAggregated }) {
  const students = agg.student_results || [];
  const qStats = agg.question_stats || [];
  const allRefs = qStats.map(q => q.question_ref);

  return (
    <div className="card">
      <h3>✏️ 自動批改 — 各學生答錯題目</h3>
      <p style={{ fontSize: "0.85rem", color: "var(--fg2)", marginBottom: 12 }}>只列出每位學生答錯的題目，方便老師用紅筆在紙本工作紙上批改。</p>
      {students.map((s, si) => {
        if (s.parse_error) return <div key={si} className="warn-box"><strong>{s.student_name}</strong> — 分析失敗</div>;
        const wrong = (s.question_results || []).filter(q => q.is_correct === false);
        if (!wrong.length) return <div key={si} className="success-box"><strong>{s.student_name}</strong> — ✅ 全部答對（{s.question_results?.length}/{s.question_results?.length}）</div>;
        return (
          <details key={si} open={wrong.length >= 3}>
            <summary>❌ {s.student_name}　—　答錯 {wrong.length} 題 / 共 {s.question_results?.length} 題（得分率 {s.percentage?.toFixed(0)}%）</summary>
            <div className="inner">
              <table>
                <thead><tr><th>題目</th><th>考核主題</th><th>學生答案</th><th>正確答案</th><th>得分</th><th>錯誤類型</th><th>錯誤說明</th></tr></thead>
                <tbody>{wrong.map((q, qi) => <tr key={qi}><td>{q.question_ref}</td><td>{q.topic}</td><td>{q.student_answer || "—"}</td><td>{q.correct_answer || "—"}</td><td>{q.marks_awarded} / {q.marks_possible}</td><td>{q.error_type || ""}</td><td>{q.error_description || ""}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        );
      })}
      {allRefs.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>📋 全班答錯題目一覽表</h3>
          <p style={{ fontSize: "0.8rem", color: "var(--fg2)" }}>❌ = 答錯，空白 = 答對</p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>學生</th>{allRefs.map(r => <th key={r}>{r}</th>)}</tr></thead>
              <tbody>
                {students.filter(s => !s.parse_error).map((s, si) => {
                  const qMap: Record<string, boolean | undefined> = {};
                  for (const q of (s.question_results || [])) qMap[String(q.question_ref)] = q.is_correct;
                  return <tr key={si}><td>{s.student_name}</td>{allRefs.map(r => <td key={r} style={{ textAlign: "center" }}>{qMap[r] === false ? "❌" : ""}</td>)}</tr>;
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function TabQuestionStats({ agg }: { agg: ClassAggregated }) {
  const qStats = agg.question_stats;
  const barData = qStats.map(q => ({ name: q.question_ref, value: q.class_correct_rate }));

  return (
    <div className="card">
      <h3>📝 逐題全班正確率（共 {qStats.length} 題）</h3>
      <table>
        <thead><tr><th>題目</th><th>考核主題</th><th>範疇</th><th>全班正確率</th><th>正確人數</th><th>常見錯誤</th></tr></thead>
        <tbody>{qStats.map((q, i) => <tr key={i}><td>{q.question_ref}</td><td>{q.topic}</td><td>{q.strand}</td><td>{q.class_correct_rate}%</td><td>{q.class_correct_count} / {agg.valid_students}</td><td>{q.common_errors.slice(0, 2).join("；") || "—"}</td></tr>)}</tbody>
      </table>
      <h3 style={{ marginTop: 16 }}>各題全班正確率</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={barData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 100]} />
          <Tooltip />
          <ReferenceLine y={60} stroke="red" strokeDasharray="3 3" label="60% 基準線" />
          <Bar dataKey="value" name="正確率 (%)">
            {barData.map((entry, i) => <Cell key={i} fill={entry.value < 40 ? "#e53935" : entry.value < 60 ? "#f9a825" : "#43a047"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TabHeatmap({ agg }: { agg: ClassAggregated }) {
  const qStats = agg.question_stats;
  const students = agg.student_results.filter(s => !s.parse_error);
  const allRefs = qStats.map(q => q.question_ref);

  return (
    <div className="card">
      <h3>🔥 學生 × 題目 答對熱圖</h3>
      <p style={{ fontSize: "0.8rem", color: "var(--fg2)" }}>🟢 答對　🔴 答錯　🟡 未作答</p>
      <div className="heatmap-grid">
        <table>
          <thead><tr><th>學生</th>{allRefs.map(r => <th key={r}>{r}</th>)}</tr></thead>
          <tbody>
            {students.map((s, si) => {
              const qMap: Record<string, boolean | undefined> = {};
              for (const q of (s.question_results || [])) qMap[String(q.question_ref)] = q.is_correct;
              return (
                <tr key={si}>
                  <td>{s.student_name}</td>
                  {allRefs.map(r => {
                    const v = qMap[r];
                    const cls = v === true ? "correct" : v === false ? "wrong" : "na";
                    return <td key={r} className={cls}>{v === true ? "✓" : v === false ? "✗" : "—"}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 style={{ marginTop: 16 }}>各題全班正確率</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {qStats.map(q => (
          <div key={q.question_ref} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, textAlign: "center", minWidth: 60 }}>
            <div style={{ fontWeight: 700, fontSize: "0.85rem" }}>{q.question_ref}</div>
            <div style={{ color: q.class_correct_rate < 40 ? "var(--red)" : q.class_correct_rate < 60 ? "var(--yellow)" : "var(--green)", fontWeight: 600 }}>
              {q.class_correct_rate < 40 ? "🔴" : q.class_correct_rate < 60 ? "🟡" : "🟢"} {q.class_correct_rate}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabWeakDiagnosis({ agg, insights }: { agg: ClassAggregated; insights: ClassInsights | null }) {
  const weakQ = agg.weak_questions;
  const strandStats = agg.strand_stats;
  const barData = weakQ.map(q => ({ name: q.question_ref, value: q.class_correct_rate }));

  return (
    <div className="card">
      {weakQ.length > 0 && (
        <>
          <h3>🔴 弱題排行榜（正確率 &lt; 60%，共 {weakQ.length} 題）</h3>
          <table>
            <thead><tr><th>排名</th><th></th><th>題目</th><th>全班正確率</th><th>正確人數</th><th>考核主題</th><th>範疇</th><th>常見錯誤</th></tr></thead>
            <tbody>{weakQ.map(q => <tr key={q.rank}><td>{q.rank}</td><td>{q.class_correct_rate < 40 ? "🔴" : "🟡"}</td><td>{q.question_ref}</td><td>{q.class_correct_rate}%</td><td>{q.class_correct_count} / {agg.valid_students}</td><td>{q.topic}</td><td>{q.strand}</td><td>{q.common_errors.slice(0, 2).join("；") || "—"}</td></tr>)}</tbody>
          </table>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} />
              <Tooltip />
              <ReferenceLine y={60} stroke="red" strokeDasharray="3 3" />
              <Bar dataKey="value" name="正確率 (%)">
                {barData.map((e, i) => <Cell key={i} fill={e.value < 40 ? "#e53935" : "#f9a825"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
      {strandStats.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>📊 各課程範疇弱點</h3>
          {strandStats.map(s => {
            const cls = s.status === "弱項" ? "weak" : s.status === "一般" ? "mid" : "strong";
            const icon = s.status === "弱項" ? "🔴" : s.status === "一般" ? "🟡" : "✅";
            return (
              <div key={s.strand} className={`strand-bar ${cls}`}>
                {icon} <strong>{s.strand}</strong>　{s.class_average_rate}%　
                <span style={{ fontSize: "0.8rem" }}>（涉及題目：{s.questions.slice(0, 6).join("、")}{s.questions.length > 6 ? "…" : ""}）</span>
              </div>
            );
          })}
        </>
      )}
      {insights && !insights.parse_error && insights.weak_strand_analysis?.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>🧠 AI 弱點深度分析</h3>
          {insights.weak_strand_analysis.map((ws, i) => (
            <details key={i}>
              <summary>🔍 {ws.strand}（全班正確率：{ws.class_average_rate}%）</summary>
              <div className="inner">
                {ws.key_issues?.map((issue, j) => <div key={j}>• {issue}</div>)}
                {ws.misconception && <div className="warn-box">🧩 可能的概念誤解：{ws.misconception}</div>}
                {ws.curriculum_link && <div className="info-box">📚 課程連結：{ws.curriculum_link}</div>}
              </div>
            </details>
          ))}
        </>
      )}
      {insights && !insights.parse_error && insights.error_type_analysis && (
        <>
          <h3 style={{ marginTop: 16 }}>🔎 錯誤類型分析</h3>
          <div className="two-col">
            <div><h4>🧩 概念性誤解</h4><p style={{ fontSize: "0.9rem" }}>{insights.error_type_analysis.conceptual || "—"}</p></div>
            <div><h4>🔢 程序性錯誤</h4><p style={{ fontSize: "0.9rem" }}>{insights.error_type_analysis.procedural || "—"}</p></div>
          </div>
        </>
      )}
    </div>
  );
}

function TabTeaching({ insights }: { insights: ClassInsights | null }) {
  if (!insights || insights.parse_error) return <div className="card"><div className="info-box">教學建議需要先完成AI分析才能顯示。</div></div>;
  const recs = (insights.teaching_recommendations || []).sort((a, b) => {
    const order: Record<string, number> = { "高": 0, "中": 1, "低": 2 };
    return (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
  });

  return (
    <div className="card">
      {recs.length > 0 && (
        <>
          <h3>📅 補救教學建議</h3>
          {recs.map((r, i) => {
            const icon = r.priority === "高" ? "🔴" : r.priority === "中" ? "🟡" : "🟢";
            return (
              <details key={i}>
                <summary>{icon} {r.strand} — {r.strategy}</summary>
                <div className="inner">
                  <p><strong>優先級：</strong>{r.priority}　<strong>建議時間：</strong>{r.timeline}</p>
                  {r.activities?.length > 0 && (<><p><strong>教學活動：</strong></p>{r.activities.map((a, j) => <div key={j}>• {a}</div>)}</>)}
                </div>
              </details>
            );
          })}
        </>
      )}
      {insights.attention_students_note && (<><h3 style={{ marginTop: 16 }}>👀 需要個別關注的學生</h3><div className="warn-box">{insights.attention_students_note}</div></>)}
      {insights.positive_findings && (<><h3 style={{ marginTop: 16 }}>💪 全班亮點</h3><div className="success-box">{insights.positive_findings}</div></>)}
    </div>
  );
}

function TabPractice({ agg, grade, practiceNumQ, setPracticeNumQ, practiceDiff, setPracticeDiff, practiceResults, practiceLoading, generatePractice, generateAllPractice, batchPracticeRunning, batchPracticeProgress }: {
  agg: ClassAggregated; grade: string; practiceNumQ: number; setPracticeNumQ: (n: number) => void;
  practiceDiff: string; setPracticeDiff: (d: string) => void;
  practiceResults: Record<string, PracticeResult>; practiceLoading: string | null;
  generatePractice: (name: string, weak: Record<string, unknown>[], type: string, all?: Record<string, unknown>[]) => void;
  generateAllPractice: () => void;
  batchPracticeRunning: boolean;
  batchPracticeProgress: { done: number; total: number };
}) {
  const students = agg.student_results.filter(s => !s.parse_error);
  const withErrors: { s: StudentResult; wrong: Record<string, unknown>[] }[] = [];
  const perfect: { s: StudentResult; all: Record<string, unknown>[] }[] = [];
  for (const s of students) {
    const wrong = (s.question_results || []).filter(q => !q.is_correct);
    if (wrong.length) withErrors.push({ s, wrong: wrong as unknown as Record<string, unknown>[] });
    else if (s.question_results?.length) perfect.push({ s, all: s.question_results as unknown as Record<string, unknown>[] });
  }

  return (
    <div className="card">
      <h3>📝 弱點針對練習</h3>
      <p style={{ fontSize: "0.85rem", color: "var(--fg2)", marginBottom: 12 }}>根據每位學生的答錯題目和弱點，由 AI 自動生成相似題型的練習題。</p>
      <div className="form-row">
        <div className="form-group"><label>每人題目數量</label><input type="number" min={1} max={15} value={practiceNumQ} onChange={e => setPracticeNumQ(parseInt(e.target.value) || 5)} /></div>
        <div className="form-group"><label>難度</label><select value={practiceDiff} onChange={e => setPracticeDiff(e.target.value)}><option>簡單</option><option>適中</option><option>進階</option></select></div>
      </div>

      <div style={{ margin: "8px 0 14px 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={batchPracticeRunning}
          onClick={generateAllPractice}
        >{batchPracticeRunning ? `⏳ 生成中… ${batchPracticeProgress.done}/${batchPracticeProgress.total}` : "🚀 一鍵生成所有學生練習"}</button>
        <button
          className="btn btn-primary btn-sm"
          disabled={Object.values(practiceResults).every(r => !r || r.parse_error || !(r.practice_questions?.length))}
          onClick={() => {
            const entries = Object.entries(practiceResults)
              .filter(([, r]) => r && !r.parse_error && (r.practice_questions?.length || 0) > 0)
              .map(([studentName, result]) => ({ studentName, result }));
            if (!entries.length) return;
            const html = buildPracticeWorksheetHtml(entries, grade);
            downloadHtmlFile(`數學弱點練習_${grade}_全班_${formatChineseDate()}.html`, html);
          }}
        >📄 下載全班練習工作紙 (HTML)</button>
        <span style={{ fontSize: "0.8rem", color: "var(--fg2)", alignSelf: "center" }}>學生練習版 · A4 · 可直接列印</span>
      </div>

      {withErrors.map(({ s, wrong }) => {
        const pr = practiceResults[s.student_name];
        return (
          <details key={s.student_name}>
            <summary>⚠️ {s.student_name}（答錯 {wrong.length} 題，得分率 {s.percentage?.toFixed(0)}%）</summary>
            <div className="inner">
              <button className="btn btn-primary btn-sm" disabled={practiceLoading === s.student_name} onClick={() => generatePractice(s.student_name, wrong, "weakness")}>
                {practiceLoading === s.student_name ? "⏳ 生成中…" : `🤖 生成 ${practiceNumQ} 道練習題`}
              </button>
              {pr && !pr.parse_error && (pr.practice_questions?.length || 0) > 0 && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={() => downloadHtmlFile(`數學弱點練習_${grade}_${s.student_name}_${formatChineseDate()}.html`, buildPracticeWorksheetHtml([{ studentName: s.student_name, result: pr }], grade))}
                >📄 下載練習工作紙 (HTML)</button>
              )}
              {pr && !pr.parse_error && (pr.practice_questions?.length || 0) > 0 && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={async () => {
                    try {
                      await downloadPracticeDocx([{ studentName: s.student_name, result: pr }], grade, `數學弱點練習_${grade}_${s.student_name}_${formatChineseDate()}.docx`);
                    } catch (e) { alert("DOCX 生成失敗：" + (e instanceof Error ? e.message : String(e))); }
                  }}
                >📝 下載 DOCX (含公式)</button>
              )}
              {pr && !pr.parse_error && <PracticeDisplay result={pr} />}
            </div>
          </details>
        );
      })}
      {perfect.map(({ s, all }) => {
        const pr = practiceResults[s.student_name];
        return (
          <details key={s.student_name}>
            <summary>🌟 {s.student_name}（全對，得分率 {s.percentage?.toFixed(0)}%）</summary>
            <div className="inner">
              <button className="btn btn-primary btn-sm" disabled={practiceLoading === s.student_name} onClick={() => generatePractice(s.student_name, [], "consolidation", all)}>
                {practiceLoading === s.student_name ? "⏳ 生成中…" : `🤖 生成鞏固延伸練習`}
              </button>
              {pr && !pr.parse_error && (pr.practice_questions?.length || 0) > 0 && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={() => downloadHtmlFile(`數學鞏固延伸練習_${grade}_${s.student_name}_${formatChineseDate()}.html`, buildPracticeWorksheetHtml([{ studentName: s.student_name, result: pr }], grade))}
                >📄 下載練習工作紙 (HTML)</button>
              )}
              {pr && !pr.parse_error && (pr.practice_questions?.length || 0) > 0 && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={async () => {
                    try {
                      await downloadPracticeDocx([{ studentName: s.student_name, result: pr }], grade, `數學鞏固延伸練習_${grade}_${s.student_name}_${formatChineseDate()}.docx`);
                    } catch (e) { alert("DOCX 生成失敗：" + (e instanceof Error ? e.message : String(e))); }
                  }}
                >📝 下載 DOCX (含公式)</button>
              )}
              {pr && !pr.parse_error && <PracticeDisplay result={pr} />}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function PracticeDisplay({ result }: { result: PracticeResult }) {
  return (
    <div style={{ marginTop: 12 }}>
      {result.weakness_summary && <div className="info-box">{result.weakness_summary}</div>}
      {(result.practice_questions || []).map(q => (
        <details key={q.question_number} open>
          <summary>第 {q.question_number} 題（{q.question_type}）— 針對：{q.targeted_weakness}</summary>
          <div className="inner">
            <p><strong>範疇：</strong>{q.strand}　|　<strong>主題：</strong>{q.topic}</p>
            <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}><strong>📖 題目：</strong>{q.question_text}</p>
            {q.hints && <p style={{ fontSize: "0.85rem", color: "var(--fg2)" }}>💡 提示：{q.hints}</p>}
            <details>
              <summary>🔑 查看答案及解題步驟</summary>
              <div className="inner">
                <p><strong>答案：</strong>{q.answer}</p>
                {q.solution_steps?.length > 0 && (<><p><strong>解題步驟：</strong></p>{q.solution_steps.map((s, i) => <div key={i}>{i + 1}. {s}</div>)}</>)}
                {q.explanation && <p style={{ fontSize: "0.85rem", color: "var(--fg2)", marginTop: 6 }}>📌 設計理由：{q.explanation}</p>}
              </div>
            </details>
          </div>
        </details>
      ))}
      {result.study_tips?.length > 0 && (<><h4 style={{ marginTop: 12 }}>📚 學習建議</h4>{result.study_tips.map((t, i) => <div key={i}>• {t}</div>)}</>)}
    </div>
  );
}
