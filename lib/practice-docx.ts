/* Client-side DOCX export for practice worksheets.
 * Math expressions wrapped in $...$ (or $$...$$) inside text fields are
 * rendered as real Office Math (OMML) via KaTeX → MathML → mathml2omml.
 */
import type { PracticeResult } from "@/lib/types";

type Entry = { studentName: string; result: PracticeResult };

function formatDate(d = new Date()) {
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
}

/** Split a string into [{type:'text'|'math', value}] segments using $...$ / $$...$$ delimiters. */
function tokenizeMath(input: string): Array<{ type: "text" | "math"; value: string }> {
  if (!input) return [];
  const out: Array<{ type: "text" | "math"; value: string }> = [];
  // Match $$...$$ first, then $...$
  const re = /\$\$([\s\S]+?)\$\$|\$([^\$\n]+?)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m.index > last) out.push({ type: "text", value: input.slice(last, m.index) });
    const tex = (m[1] ?? m[2] ?? "").trim();
    if (tex) out.push({ type: "math", value: tex });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ type: "text", value: input.slice(last) });
  return out;
}

/** Convert one LaTeX expression to OMML XML string. */
function latexToOmml(
  tex: string,
  katexLib: typeof import("katex"),
  mml2omml: (xml: string) => string,
): string | null {
  try {
    const html = katexLib.renderToString(tex, { output: "mathml", throwOnError: false, displayMode: false });
    const match = html.match(/<math[\s\S]*?<\/math>/);
    if (!match) return null;
    // Strip the <annotation>…</annotation> element which mathml2omml warns on.
    const mml = match[0].replace(/<annotation[\s\S]*?<\/annotation>/g, "");
    return mml2omml(mml);
  } catch {
    return null;
  }
}

/** Build a list of docx paragraph children from text containing $math$ tokens. */
function buildRichRuns(
  text: string,
  docx: typeof import("docx"),
  katexLib: typeof import("katex"),
  mml2omml: (xml: string) => string,
  opts?: { bold?: boolean; size?: number; color?: string },
) {
  const segs = tokenizeMath(text || "");
  if (!segs.length) return [new docx.TextRun({ text: "", ...opts })];
  return segs.map(seg => {
    if (seg.type === "text") {
      return new docx.TextRun({ text: seg.value, ...opts });
    }
    const omml = latexToOmml(seg.value, katexLib, mml2omml);
    if (omml) {
      try {
        return docx.ImportedXmlComponent.fromXmlString(omml);
      } catch {
        // fallthrough to plain text
      }
    }
    return new docx.TextRun({ text: seg.value, ...opts });
  });
}

export async function downloadPracticeDocx(entries: Entry[], grade: string, filename: string) {
  const [docxMod, katexMod, mathmlMod, fileSaverMod] = await Promise.all([
    import("docx"),
    import("katex"),
    import("mathml2omml"),
    import("file-saver"),
  ]);
  const docx = docxMod;
  const katexLib = (katexMod as unknown as { default?: typeof import("katex") }).default ?? katexMod;
  const mathmlLib = mathmlMod as unknown as { mml2omml?: (s: string) => string; default?: { mml2omml: (s: string) => string } };
  const mml2omml = mathmlLib.mml2omml ?? mathmlLib.default?.mml2omml;
  if (!mml2omml) throw new Error("mathml2omml export not found");
  const saveAs = (fileSaverMod as unknown as { saveAs?: typeof import("file-saver").saveAs; default?: { saveAs: typeof import("file-saver").saveAs } }).saveAs
    ?? (fileSaverMod as unknown as { default: { saveAs: typeof import("file-saver").saveAs } }).default.saveAs;

  const dateStr = formatDate();
  const sections = entries.map(({ studentName, result }, idx) => {
    const qs = result.practice_questions || [];
    const tips = result.study_tips || [];
    const totalScore = Math.max(qs.length * 2, 10);

    const children: import("docx").FileChild[] = [];

    // Header lines
    children.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [new docx.TextRun({ text: `小學數學 弱點針對練習 · ${grade} · 【學生練習版】`, size: 18, color: "1E3A5F" })],
    }));
    children.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new docx.TextRun({ text: "📝 數學弱點鞏固練習題", bold: true, size: 32, color: "1E3A5F" })],
    }));
    // Info row
    children.push(new docx.Paragraph({
      spacing: { after: 120 },
      children: [
        new docx.TextRun({ text: `姓名：${studentName}    `, size: 22 }),
        new docx.TextRun({ text: `班別：________    `, size: 22 }),
        new docx.TextRun({ text: `日期：${dateStr}    `, size: 22 }),
        new docx.TextRun({ text: `得分：_____ / ${totalScore}`, size: 22 }),
      ],
    }));

    if (result.weakness_summary) {
      children.push(new docx.Paragraph({
        spacing: { before: 120, after: 120 },
        shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "FFF8E1" },
        children: [
          new docx.TextRun({ text: "🎯 練習重點：", bold: true, color: "5D3A00", size: 20 }),
          new docx.TextRun({ text: result.weakness_summary, color: "5D3A00", size: 20 }),
        ],
      }));
    }

    qs.forEach((q) => {
      // Question header
      children.push(new docx.Paragraph({
        spacing: { before: 240, after: 80 },
        shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "1E3A5F" },
        children: [
          new docx.TextRun({ text: `第 ${q.question_number} 題`, bold: true, color: "FFFFFF", size: 24 }),
          new docx.TextRun({ text: `  [${q.question_type || ""}]`, color: "FFFFFF", size: 20 }),
          new docx.TextRun({ text: `    ${q.strand || ""} · ${q.topic || ""}`, color: "DDDDDD", size: 18 }),
        ],
      }));
      // Question text with inline math
      children.push(new docx.Paragraph({
        spacing: { after: 120 },
        children: buildRichRuns(q.question_text || "", docx, katexLib, mml2omml, { size: 24 }),
      }));
      if (q.hints) {
        children.push(new docx.Paragraph({
          spacing: { after: 120 },
          shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "E3F2FD" },
          children: [
            new docx.TextRun({ text: "💡 提示：", bold: true, color: "1A3C5C", size: 20 }),
            ...buildRichRuns(q.hints, docx, katexLib, mml2omml, { size: 20, color: "1A3C5C" }),
          ],
        }));
      }
      // Work space placeholder
      children.push(new docx.Paragraph({
        spacing: { after: 80 },
        children: [new docx.TextRun({ text: "（計算工作空間）", italics: true, color: "AAAAAA", size: 18 })],
      }));
      for (let i = 0; i < 4; i++) {
        children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: "" })] }));
      }
    });

    if (tips.length) {
      children.push(new docx.Paragraph({
        spacing: { before: 240, after: 80 },
        children: [new docx.TextRun({ text: "📚 學習建議", bold: true, size: 24, color: "2E7D32" })],
      }));
      tips.forEach(t => {
        children.push(new docx.Paragraph({
          bullet: { level: 0 },
          children: buildRichRuns(t, docx, katexLib, mml2omml, { size: 20 }),
        }));
      });
    }

    return {
      properties: idx === 0 ? undefined : { type: docx.SectionType.NEXT_PAGE },
      children,
    };
  });

  const doc = new docx.Document({
    creator: "Math Analyzer",
    title: `數學弱點練習 · ${grade}`,
    styles: {
      default: {
        document: { run: { font: "Microsoft JhengHei" } },
      },
    },
    sections,
  });

  const blob = await docx.Packer.toBlob(doc);
  saveAs(blob, filename);
}
