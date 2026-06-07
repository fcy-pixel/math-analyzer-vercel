/* Analyze one student's exam paper via Qwen Vision API */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { parseJson as parseJsonBase, repairTruncatedQuestionResults } from "@/lib/json-parse";
import { performanceLevel } from "@/lib/grading";
import { requireAuth } from "@/lib/auth";

export const runtime = "edge";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const VISION_MODEL = "qwen-vl-plus";
const BATCH_SIZE = 2;

/** Parse a student-grading reply, with a last-resort repair for output that was
 * truncated mid `question_results` array. */
function parseJson(text: string): Record<string, unknown> {
  const parsed = parseJsonBase(text);
  if (!parsed.parse_error) return parsed;
  return repairTruncatedQuestionResults(text) ?? parsed;
}

type SchemaEntry = { marks: number | null; topic: string; strand: string; correct_answer: string };

function buildSchemaMap(questionSchema: Record<string, unknown>[]): Record<string, SchemaEntry> {
  const map: Record<string, SchemaEntry> = {};
  for (const q of questionSchema || []) {
    const ref = String(q.question_ref ?? "").trim();
    if (!ref) continue;
    const rawMarks = Number(q.marks);
    map[ref] = {
      marks: Number.isFinite(rawMarks) && rawMarks > 0 ? rawMarks : null,
      topic: String(q.topic ?? ""),
      strand: String(q.strand ?? ""),
      correct_answer: String(q.correct_answer ?? ""),
    };
  }
  return map;
}

/**
 * Parse a math answer string into a numeric value for comparison.
 * Handles integers, decimals, fractions "a/b", and mixed numbers "1 3/4" / "1又3/4".
 * Returns null if it cannot be interpreted as a single number.
 */
function answerToNumber(raw: unknown): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Normalize: strip common units/labels, full-width chars, and mixed-number connectors.
  s = s
    .replace(/[＝=]/g, "")
    .replace(/又/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[，,]/g, "")
    .trim();
  // Drop a trailing unit word (e.g. "元", "cm", "個") after the number.
  const numPart = s.match(/^[-+]?[\d./\s]+/);
  if (numPart) s = numPart[0].trim();
  // Mixed number: "1 3/4"
  const mixed = s.match(/^([-+]?\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = parseInt(mixed[1], 10);
    const num = parseInt(mixed[2], 10);
    const den = parseInt(mixed[3], 10);
    if (den === 0) return null;
    const sign = whole < 0 ? -1 : 1;
    return whole + sign * (num / den);
  }
  // Simple fraction: "a/b"
  const frac = s.match(/^([-+]?\d+)\/(\d+)$/);
  if (frac) {
    const den = parseInt(frac[2], 10);
    if (den === 0) return null;
    return parseInt(frac[1], 10) / den;
  }
  // Plain integer or decimal
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

/** True if two answer strings represent the same numeric value (handles fractions). */
function answersEqual(a: unknown, b: unknown): boolean {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const na = answerToNumber(a);
  const nb = answerToNumber(b);
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 1e-9;
}

// Phrases the model uses when it concludes (often mid-reasoning) that the
// student's answer is actually correct, even though it set is_correct=false.
const STUDENT_CORRECT_MARKERS = [
  "答對", "其實正確", "應為正確", "計算正確", "數值正確",
  "答案正確", "學生正確", "結果正確", "是正確的", "正確無誤",
];

/**
 * Detect a self-contradicting error note: the model wrote a "student is correct"
 * phrase AND mentioned a number equal to the student's answer. Used to override
 * the model when its structured correct_answer field still holds an earlier
 * (wrong) value while the prose admits the student is right.
 */
function descAdmitsCorrect(desc: unknown, studentAnswer: unknown): boolean {
  const text = String(desc ?? "");
  if (!text) return false;
  if (!STUDENT_CORRECT_MARKERS.some((m) => text.includes(m))) return false;
  const sn = answerToNumber(studentAnswer);
  if (sn == null) return false;
  const tokens = text.match(/-?\d+\s+\d+\/\d+|-?\d+\/\d+|-?\d+(?:\.\d+)?/g) || [];
  for (const t of tokens) {
    const n = answerToNumber(t);
    if (n != null && Math.abs(n - sn) < 1e-9) return true;
  }
  return false;
}

/**
 * Make grading consistent across students: rescale each question's marks to the
 * answer key's authoritative `marks` value (proportional to the model's score),
 * fall back to schema topic/strand/correct_answer, and recompute totals from the
 * normalized per-question marks (model-reported totals can be wrong or truncated).
 */
function normalizeResults(
  questionResults: Record<string, unknown>[],
  schemaMap: Record<string, SchemaEntry>,
): { results: Record<string, unknown>[]; totalAwarded: number; totalPossible: number } {
  let totalAwarded = 0;
  let totalPossible = 0;
  const results = (questionResults || []).map((q) => {
    const ref = String(q.question_ref ?? "").trim();
    const schema = schemaMap[ref];
    const modelPossible = Number(q.marks_possible);
    const modelAwarded = Number(q.marks_awarded);
    // Ratio of marks earned according to the model (0..1).
    let ratio: number;
    if (Number.isFinite(modelPossible) && modelPossible > 0 && Number.isFinite(modelAwarded)) {
      ratio = Math.max(0, Math.min(1, modelAwarded / modelPossible));
    } else {
      ratio = q.is_correct === true ? 1 : 0;
    }
    const possible = schema?.marks ?? (Number.isFinite(modelPossible) && modelPossible > 0 ? modelPossible : 1);
    let correctAnswer = String(q.correct_answer || schema?.correct_answer || "");
    const studentAnswer = q.student_answer;
    // Objective override: if the student's final answer numerically equals the
    // correct answer, force full marks — models sometimes contradict themselves
    // (mark wrong while their own note says it is correct).
    if (answersEqual(studentAnswer, correctAnswer)) {
      ratio = 1;
    } else if (descAdmitsCorrect(q.error_description, studentAnswer)) {
      // The model's prose admits the student is right but its correct_answer
      // field kept an earlier wrong value — trust the student's answer.
      ratio = 1;
      const sa = String(studentAnswer ?? "").trim();
      if (sa) correctAnswer = sa;
    }
    const awarded = Math.round(ratio * possible * 10) / 10;
    totalAwarded += awarded;
    totalPossible += possible;
    const isCorrect = possible > 0 ? awarded >= possible : ratio >= 1;
    return {
      ...q,
      marks_possible: possible,
      marks_awarded: awarded,
      is_correct: isCorrect,
      error_type: isCorrect ? null : (q.error_type ?? null),
      error_description: isCorrect ? null : (q.error_description ?? null),
      topic: q.topic || schema?.topic || "",
      strand: q.strand || schema?.strand || "",
      correct_answer: correctAnswer,
    };
  });
  return { results, totalAwarded: Math.round(totalAwarded * 10) / 10, totalPossible: Math.round(totalPossible * 10) / 10 };
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  try {
    const { images, questionSchema, grade, studentName, apiKey, model } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    const visionModel = (typeof model === "string" && model.trim()) ? model.trim() : VISION_MODEL;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });

    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
    const nPages = images.length;
    const name = studentName || "學生";

    const systemMsg = `你是一位有豐富批改經驗的香港小學數學教師，熟悉香港課程發展議會《數學課程指引》（2017），擅長辨認學生的手寫答案及識別常見數學錯誤類型。
重要評分規則（必須嚴格遵守）：
(1) 試卷上可能有算草、直式運算、塗改痕跡或草稿區，請完全忽略，只看學生寫在「答」「Ans」「填空」或最後答案欄位的最終答案。
(2) 帶分數（mixed number）與假分數（improper fraction）都可以作為最終答案，只要約至最簡分數即視為正確。例如：1 3/4 = 7/4、13/5 = 2 3/5，數值相等且已最簡，直接給滿分，is_correct 設為 true。
(3) 絕對不可因為學生用假分數或帶分數作答而扣分、標記錯誤或備註為非標準答案。
(4) 如學生在該題答案欄完全留空、沒有任何作答，必須將 student_answer 設為 ""（空字串），error_type 設為 "未作答"，error_description 寫「學生沒有作答」。
(5) 嚴禁自行猜測或填上任何代答字（不可自行寫一個答案再扣分），留空就是「沒有作答」。`;

    const outSchema = `{"student_name":"...","total_marks_awarded":數字,"total_marks_possible":數字,"percentage":數字,"performance_level":"優秀(≥85%) / 良好(70-84%) / 一般(55-69%) / 需要改善(<55%)","question_results":[{"question_ref":"題號","topic":"考核主題","strand":"課程範疇","question_type":"純計算題/文字應用題/填充題/選擇題/判斷題/作圖題/其他","marks_possible":分值,"marks_awarded":得分,"is_correct":true/false,"student_answer":"學生作答","correct_answer":"正確答案","error_type":"概念性誤解/程序性錯誤/粗心大意/未作答/null","error_description":"錯誤描述或null"}],"overall_remarks":"簡短評語"}`;

    const hasSchema = Array.isArray(questionSchema) && questionSchema.length > 0;
    const schemaMap = hasSchema ? buildSchemaMap(questionSchema as Record<string, unknown>[]) : {};

    const prompt = hasSchema
      ? `批改 ${name}（${grade}，共 ${nPages} 頁）。

答案鍵：
${JSON.stringify(questionSchema, null, 2)}

規則：
1. 只看學生寫在答案欄的最終答案，忽略算草、直式運算、塗改。
2. 與答案鍵比對給分；答對 is_correct=true 滿分；答錯填 error_type 和 error_description。
3. 帶分數與假分數只要約至最簡且數值相等即視為正確。
4. 答案欄留空：student_answer="", error_type="未作答", error_description="學生沒有作答"，絕不自行作答。
5. 答案鍵每題都必須出現於 question_results；question_type 從題目文字判斷（純計算題 / 文字應用題 / 填充題 / 選擇題 等）。
6. topic 與 strand 直接沿用答案鍵內容。
7. marks_possible 必須採用答案鍵 marks 欄的數值（若該題 marks 不是 null）；marks_awarded 不可超過 marks_possible。
8. 所有文字一律用純文字，分數寫成「3/4」「1 又 3/4」格式，嚴禁使用 LaTeX 或任何反斜線（\\）符號，以免破壞 JSON。
9. 重要：student_answer 與 correct_answer 數值相等（例如 1/8 = 1/8、7/4 = 1 又 3/4）時，必須 is_correct=true 並給滿分，error_type=null、error_description=null。嚴禁一邊判錯一邊在說明寫「其實正確」，is_correct 與得分必須與最終答案一致。
10. correct_answer 欄必須填入你最終、已驗算的正確答案；先在心中算完再填，不可在 error_description 內推翻 correct_answer。若 error_description 結論是學生答對，就必須 is_correct=true、給滿分、清空 error。

只輸出純JSON：
${outSchema}`
      : `批改 ${name}（${grade}，共 ${nPages} 頁）。本次沒有提供答案鍵，請你自行計算每題的正確答案再批改。

規則：
1. 先讀清楚每一道題目，自行計算正確答案（correct_answer），再與學生答案欄的最終答案比較。
2. 只看學生寫在答案欄的最終答案，忽略算草、直式運算、塗改。
3. 答對 is_correct=true 給滿分；答錯 is_correct=false，填 error_type 和 error_description。
4. 帶分數與假分數只要約至最簡且數值相等即視為正確。
5. 答案欄留空：student_answer="", error_type="未作答", error_description="學生沒有作答"，絕不自行替學生作答。
6. 每一道在試卷上出現的題目都要列入 question_results；question_ref 用試卷上的題號；question_type 從題目判斷。
7. marks_possible 按題目標示的分值；若試卷沒有標分，每題一律設為 1 分。
8. topic 與 strand 按香港小學數學課程自行判斷填寫。
9. 所有文字一律用純文字，分數寫成「3/4」「1 又 3/4」格式，嚴禁使用 LaTeX 或任何反斜線（\\）符號，以免破壞 JSON。
10. 重要：student_answer 與 correct_answer 數值相等（例如 1/8 = 1/8、7/4 = 1 又 3/4）時，必須 is_correct=true 並給滿分，error_type=null、error_description=null。嚴禁一邊判錯一邊在說明寫「其實正確」，is_correct 與得分必須與最終答案一致。
11. 計算 correct_answer 時必須一步步驗算後再填入最終答案；不可在 error_description 內推翻 correct_answer。若 error_description 結論是學生答對，就必須 is_correct=true、給滿分、清空 error。

只輸出純JSON：
${outSchema}`;

    // Single batch fast path
    if (images.length <= BATCH_SIZE) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const b64 of images) {
        const mime = b64.startsWith("/9j") ? "image/jpeg" : "image/png";
        content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
      }
      content.push({ type: "text", text: prompt });

      const resp = await client.chat.completions.create({
        model: visionModel,
        messages: [
          { role: "system" as const, content: systemMsg },
          { role: "user" as const, content: content as unknown as string },
        ],
        temperature: 0.2,
        max_tokens: 8192,
      });
      const result = parseJson(resp.choices[0].message.content || "{}");
      (result as Record<string, unknown>).student_name = name;
      if (!result.parse_error && Array.isArray(result.question_results)) {
        const norm = normalizeResults(result.question_results as Record<string, unknown>[], schemaMap);
        result.question_results = norm.results;
        result.total_marks_awarded = norm.totalAwarded;
        result.total_marks_possible = norm.totalPossible;
        result.percentage = norm.totalPossible ? Math.round(1000 * norm.totalAwarded / norm.totalPossible) / 10 : 0;
        result.performance_level = performanceLevel(result.percentage as number);
      }
      (result as Record<string, unknown>)._model = visionModel;
      return NextResponse.json(result);
    }

    // Multi-batch (parallel)
    const batches: string[][] = [];
    for (let i = 0; i < images.length; i += BATCH_SIZE) batches.push(images.slice(i, i + BATCH_SIZE));

    const batchResults = await Promise.all(batches.map(async (batch, i) => {
      const startP = i * BATCH_SIZE + 1;
      const endP = Math.min(startP + batch.length - 1, nPages);
      const batchPrompt = prompt + `\n\n【你正在分析第 ${startP}–${endP} 頁，共 ${nPages} 頁，本批次只包含此頁範圍內的題目，請勿遺漏任何一題】`;

      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const b64 of batch) {
        const mime = b64.startsWith("/9j") ? "image/jpeg" : "image/png";
        content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
      }
      content.push({ type: "text", text: batchPrompt });

      const resp = await client.chat.completions.create({
        model: visionModel,
        messages: [
          { role: "system" as const, content: systemMsg },
          { role: "user" as const, content: content as unknown as string },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      });
      return parseJson(resp.choices[0].message.content || "{}") as Record<string, unknown>;
    }));

    const allQResults: Record<string, unknown>[] = [];
    let totalAwarded = 0, totalPossible = 0;
    for (const parsed of batchResults) {
      if (!parsed.parse_error) {
        const qr = (parsed.question_results as Record<string, unknown>[]) || [];
        allQResults.push(...qr);
        totalAwarded += Number(parsed.total_marks_awarded) || 0;
        totalPossible += Number(parsed.total_marks_possible) || 0;
      }
    }

    // Deduplicate
    const seen: Record<string, Record<string, unknown>> = {};
    for (const q of allQResults) seen[String(q.question_ref || "")] = q;
    const merged = Object.values(seen);
    const norm = normalizeResults(merged, schemaMap);
    totalAwarded = norm.totalAwarded;
    totalPossible = norm.totalPossible;
    const pct = totalPossible ? Math.round(1000 * totalAwarded / totalPossible) / 10 : 0;

    return NextResponse.json({
      student_name: name,
      total_marks_awarded: totalAwarded,
      total_marks_possible: totalPossible,
      percentage: pct,
      performance_level: performanceLevel(pct),
      question_results: norm.results,
      _model: visionModel,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, parse_error: true }, { status: 500 });
  }
}

export const maxDuration = 120;
