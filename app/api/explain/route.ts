/* Explain a photographed math question for a primary student.
 * Returns a STRUCTURED explanation (text + KaTeX + an SVG diagram) so the page
 * can render accurate maths — no AI-generated raster images (which get numbers
 * wrong). The numbers in the SVG are literal text produced by the model, so
 * they stay correct. */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { parseJson } from "@/lib/json-parse";
import { requireAuth } from "@/lib/auth";

export const runtime = "edge";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const VISION_MODEL = "qwen-vl-plus";

export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  try {
    const { image, grade, apiKey, model } = await req.json();
    const key = apiKey || process.env.QWEN_API_KEY;
    if (!key) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });
    if (!image || typeof image !== "string") {
      return NextResponse.json({ error: "缺少題目圖片" }, { status: 400 });
    }
    const visionModel = (typeof model === "string" && model.trim()) ? model.trim() : VISION_MODEL;
    const client = new OpenAI({ apiKey: key, baseURL: BASE_URL });

    const systemMsg = "你是一位親切、有耐性的香港小學數學老師，擅長把數學題用最淺白的方式講解給小學生聽。你熟悉香港課程發展議會《數學課程指引》。";

    const gradeHint = grade ? `學生大約是 ${grade} 程度。` : "";
    const prompt = `學生影咗一張數學題目相片畀你。${gradeHint}請你睇清楚題目，然後用小學生明白嘅方式講解。

要求：
1. 全部用繁體中文、香港小學用語（加、減、除、餘數、分數、周界、面積…），語氣親切，適合小學生。
2. 一步一步教，每步解釋「點解咁做」，唔好跳步。
3. 計算必須正確：你要先在心中驗算清楚先答，數字絕對不能錯。
4. 數式寫成 KaTeX 語法，但唔好加 $ 符號（例如分數寫 \\frac{3}{4}、乘號 \\times、除號 \\div、上標 ^{2}）。
5. 用一幅簡單 SVG 圖解幫助理解（分數用分割長條或圓餅、長度用數線、圖形題用簡單幾何圖）。圖入面嘅數字/標籤必須同你嘅解說一致；用鮮明顏色；viewBox 約 0 0 400 280；唔好用外部圖片或 <script>；如果真係冇合適圖解就回 ""。
6. 最後出一條同類型、數字唔同嘅練習題畀學生自己試。

只輸出純 JSON（唔好加 markdown 代碼塊）：
{
  "question_summary": "用一兩句講返呢題問緊乜",
  "concept": "呢題考緊嘅數學概念（例：分數加法）",
  "steps": [
    { "explain": "淺白文字解釋", "math": "KaTeX 算式（可選，冇就留空字串）" }
  ],
  "answer": "最終答案（可含 KaTeX）",
  "diagram_svg": "<svg viewBox=\\"0 0 400 280\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg> 或 \\"\\"",
  "practice": { "question": "一條同類型、數字唔同嘅練習題", "hint": "一個小提示（可選）" }
}

如果相片矇、睇唔清，或者根本唔係數學題，請回：
{ "not_clear": true, "message": "禮貌地叫學生影清楚啲 / 影返數學題" }`;

    const mime = image.startsWith("/9j") ? "image/jpeg" : "image/png";
    const content = [
      { type: "image_url", image_url: { url: `data:${mime};base64,${image}` } },
      { type: "text", text: prompt },
    ];

    const resp = await client.chat.completions.create({
      model: visionModel,
      messages: [
        { role: "system" as const, content: systemMsg },
        { role: "user" as const, content: content as unknown as string },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    });

    const result = parseJson(resp.choices[0].message.content || "{}");
    result._model = visionModel;
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, parse_error: true }, { status: 500 });
  }
}

export const maxDuration = 60;
