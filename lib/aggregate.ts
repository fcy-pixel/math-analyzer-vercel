/* Pure-JS aggregation — mirrors analyzer.py aggregate_student_results */
import type { StudentResult, ClassAggregated, QuestionStat, StrandStat } from "./types";

function naturalSortKey(s: string): (string | number)[] {
  return s.split(/(\d+)/).map(c => (/^\d+$/.test(c) ? parseInt(c) : c.toLowerCase()));
}
function cmpNatural(a: string, b: string) {
  const ka = naturalSortKey(a), kb = naturalSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] ?? "", vb = kb[i] ?? "";
    if (typeof va === "number" && typeof vb === "number") { if (va !== vb) return va - vb; }
    else { const c = String(va).localeCompare(String(vb)); if (c !== 0) return c; }
  }
  return 0;
}

export function aggregateStudentResults(
  allResults: StudentResult[],
  expectedQuestions?: string[],
): ClassAggregated {
  const nTotal = allResults.length;
  const valid = allResults.filter(r => !r.parse_error && r.question_results?.length);
  const nValid = valid.length;
  if (!valid.length) return { total_students: nTotal, valid_students: 0, class_average: 0, class_distribution: {}, student_results: allResults, question_stats: [], strand_stats: [], weak_questions: [], student_ranking: [], error: "沒有有效的學生分析結果" };

  const pcts = valid.map(r => r.percentage ?? 0);
  const classAvg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const dist: Record<string, number> = { "優秀(≥85%)": 0, "良好(70-84%)": 0, "一般(55-69%)": 0, "需要改善(<55%)": 0 };
  for (const p of pcts) {
    if (p >= 85) dist["優秀(≥85%)"]++;
    else if (p >= 70) dist["良好(70-84%)"]++;
    else if (p >= 55) dist["一般(55-69%)"]++;
    else dist["需要改善(<55%)"]++;
  }

  const qData: Record<string, { topic: string; strand: string; marks_possible: number; correct: number; marks_awarded: number[]; errors: string[] }> = {};
  if (expectedQuestions) {
    for (const ref of expectedQuestions) {
      qData[ref] = { topic: "", strand: "", marks_possible: 1, correct: 0, marks_awarded: [], errors: [] };
    }
  }
  for (const st of valid) {
    for (const q of (st.question_results || [])) {
      const ref = String(q.question_ref || "").trim();
      if (!ref) continue;
      if (!qData[ref]) qData[ref] = { topic: q.topic || "", strand: q.strand || "", marks_possible: q.marks_possible || 1, correct: 0, marks_awarded: [], errors: [] };
      const d = qData[ref];
      if (!d.topic && q.topic) d.topic = q.topic;
      if (!d.strand && q.strand) d.strand = q.strand;
      if (q.is_correct) d.correct++;
      if (q.marks_awarded != null) d.marks_awarded.push(Number(q.marks_awarded) || 0);
      if (q.error_description && q.error_description !== "null") d.errors.push(String(q.error_description));
    }
  }

  const questionStats: QuestionStat[] = Object.entries(qData).map(([ref, d]) => {
    const rate = nValid ? Math.round(100 * d.correct / nValid) : 0;
    const avgMarks = d.marks_awarded.length ? Math.round(10 * d.marks_awarded.reduce((a, b) => a + b, 0) / d.marks_awarded.length) / 10 : null;
    const seen = new Set<string>();
    const errs: string[] = [];
    for (const e of d.errors) { const k = e.slice(0, 40); if (!seen.has(k)) { seen.add(k); errs.push(e); if (errs.length >= 3) break; } }
    return { question_ref: ref, topic: d.topic, strand: d.strand, marks_possible: d.marks_possible, class_correct_count: d.correct, class_correct_rate: rate, class_average_marks: avgMarks, common_errors: errs };
  });

  if (expectedQuestions) {
    const order: Record<string, number> = {};
    expectedQuestions.forEach((r, i) => { order[r] = i; });
    questionStats.sort((a, b) => (order[a.question_ref] ?? 9999) - (order[b.question_ref] ?? 9999));
  } else {
    questionStats.sort((a, b) => cmpNatural(a.question_ref, b.question_ref));
  }

  // Strand stats
  const sData: Record<string, { rates: number[]; questions: string[] }> = {};
  for (const q of questionStats) {
    const s = (q.strand || "其他").trim();
    if (!sData[s]) sData[s] = { rates: [], questions: [] };
    sData[s].rates.push(q.class_correct_rate);
    sData[s].questions.push(q.question_ref);
  }
  const strandStats: StrandStat[] = Object.entries(sData).map(([s, d]) => {
    const avg = d.rates.length ? Math.round(d.rates.reduce((a, b) => a + b, 0) / d.rates.length) : 0;
    return { strand: s, class_average_rate: avg, questions: d.questions, status: avg < 60 ? "弱項" : avg < 75 ? "一般" : "強項" };
  }).sort((a, b) => a.class_average_rate - b.class_average_rate);

  // Weak questions
  const weakQs = questionStats.filter(q => q.class_correct_rate < 60).sort((a, b) => a.class_correct_rate - b.class_correct_rate);
  weakQs.forEach((q, i) => { q.rank = i + 1; });

  // Student ranking
  const ranking = allResults.map(s => ({
    student_name: s.student_name || "",
    percentage: s.parse_error ? 0 : (s.percentage ?? 0),
    total_marks_awarded: s.parse_error ? "—" : (s.total_marks_awarded ?? 0),
    total_marks_possible: s.parse_error ? "—" : (s.total_marks_possible ?? 0),
    performance_level: s.parse_error ? "分析失敗" : (s.performance_level || ""),
    rank: 0,
  })).sort((a, b) => (b.percentage as number) - (a.percentage as number));
  ranking.forEach((s, i) => { s.rank = i + 1; });

  return {
    total_students: nTotal, valid_students: nValid,
    class_average: Math.round(classAvg * 10) / 10,
    class_distribution: dist,
    student_results: allResults,
    question_stats: questionStats,
    strand_stats: strandStats,
    weak_questions: weakQs,
    student_ranking: ranking,
  };
}
