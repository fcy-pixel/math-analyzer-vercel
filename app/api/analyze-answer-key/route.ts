/* Analyze answer key images with Qwen Vision API */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "edge";
import { getGradeCurriculum } from "@/lib/curriculum";

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
    const { images, grade, apiKey } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });

    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
    const curriculum = getGradeCurriculum(grade);

    const systemMsg = "你是一位專業的香港小學數學教師，正在分析一份數學試卷的答案版（參考答案卷）。你熟悉香港課程發展議會《數學課程指引》（小一至六年級）2017 年修訂版，能將每道題目準確對應到相關課程範疇、學習目標及年級要求。";

    const batches: string[][] = [];
    for (let i = 0; i < images.length; i += BATCH_SIZE) batches.push(images.slice(i, i + BATCH_SIZE));
    const totalPages = images.length;

    const allQuestions: Record<string, unknown>[] = [];
    const rawResponses: string[] = [];

    // Process all batches in parallel for speed
    const batchResults = await Promise.all(batches.map(async (batch, i) => {
      const startP = i * BATCH_SIZE + 1;
      const endP = Math.min(startP + batch.length - 1, totalPages);
      const prompt = `請仔細閱讀這批試卷答案版頁面（第 ${startP}–${endP} 頁，共 ${totalPages} 頁的一部分）。

注意：這是試卷的**答案版（參考答案卷）**，不是學生作答卷。
請對這幾頁上的**每一道題目**進行分析，包括：
- 題目編號、題目內容的完整描述
- 題目考核的數學概念、課程範疇
- 正確答案或正確解題方法
- 題目分值（如標示）、難度評估

以**純 JSON** 格式回應：
{
  "questions_found": [
    {
      "question_ref": "題目編號",
      "topic": "考核主題",
      "strand": "課程範疇",
      "marks": null,
      "correct_answer": "正確答案",
      "solution_method": "解題方法描述"
    }
  ]
}`;

      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const b64 of batch) {
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
      const rawText = resp.choices[0].message.content || "";
      const parsed = parseJson(rawText);
      // Handle both { questions_found: [...] } and direct array formats
      let qs: Record<string, unknown>[] = [];
      if (Array.isArray((parsed as { questions_found?: unknown }).questions_found)) {
        qs = (parsed as { questions_found: Record<string, unknown>[] }).questions_found;
      } else if (Array.isArray(parsed)) {
        qs = parsed as Record<string, unknown>[];
      } else if ((parsed as { parse_error?: boolean }).parse_error) {
        const arrMatch = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrMatch) {
          try { qs = JSON.parse(arrMatch[0]); } catch {}
        }
      }
      return { qs, rawText: rawText.slice(0, 500) };
    }));

    for (const r of batchResults) {
      allQuestions.push(...r.qs);
      rawResponses.push(r.rawText);
    }

    // Simplify for schema
    const schema = allQuestions.map((q: Record<string, unknown>) => ({
      question_ref: q.question_ref || "",
      topic: q.topic || "",
      strand: q.strand || "",
      marks: q.marks ?? null,
      correct_answer: q.correct_answer || "",
      solution_method: q.solution_method || "",
    }));

    return NextResponse.json({
      question_schema: schema,
      total_questions: schema.length,
      ...(schema.length === 0 && { debug_raw: rawResponses }),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const maxDuration = 120;
