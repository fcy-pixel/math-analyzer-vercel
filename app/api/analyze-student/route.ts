/* Analyze one student's exam paper via Qwen Vision API */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const VISION_MODEL = "qwen-vl-max";
const BATCH_SIZE = 6;

function parseJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); } catch {}
  const m1 = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m1) try { return JSON.parse(m1[1]); } catch {}
  const m2 = text.match(/(\{[\s\S]*\})/);
  if (m2) try { return JSON.parse(m2[1]); } catch {}
  return { raw_response: text, parse_error: true };
}

export async function POST(req: NextRequest) {
  try {
    const { images, questionSchema, grade, studentName, apiKey } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });

    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
    const nPages = images.length;
    const name = studentName || "學生";

    const systemMsg = `你是一位有豐富批改經驗的香港小學數學教師，熟悉香港課程發展議會《數學課程指引》（2017），擅長辨認學生的手寫答案及識別常見數學錯誤類型。
重要評分規則（必須嚴格遵守）：
(1) 假分數（improper fraction）必須直接給滿分。例如答案是 1 3/4，學生寫 7/4，直接給滿分，is_correct 設為 true。
(2) 帶分數與假分數互換一律正確：7/4 = 1 3/4、13/5 = 2 3/5，只要數值相等就給滿分。
(3) 絕對不可因為學生用假分數作答而扣分、標記錯誤或備註為非標準答案。`;

    const outSchema = `{"student_name":"...","total_marks_awarded":數字,"total_marks_possible":數字,"percentage":數字,"performance_level":"優秀(≥85%) / 良好(70-84%) / 一般(55-69%) / 需要改善(<55%)","question_results":[{"question_ref":"題號","topic":"考核主題","strand":"課程範疇","marks_possible":分值,"marks_awarded":得分,"is_correct":true/false,"student_answer":"學生作答","correct_answer":"正確答案","error_type":"概念性誤解/程序性錯誤/粗心大意/未作答/null","error_description":"錯誤描述或null"}],"overall_remarks":"簡短評語"}`;

    let prompt: string;
    if (questionSchema && questionSchema.length > 0) {
      prompt = `你正在批改 ${name} 的 ${grade} 年級數學試卷（共 ${nPages} 頁）。

本次試卷各題正確答案：
${JSON.stringify(questionSchema, null, 2)}

請仔細閱讀每頁學生作答，逐題：
1. 辨認學生答案（手寫可能字跡潦草，請盡力判讀）
2. 根據答案鍵評正
3. 如答錯，填寫error_type和error_description
4. 答案鍵內每題必須評分，找不到視為「未作答」
5. **假分數必須直接給滿分**

只輸出純JSON（不加markdown代碼塊）：
${outSchema}`;
    } else {
      prompt = `你正在批改 ${name} 的 ${grade} 年級數學試卷（共 ${nPages} 頁）。

沒有答案鍵，請：
1. 識別所有題目（包括子題(a)(b)(c)等）
2. 根據數學知識判斷學生的作答是否正確
3. 標注課程範疇（數與代數 / 度量 / 圖形與空間 / 數據處理）
4. 描述錯誤（如有），每題分值若題目未標示則估算1分
5. **假分數必須直接給滿分**

只輸出純JSON（不加markdown代碼塊）：
${outSchema}`;
    }

    // Single batch fast path
    if (images.length <= BATCH_SIZE) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const b64 of images) {
        const mime = b64.startsWith("/9j") ? "image/jpeg" : "image/png";
        content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
      }
      content.push({ type: "text", text: prompt });

      const resp = await client.chat.completions.create({
        model: VISION_MODEL,
        messages: [
          { role: "system" as const, content: systemMsg },
          { role: "user" as const, content: content as unknown as string },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      });
      const result = parseJson(resp.choices[0].message.content || "{}");
      (result as Record<string, unknown>).student_name = name;
      return NextResponse.json(result);
    }

    // Multi-batch
    const batches: string[][] = [];
    for (let i = 0; i < images.length; i += BATCH_SIZE) batches.push(images.slice(i, i + BATCH_SIZE));

    const allQResults: Record<string, unknown>[] = [];
    let totalAwarded = 0, totalPossible = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
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
        model: VISION_MODEL,
        messages: [
          { role: "system" as const, content: systemMsg },
          { role: "user" as const, content: content as unknown as string },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      });
      const parsed = parseJson(resp.choices[0].message.content || "{}") as Record<string, unknown>;
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
    if (!totalPossible) totalPossible = merged.reduce((s, q) => s + (Number(q.marks_possible) || 1), 0);
    if (!totalAwarded) totalAwarded = merged.reduce((s, q) => s + (Number(q.marks_awarded) || 0), 0);
    const pct = totalPossible ? Math.round(1000 * totalAwarded / totalPossible) / 10 : 0;
    const level = pct >= 85 ? "優秀(≥85%)" : pct >= 70 ? "良好(70-84%)" : pct >= 55 ? "一般(55-69%)" : "需要改善(<55%)";

    return NextResponse.json({
      student_name: name,
      total_marks_awarded: totalAwarded,
      total_marks_possible: totalPossible,
      percentage: pct,
      performance_level: level,
      question_results: merged,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, parse_error: true }, { status: 500 });
  }
}

export const maxDuration = 120;
