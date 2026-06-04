/* HTML export builders for the class report and the practice worksheets,
 * extracted from page.tsx. Pure string builders + a browser download helper. */
import type { ClassAggregated, ClassInsights, PracticeResult } from "@/lib/types";
import { levelClass, LEVEL_COLORS, LEVEL_ORDER } from "@/lib/grading";

/* ───────────── Practice worksheet HTML export ───────────── */
function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}
export function formatChineseDate(d = new Date()) {
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

export function buildPracticeWorksheetHtml(entries: { studentName: string; result: PracticeResult }[], grade: string): string {
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

export function downloadHtmlFile(filename: string, html: string) {
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

export function buildClassReportHtml(agg: ClassAggregated | null, insights: ClassInsights | null, grade: string, classLabel: string): string {
  const dateStr = formatChineseDate();
  if (!agg) {
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>數學分析報告</title></head><body style="font-family:system-ui;padding:40px;text-align:center;color:#666;"><p>暫無分析資料。</p></body></html>`;
  }
  const dist = agg.class_distribution || {};
  const distOrder = LEVEL_ORDER;
  const distColors = LEVEL_COLORS;
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
    const lv = levelClass(pctNum);
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
    const lv = levelClass(pctNum);
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
