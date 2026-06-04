"use client";
/* Result-view tab components, extracted from page.tsx. */
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, ResponsiveContainer, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar, ReferenceLine,
} from "recharts";
import type { StudentResult, ClassAggregated, ClassInsights, PracticeResult } from "@/lib/types";
import { LEVEL_COLORS, STRAND_COLORS } from "@/lib/grading";
import { buildPracticeWorksheetHtml, downloadHtmlFile, formatChineseDate } from "@/lib/report-html";
import { downloadPracticeDocx } from "@/lib/practice-docx";

export function TabOverview({ agg, insights }: { agg: ClassAggregated; insights: ClassInsights | null }) {
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
                {pieData.map((e) => <Cell key={e.name} fill={LEVEL_COLORS[e.name] || "#999"} />)}
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

export function TabRanking({ agg }: { agg: ClassAggregated }) {
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

export function TabAutoMarking({ agg }: { agg: ClassAggregated }) {
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

export function TabQuestionStats({ agg }: { agg: ClassAggregated }) {
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

export function TabHeatmap({ agg }: { agg: ClassAggregated }) {
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

export function TabWeakDiagnosis({ agg, insights }: { agg: ClassAggregated; insights: ClassInsights | null }) {
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

export function TabTeaching({ insights }: { insights: ClassInsights | null }) {
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

export function TabPractice({ agg, grade, practiceNumQ, setPracticeNumQ, practiceDiff, setPracticeDiff, practiceResults, practiceLoading, generatePractice, generateAllPractice, batchPracticeRunning, batchPracticeProgress }: {
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
