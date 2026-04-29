/* Generate class-wide AI insights (text model) */
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
    const { aggregated, grade, apiKey } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });

    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
    const curriculum = getGradeCurriculum(grade);
    const weakQ = aggregated.weak_questions || [];
    const strandStats = aggregated.strand_stats || [];
    const classAvg = aggregated.class_average || 0;
    const total = aggregated.total_students || 0;
    const dist = aggregated.class_distribution || {};

    const prompt = `你是一位資深香港小學數學科主任，正在分析 ${grade} 年級全班 ${total} 位學生的試卷評分結果。

【全班整體數據】
全班平均分：${classAvg}%
成績分佈：${JSON.stringify(dist)}

【弱題排行（正確率最低）】
${JSON.stringify(weakQ.slice(0, 10), null, 2)}

【各課程範疇分析】
${JSON.stringify(strandStats, null, 2)}

香港 ${grade} 年級數學課程綱要：
${curriculum}

請根據以上數據生成深度診斷，必須：
1. 找出全班最弱的2-3個課程範疇（數據佐證）
2. 分析常見錯誤類型（概念性誤解 vs 程序性錯誤）
3. 結合《數學課程指引》（2017）提出3個具體補救教學建議
4. 描述需要額外關注的學生群組特徵（不提名）

只輸出純JSON（不加markdown代碼塊）：
{
  "overall_diagnosis": "全班學習問題核心診斷（3-5句，包含具體數據）",
  "weak_strand_analysis": [
    {
      "strand": "課程範疇",
      "class_average_rate": 0,
      "key_issues": ["主要問題1", "問題2"],
      "misconception": "可能的概念誤解",
      "curriculum_link": "對應《數學課程指引》（2017）的學習目標"
    }
  ],
  "error_type_analysis": {
    "conceptual": "概念性誤解描述（附題號和正確率）",
    "procedural": "程序性錯誤描述（附題號和正確率）"
  },
  "teaching_recommendations": [
    {
      "priority": "高 / 中 / 低",
      "strand": "針對範疇",
      "strategy": "具體教學策略",
      "activities": ["教學活動1", "活動2"],
      "timeline": "建議時間（如：1週內）"
    }
  ],
  "attention_students_note": "需要個別關注的學生群組特徵",
  "positive_findings": "全班優秀表現和可鼓勵之處"
}`;

    const resp = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system" as const, content: "你是資深香港小學數學科主任，熟悉香港課程發展議會《數學課程指引》（2017），擅長從全班數據中找出教學缺口並提出具體改善方案。" },
        { role: "user" as const, content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 8192,
    });

    return NextResponse.json(parseJson(resp.choices[0].message.content || "{}"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, parse_error: true }, { status: 500 });
  }
}

export const maxDuration = 60;
