/* Generate practice questions for a student */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getGradeCurriculum } from "@/lib/curriculum";

export const runtime = "edge";

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

以下是該學生在測驗中全部答對的題目（包含原題類型，例如「純計算題」、「文字應用題」、「填充題」、「選擇題」等）：
${JSON.stringify(allQuestions || [], null, 2)}

香港 ${grade} 年級數學課程綱要：
${curriculum}

請為其設計 ${numQuestions || 5} 道鞏固延伸練習題，要求：
1. 针對學生已掌握的範疇，提高難度。
2. **重要：逐題參考原題類型，原題是「純計算題」就出「純計算題」（只有算式，不加任何生活情境或文字描述）；原題是「文字應用題」就出「文字應用題」；原題是「填充題」、「選擇題」、「判斷題」等亦需保持一致。**
3. 若原題未明示類型，請依題目文字自行判斷：只含算式 / 求值則為「純計算題」；含生活情境、人名、單位的為「文字應用題」。
4. 不要將純計算題改寫成文字應用題，亦不要將文字應用題簡化成贤計算。
5. 每道題附有詳細解題步驟和答案；question_type 欄必須填寫與原題一致的類型（如「純計算題」、「文字應用題」、「填充題」、「選擇題」等）。
6. **數學符號格式：所有數學表達式（分數、乘除、上下標、平方根、π 等）必須以 LaTeX 寫在 $...$ 之間，例如：純計算題寫成 \`$\\frac{3}{4}\\times\\frac{2}{3}=?$\`；文字應用題的算式部分亦寫成 \`小明買了 $\\frac{3}{4}$ 公斤蘋果...\`。請在 question_text、hints、solution_steps、answer 內所有數學部分一律使用 $...$ LaTeX 格式（分數一律使用 \\frac、乘號用 \\times、除號用 \\div、上標用 ^{}、下標用 _{}）。**

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
      "question_type": "與原題相同的題型",
      "question_text": "完整題目文字",
      "hints": "",
      "solution_steps": ["步驟1", "步驟2"],
      "answer": "正確答案",
      "explanation": "設計理由"
    }
  ],
  "study_tips": ["建議1", "建議2"]
}`;
      sysMsg = "你是資深香港小學數學教師，為優秀學生設計鞏固延伸練習題，並嚴格保持與原題相同的題型（純計算題 / 文字應用題 / 填充題 / 選擇題等）。";
    } else {
      prompt = `你是一位經驗豐富的香港小學數學科老師，正在為 ${grade} 年級的學生 ${studentName} 設計針對性練習題。

以下是該學生在測驗中答錯的題目（包含原題類型，例如「純計算題」、「文字應用題」、「填充題」、「選擇題」等）：
${JSON.stringify(weakQuestions || [], null, 2)}

香港 ${grade} 年級數學課程綱要：
${curriculum}

請根據該學生的弱點，生成 ${numQuestions || 5} 道針對性練習題，要求：
1. 每道題必須針對該學生的某個特定弱點。
2. 題目難度：${difficulty || "適中"}。
3. **重要：生成的練習題類型必須與原題一致。原題是「純計算題」（例如 3/4 ÷ 2/3）就出「純計算題」，只給算式、不加任何生活情境、人名、單位或文字描述；原題是「文字應用題」就出「文字應用題」，保留生活情境；「填充題」、「選擇題」、「判斷題」等類型亦需與原題保持一致。**
4. 若原題未明示類型，請依題目文字自行判斷：只含算式 / 求值 / 填空的為「純計算題」；含生活情境、人名、單位的為「文字應用題」。
5. 不要將純計算題改寫成文字應用題，亦不要將文字應用題簡化成贤計算。
6. 每道題附有詳細解題步驟和答案；question_type 欄必須填寫與原題一致的類型（如「純計算題」、「文字應用題」、「填充題」、「選擇題」等）。
7. 題目要貼近香港小學數學課程。
8. **數學符號格式：所有數學表達式（分數、乘除、上下標、平方根、π 等）必須以 LaTeX 寫在 $...$ 之間，例如：純計算題寫成 \`$\\frac{3}{4}\\times\\frac{2}{3}=?$\`；文字應用題的算式部分亦寫成 \`小明買了 $\\frac{3}{4}$ 公斤蘋果...\`。請在 question_text、hints、solution_steps、answer 內所有數學部分一律使用 $...$ LaTeX 格式（分數一律使用 \\frac、乘號用 \\times、除號用 \\div、上標用 ^{}、下標用 _{}）。**

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
      "question_type": "與原題相同的題型",
      "question_text": "完整題目文字",
      "hints": "",
      "solution_steps": ["步驟1", "步驟2"],
      "answer": "正確答案",
      "explanation": "設計理由"
    }
  ],
  "study_tips": ["建議1", "建議2"]
}`;
      sysMsg = "你是資深香港小學數學教師，針對學生弱點設計練習題，並嚴格保持與原題相同的題型（純計算題 / 文字應用題 / 填充題 / 選擇題等）。";
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
