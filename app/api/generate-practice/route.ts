/* Generate practice questions for a student */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getGradeCurriculum } from "@/lib/curriculum";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TEXT_MODEL = "qwen-max";

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
    const { studentName, grade, weakQuestions, numQuestions, difficulty, genType, allQuestions, apiKey } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });

    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
    const curriculum = getGradeCurriculum(grade);

    let prompt: string;
    let sysMsg: string;

    if (genType === "consolidation") {
      prompt = `你是一位經驗豐富的香港小學數學科老師，正在為 ${grade} 年級全部答對的優秀學生 ${studentName} 設計鞏固及延伸練習題。

以下是該學生在測驗中全部答對的題目：
${JSON.stringify(allQuestions || [], null, 2)}

香港 ${grade} 年級數學課程綱要：
${curriculum}

請為其設計 ${numQuestions || 5} 道鞏固延伸練習題，要求：
1. 針對學生已掌握的範疇，但提高難度或變換題型
2. 包含高階思維題和跨範疇綜合應用題
3. 題目難度：進階
4. 每道題附有詳細解題步驟和答案

只輸出純JSON：
{
  "student_name": "${studentName}",
  "grade": "${grade}",
  "weakness_summary": "該學生已全部答對，以下為鞏固延伸練習",
  "practice_questions": [
    {
      "question_number": 1,
      "targeted_weakness": "鞏固範疇",
      "strand": "課程範疇",
      "topic": "具體主題",
      "question_type": "題目類型",
      "question_text": "完整題目文字",
      "hints": "",
      "solution_steps": ["步驟1", "步驟2"],
      "answer": "正確答案",
      "explanation": "設計理由"
    }
  ],
  "study_tips": ["建議1", "建議2"]
}`;
      sysMsg = "你是資深香港小學數學教師，精通因材施教、為優秀學生設計鞏固延伸練習題。";
    } else {
      prompt = `你是一位經驗豐富的香港小學數學科老師，正在為 ${grade} 年級的學生 ${studentName} 設計針對性練習題。

以下是該學生在測驗中答錯的題目：
${JSON.stringify(weakQuestions || [], null, 2)}

香港 ${grade} 年級數學課程綱要：
${curriculum}

請根據該學生的弱點，生成 ${numQuestions || 5} 道針對性練習題，要求：
1. 每道題必須針對該學生的某個特定弱點
2. 題目難度：${difficulty || "適中"}
3. 題目類型多樣化
4. 每道題附有詳細解題步驟和答案
5. 題目要貼近香港小學數學課程和日常生活情境

只輸出純JSON：
{
  "student_name": "${studentName}",
  "grade": "${grade}",
  "weakness_summary": "該學生主要弱點概述",
  "practice_questions": [
    {
      "question_number": 1,
      "targeted_weakness": "針對的弱點",
      "strand": "課程範疇",
      "topic": "具體主題",
      "question_type": "題目類型",
      "question_text": "完整題目文字",
      "hints": "",
      "solution_steps": ["步驟1", "步驟2"],
      "answer": "正確答案",
      "explanation": "設計理由"
    }
  ],
  "study_tips": ["建議1", "建議2"]
}`;
      sysMsg = "你是資深香港小學數學教師，精通因材施教、針對學生弱點設計練習題。";
    }

    const resp = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system" as const, content: sysMsg },
        { role: "user" as const, content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    });

    const result = parseJson(resp.choices[0].message.content || "{}");
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, parse_error: true }, { status: 500 });
  }
}

export const maxDuration = 60;
