/* Analyze one student's exam paper via Qwen Vision API */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "edge";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const VISION_MODEL = "qwen-vl-max";
const BATCH_SIZE = 6;

function parseJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); } catch {}
  const m1 = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m1) try { return JSON.parse(m1[1]); } catch {}
  const m2 = text.match(/(\{[\s\S]*\})/);
  if (m2) try { return JSON.parse(m2[1]); } catch {}
  // Last-resort repair for truncated output: keep complete question objects only.
  try {
    const start = text.indexOf("{");
    if (start >= 0) {
      const head = text.slice(start);
      const arrIdx = head.indexOf("\"question_results\"");
      if (arrIdx >= 0) {
        const bracket = head.indexOf("[", arrIdx);
        if (bracket >= 0) {
          let depth = 0; let inStr = false; let esc = false; let lastGood = -1;
          for (let i = bracket + 1; i < head.length; i++) {
            const ch = head[i];
            if (esc) { esc = false; continue; }
            if (ch === "\\") { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) lastGood = i; }
            else if (ch === "]" && depth === 0) { lastGood = i - 1; break; }
          }
          if (lastGood > bracket) {
            const repaired = head.slice(0, lastGood + 1) + "]}";
            try {
              const obj = JSON.parse(repaired) as Record<string, unknown>;
              (obj as Record<string, unknown>)._repaired = true;
              return obj;
            } catch {}
          }
        }
      }
    }
  } catch {}
  return { raw_response: text.slice(0, 500), parse_error: true };
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
(1) 試卷上可能有算草、直式運算、塗改痕跡或草稿區，請完全忽略，只看學生寫在「答」「Ans」「填空」或最後答案欄位的最終答案。
(2) 帶分數（mixed number）與假分數（improper fraction）都可以作為最終答案，只要約至最簡分數即視為正確。例如：1 3/4 = 7/4、13/5 = 2 3/5，數值相等且已最簡，直接給滿分，is_correct 設為 true。
(3) 絕對不可因為學生用假分數或帶分數作答而扣分、標記錯誤或備註為非標準答案。
(4) 如學生在該題答案欄完全留空、沒有任何作答，必須將 student_answer 設為 ""（空字串），error_type 設為 "未作答"，error_description 寫「學生沒有作答」。
(5) 嚴禁自行猜測或填上任何代答字（不可自行寫一個答案再扣分），留空就是「沒有作答」。`;

    const outSchema = `{"student_name":"...","total_marks_awarded":數字,"total_marks_possible":數字,"percentage":數字,"performance_level":"優秀(≥85%) / 良好(70-84%) / 一般(55-69%) / 需要改善(<55%)","question_results":[{"question_ref":"題號","topic":"考核主題","strand":"課程範疇","question_type":"純計算題/文字應用題/填充題/選擇題/判斷題/作圖題/其他","marks_possible":分值,"marks_awarded":得分,"is_correct":true/false,"student_answer":"學生作答","correct_answer":"正確答案","error_type":"概念性誤解/程序性錯誤/粗心大意/未作答/null","error_description":"錯誤描述或null"}],"overall_remarks":"簡短評語"}`;

    if (!questionSchema || questionSchema.length === 0) {
      return NextResponse.json({ error: "缺少答案鍵：必須先上傳答案鍵才能批改。" }, { status: 400 });
    }

    const prompt = `批改 ${name}（${grade}，共 ${nPages} 頁）。

答案鍵：
${JSON.stringify(questionSchema, null, 2)}

規則：
1. 只看學生寫在答案欄的最終答案，忽略算草、直式運算、塗改。
2. 與答案鍵比對給分；答對 is_correct=true 滿分；答錯填 error_type 和 error_description。
3. 帶分數與假分數只要約至最簡且數值相等即視為正確。
4. 答案欄留空：student_answer="", error_type="未作答", error_description="學生沒有作答"，絕不自行作答。
5. 答案鍵每題都必須出現於 question_results；question_type 從題目文字判斷（純計算題 / 文字應用題 / 填充題 / 選擇題 等）。
6. topic 與 strand 直接沿用答案鍵內容。

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
        model: VISION_MODEL,
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
