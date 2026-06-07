"use client";
import { useState, useRef, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { aggregateStudentResults } from "@/lib/aggregate";
import type { StudentResult, ClassAggregated, ClassInsights, AnswerKeyQuestion, PracticeResult } from "@/lib/types";
import { performanceLevel } from "@/lib/grading";
import {
  type RenderMode, type StudentProgressItem, STUDENT_STATUS_LABELS,
  loadPdfDocument, pdfToImages, imageToBase64, renderPdfPagesToImages,
  approxBase64Mb, shrinkImagesToFit, splitImagesByBudget,
} from "@/lib/pdf";
import { buildClassReportHtml, downloadHtmlFile, formatChineseDate } from "@/lib/report-html";
import {
  TabOverview, TabRanking, TabAutoMarking, TabQuestionStats, TabHeatmap,
  TabWeakDiagnosis, TabTeaching, TabPractice,
} from "@/app/components/tabs";

const DEFAULT_VISION_MODEL = "qwen-vl-plus";


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
  // Actual model name reported by the API (kept in sync automatically).
  const [modelName, setModelName] = useState(DEFAULT_VISION_MODEL);

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
      alert("請先上傳答案鍵。系統需要答案鍵作準確、快速的批改。");
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
        if (!keyResp.ok || keyData.error) {
          throw new Error(`答案鍵分析失敗：${keyData.error || `HTTP ${keyResp.status}`}`);
        }
        if (keyData.question_schema && keyData.question_schema.length > 0) {
          questionSchema = keyData.question_schema;
          setStatusMsg(`✅ 已從答案鍵識別 ${questionSchema.length} 題`);
        } else {
          const debugInfo = keyData.debug_raw ? `\n\nAI 回應（除錯）：${keyData.debug_raw.join(" | ")}` : "";
          throw new Error(`答案鍵分析完成，但未能識別出任何題目。AI 可能無法讀取圖片，請嘗試：\n1. 確認上傳的是答案版（有正確答案的那份）\n2. 切換到「精確」渲染模式後重試\n3. 若上傳的是圖片檔，請確保清晰度足夠${debugInfo}`);
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
      const STUDENT_CONCURRENCY = 8;
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
          // Reflect the model the server actually used (avoids a hardcoded label).
          const reportedModel = subResults.find(r => typeof r._model === "string")?._model;
          if (reportedModel) setModelName(String(reportedModel));

          stage = "merge";
          // Merge question_results across sub-batches; dedupe by question_ref.
          const seen: Record<string, Record<string, unknown>> = {};
          let repaired = false; let parseErr = false;
          let firstError: string | undefined;
          for (const r of subResults) {
            if (r._repaired) repaired = true;
            if (r.parse_error) { parseErr = true; firstError = firstError || (r.error as string) || (r.raw_response as string)?.slice(0, 120); continue; }
            const qr = (r.question_results as Record<string, unknown>[]) || [];
            for (const q of qr) seen[String(q.question_ref || Math.random())] = q;
          }
          if (!Object.keys(seen).length && parseErr) {
            throw new Error(`AI 回傳未能解析：${firstError || "未知"}`);
          }
          // Fill any answer-key question the AI missed as 未作答 so every student
          // is scored out of the same total (consistent denominator across class).
          for (const sq of questionSchema) {
            const ref = String(sq.question_ref || "").trim();
            if (!ref || seen[ref]) continue;
            const rawMarks = Number(sq.marks);
            const possible = Number.isFinite(rawMarks) && rawMarks > 0 ? rawMarks : 1;
            seen[ref] = {
              question_ref: ref,
              topic: sq.topic || "",
              strand: sq.strand || "",
              marks_possible: possible,
              marks_awarded: 0,
              is_correct: false,
              student_answer: "",
              correct_answer: sq.correct_answer || "",
              error_type: "未作答",
              error_description: "學生沒有作答（或 AI 未能在試卷找到此題）",
            };
          }
          const merged = Object.values(seen);
          // Recompute totals authoritatively from the merged per-question marks.
          const totalPossible = Math.round(merged.reduce((s, q) => s + (Number(q.marks_possible) || 1), 0) * 10) / 10;
          const totalAwarded = Math.round(merged.reduce((s, q) => s + (Number(q.marks_awarded) || 0), 0) * 10) / 10;
          const pct = totalPossible ? Math.round(1000 * totalAwarded / totalPossible) / 10 : 0;
          const level = performanceLevel(pct);

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
          <p style={{ fontSize: "0.78rem", marginTop: 4, opacity: 0.75 }}>🤖 AI 模型：<strong>{modelName}</strong>（阿里雲 Qwen 視覺模型）</p>
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
                {answerKeyFile ? `✅ ${answerKeyFile.name}` : "點擊選擇答案鍵（PDF/JPG/PNG）— 必填，用於準確快速批改"}
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

