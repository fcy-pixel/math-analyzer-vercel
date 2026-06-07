/* Explain a photographed math question for a primary student.
 * Returns a STRUCTURED explanation (text + KaTeX + an SVG diagram) so the page
 * can render accurate maths — no AI-generated raster images (which get numbers
 * wrong). The numbers in the SVG are literal text produced by the model, so
 * they stay correct. */
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { parseJson } from "@/lib/json-parse";
import { requireStudentOrTeacher } from "@/lib/auth";

export const runtime = "edge";

const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
// /ask is a single on-demand call per question, so we can afford the stronger
// model here (better explanations + nicer SVG diagrams) without the rate-limit
// concerns of class-wide grading.
const VISION_MODEL = "qwen-vl-max";

export async function POST(req: NextRequest) {
  const denied = await requireStudentOrTeacher(req);
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
4. 所有數學符號、算式、數字運算（喺 question_summary、steps、answer、practice 任何文字裡面）一律用 KaTeX 並用 $ 符號包住：行內用 $...$，獨立一行用 $$...$$。例如「總共 $15 \\times 31 = 465$ 小時」、分數 $\\frac{3}{4}$、除號 $\\div$、上標 $x^{2}$。唔好淨係寫 15×31 而唔用 $，亦唔好用 LaTeX 以外嘅特殊符號。
5. 製作一個「**互動解題練習**」(interactive_html)，帶學生**一步一步做呢條題目嘅計算**（係引導佢完成計算過程，唔係畀佢亂改題目數字）。要求：
   - 一個**完整、自足**嘅 HTML 片段：inline <style> + <script>，純 vanilla JavaScript，**唔好用任何外部資源**（CDN、外部圖片、外部字型、框架都唔好）。
   - 把解題拆成幾個步驟逐步引導：每一步顯示「呢步要做乜」，畀學生**輸入答案或揀選項**，撳「檢查」即時判斷——啱：綠色 ✓ + 鼓勵 + 解鎖下一步；錯：紅色提示，畀佢再試（可加「睇提示 💡」「睇答案」掣）。
   - 每一步嘅**正確值你要預先算好並寫入 JS**，令檢查即時又準確；全部做完顯示恭喜（🎉 全部答啱！）。
   - 設計：適合喺約 480×440 框內、響應式、白底、字夠大、圓角、柔和鮮明配色（藍 #4C6FFF、橙 #FF8A3D、綠 #2FB36B、紅 #FF5C5C），繁體中文，有 emoji 鼓勵。
   - 所有數字運算必須正確，同你上面嘅解說一致。
   - **嚴禁喺 interactive_html 入面用 LaTeX 或 $ 符號**（呢個 widget 冇 KaTeX，$\\frac{3}{5}$ 會原樣顯示，小學生睇唔明）。分數要用 HTML/CSS 砌成小學生睇得明嘅「直式分數」（分子喺上、中間一條橫線、分母喺下）。可以用呢段 CSS：
     <style>.frac{display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;line-height:1.05;margin:0 3px;font-size:1em}.frac .n{border-bottom:2px solid currentColor;padding:0 5px}.frac .d{padding:0 5px}</style>
     用法：3/5 寫成 <span class='frac'><span class='n'>3</span><span class='d'>5</span></span>；帶分數 1 又 3/5 寫成 1<span class='frac'><span class='n'>3</span><span class='d'>5</span></span>。乘用 ×、除用 ÷，唔好用 \\times、\\frac、^、_ 等 LaTeX 指令。
   - **重要（確保 JSON 合法）**：interactive_html 字串內部嘅 HTML 屬性一律用單引號（例如 <div class='box'>），避免雙引號令 JSON 出錯。
   - 如果呢題真係唔適合做互動，interactive_html 回 ""。
6. 最後出一條同類型、數字唔同嘅練習題畀學生自己試。

只輸出純 JSON（唔好加 markdown 代碼塊）：
{
  "question_summary": "用一兩句講返呢題問緊乜",
  "concept": "呢題考緊嘅數學概念（例：分數加法）",
  "steps": [
    { "explain": "淺白文字解釋", "math": "KaTeX 算式（可選，冇就留空字串）" }
  ],
  "answer": "最終答案（可含 KaTeX）",
  "interactive_html": "<style>...</style><div id='app'>...</div><script>...</script> 或 \\"\\"",
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
      max_tokens: 8192,
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
