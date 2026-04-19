"use client";
import { useState, useRef, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ResponsiveContainer, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar, ReferenceLine,
} from "recharts";
import { aggregateStudentResults } from "@/lib/aggregate";
import type { StudentResult, ClassAggregated, ClassInsights, AnswerKeyQuestion, PracticeResult, QuestionStat } from "@/lib/types";

/* ───────────── PDF → base64 images (client-side, pdfjs-dist) ───────────── */
let pdfjsLib: typeof import("pdfjs-dist") | null = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${lib.version}/pdf.worker.min.mjs`;
  pdfjsLib = lib;
  return lib;
}
async function pdfToImages(file: File, scale = 1.5): Promise<string[]> {
  const lib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const images: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
    // Convert to JPEG for smaller size
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    images.push(dataUrl.split(",")[1]);
  }
  return images;
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

/* ───────────── PIE CHART COLORS ───────────── */
const PIE_COLORS: Record<string, string> = {
  "優秀(≥85%)": "#43a047",
  "良好(70-84%)": "#1e88e5",
  "一般(55-69%)": "#f9a825",
  "需要改善(<55%)": "#e53935",
};
const STRAND_COLORS = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFB74D", "#BA68C8"];

export default function MathAnalyzer() {
  // Config state
  const [apiKey, setApiKey] = useState("");
  const [grade, setGrade] = useState("P4");
  const [pagesPerStudent, setPagesPerStudent] = useState(4);
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

  const effectiveKey = apiKey || "";

  // Estimate student count
  const [totalPdfPages, setTotalPdfPages] = useState(0);
  const handleStudentPdf = useCallback(async (file: File) => {
    setStudentPdf(file);
    try {
      const lib = await loadPdfjs();
      const buf = await file.arrayBuffer();
      const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      setTotalPdfPages(doc.numPages);
    } catch { setTotalPdfPages(0); }
  }, []);

  const estStudents = totalPdfPages ? Math.ceil(totalPdfPages / pagesPerStudent) : 0;

  /* ───────────── MAIN ANALYSIS ───────────── */
  async function runAnalysis() {
    if (!studentPdf) return;
    setAnalyzing(true);
    setProgress(0);
    setStatusMsg("準備中…");
    setErrorLog([]);
    setAgg(null);
    setInsights(null);
    setPracticeResults({});

    try {
      // Step 1: Convert PDF to images
      setStatusMsg("✂️ 正在將試卷 PDF 轉換為圖片…");
      const allImages = await pdfToImages(studentPdf);
      setProgress(5);

      // Step 2: Optional answer key
      let questionSchema: AnswerKeyQuestion[] = [];
      if (answerKeyFile) {
        setStatusMsg("📋 正在分析答案鍵…");
        let keyImages: string[];
        if (answerKeyFile.type === "application/pdf") {
          keyImages = await pdfToImages(answerKeyFile);
        } else {
          keyImages = await imageToBase64(answerKeyFile);
        }
        const keyResp = await fetch("/api/analyze-answer-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: keyImages, grade, apiKey: effectiveKey }),
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
      const chunks: { index: number; images: string[]; name: string }[] = [];
      for (let i = 0; i < allImages.length; i += pagesPerStudent) {
        const idx = chunks.length;
        const name = studentNames[idx] || `學生${idx + 1}`;
        chunks.push({ index: idx + 1, images: allImages.slice(i, i + pagesPerStudent), name });
      }

      // Step 4: Analyze each student
      const allResults: StudentResult[] = [];
      const baseProgress = answerKeyFile ? 15 : 5;
      const progressPerStudent = (85 - baseProgress) / Math.max(chunks.length, 1);
      const errors: string[] = [];

      for (const chunk of chunks) {
        setStatusMsg(`🤖 正在批改 ${chunk.name} 的試卷（第 ${(chunk.index - 1) * pagesPerStudent + 1}–${Math.min(chunk.index * pagesPerStudent, allImages.length)} 頁）　${chunk.index}/${chunks.length}`);
        try {
          const resp = await fetch("/api/analyze-student", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              images: chunk.images,
              questionSchema,
              grade,
              studentName: chunk.name,
              apiKey: effectiveKey,
            }),
          });
          const result = await resp.json();
          result.student_name = chunk.name;
          result.student_index = chunk.index;
          allResults.push(result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${chunk.name}：${msg}`);
          allResults.push({ student_name: chunk.name, student_index: chunk.index, parse_error: true, error: msg } as StudentResult);
        }
        setProgress(Math.min(99, Math.round(baseProgress + chunk.index * progressPerStudent)));
      }

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
          body: JSON.stringify({ aggregated, grade, apiKey: effectiveKey }),
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
          apiKey: effectiveKey,
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

  /* ───────────── EXPORT JSON ───────────── */
  function exportJson() {
    if (!agg) return;
    const data = { aggregated: agg, insights, grade, notes: classLabel };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `math_analysis_${grade}_${classLabel || "class"}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        {/* API Key */}
        <div className="sidebar-key">
          <label>🔑 Qwen International API Key</label>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-...（留空則使用伺服器設定）" />
        </div>

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
              <h3 style={{ marginBottom: 8 }}>📋 答案鍵（可選）</h3>
              <div className={`upload-zone ${answerKeyFile ? "has-file" : ""}`} onClick={() => answerKeyRef.current?.click()}>
                <input ref={answerKeyRef} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => { if (e.target.files?.[0]) setAnswerKeyFile(e.target.files[0]); }} />
                {answerKeyFile ? `✅ ${answerKeyFile.name}` : "點擊選擇答案鍵（PDF/JPG/PNG）"}
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
          <button className="btn btn-primary" style={{ fontSize: "1.1rem", padding: "14px 40px" }} disabled={!studentPdf || analyzing} onClick={runAnalysis}>
            {analyzing ? "⏳ 分析中…" : "🔍 開始批改全班試卷"}
          </button>
        </div>

        {/* Progress */}
        {(analyzing || progress > 0) && (
          <div className="card">
            <div className="progress-bar"><div className="fill" style={{ width: `${progress}%` }} /></div>
            <div style={{ fontSize: "0.9rem", marginTop: 6 }}>{statusMsg}</div>
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
              />
            )}
            {/* Tab 8: Export */}
            {activeTab === 8 && (
              <div className="card">
                <h3>📥 匯出分析報告</h3>
                <p style={{ margin: "10px 0", fontSize: "0.9rem", color: "var(--fg2)" }}>下載 JSON 原始資料，可匯入其他系統進一步分析。</p>
                <button className="btn btn-primary" onClick={exportJson}>📥 下載 JSON 資料</button>
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

function TabPractice({ agg, grade, practiceNumQ, setPracticeNumQ, practiceDiff, setPracticeDiff, practiceResults, practiceLoading, generatePractice }: {
  agg: ClassAggregated; grade: string; practiceNumQ: number; setPracticeNumQ: (n: number) => void;
  practiceDiff: string; setPracticeDiff: (d: string) => void;
  practiceResults: Record<string, PracticeResult>; practiceLoading: string | null;
  generatePractice: (name: string, weak: Record<string, unknown>[], type: string, all?: Record<string, unknown>[]) => void;
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

      {withErrors.map(({ s, wrong }) => {
        const pr = practiceResults[s.student_name];
        return (
          <details key={s.student_name}>
            <summary>⚠️ {s.student_name}（答錯 {wrong.length} 題，得分率 {s.percentage?.toFixed(0)}%）</summary>
            <div className="inner">
              <button className="btn btn-primary btn-sm" disabled={practiceLoading === s.student_name} onClick={() => generatePractice(s.student_name, wrong, "weakness")}>
                {practiceLoading === s.student_name ? "⏳ 生成中…" : `🤖 生成 ${practiceNumQ} 道練習題`}
              </button>
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
