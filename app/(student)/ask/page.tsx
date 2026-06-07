"use client";
import "katex/dist/katex.min.css";
import { useState, useRef, useEffect } from "react";
import renderMathInElement from "katex/contrib/auto-render";
import { imageToBase64, approxBase64Mb, shrinkImagesToFit } from "@/lib/pdf";
import { sanitizeSvg } from "@/lib/render-math";

type ExplainStep = { explain: string; math?: string };
type ExplainResult = {
  question_summary?: string;
  concept?: string;
  steps?: ExplainStep[];
  answer?: string;
  diagram_svg?: string;
  practice?: { question?: string; hint?: string };
  not_clear?: boolean;
  message?: string;
  error?: string;
  parse_error?: boolean;
  raw_response?: string;
};

const GRADES = ["P1", "P2", "P3", "P4", "P5", "P6"];

const KATEX_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
];

/** Wrap a raw-LaTeX field (no delimiters) so auto-render picks it up; if it
 * already contains $ delimiters, leave it as-is. */
function asMath(s: string, display = false): string {
  if (!s) return "";
  if (s.includes("$") || s.includes("\\(") || s.includes("\\[")) return s;
  const d = display ? "$$" : "$";
  return `${d}${s}${d}`;
}

export default function AskPage() {
  const [grade, setGrade] = useState("P4");
  const [preview, setPreview] = useState<string | null>(null);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // After a result renders, let KaTeX auto-render turn every $...$ in the text
  // (in any field) into proper maths symbols.
  useEffect(() => {
    if (result && resultRef.current) {
      try {
        renderMathInElement(resultRef.current, {
          delimiters: KATEX_DELIMITERS,
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option", "svg"],
          throwOnError: false,
        });
      } catch { /* ignore */ }
    }
  }, [result]);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setPreview(URL.createObjectURL(file));
    try {
      let imgs = await imageToBase64(file);
      if (approxBase64Mb(imgs) > 1.6) imgs = await shrinkImagesToFit(imgs, 1.6);
      setImageB64(imgs[0] || null);
    } catch {
      setError("讀取圖片失敗，請再試一次。");
      setImageB64(null);
    }
  }

  async function ask() {
    if (!imageB64) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageB64, grade }),
      });
      const data: ExplainResult = await resp.json();
      if (!resp.ok) {
        setError(data.error || `伺服器錯誤（HTTP ${resp.status}）`);
      } else if (data.parse_error) {
        setError("小助教睇唔太明，請影清楚啲再試。");
      } else {
        setResult(data);
      }
    } catch {
      setError("連線失敗，請檢查網絡後再試。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="header">
        <div className="mascot">🦊</div>
        <div>
          <h1>數學小助教</h1>
          <p>影一張數學題，跟住一步步做，學識為止！</p>
        </div>
      </div>

      <div className="container" style={{ maxWidth: 820 }}>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="form-row" style={{ alignItems: "flex-end" }}>
            <div className="form-group" style={{ maxWidth: 120 }}>
              <label>年級</label>
              <select value={grade} onChange={e => setGrade(e.target.value)}>
                {GRADES.map(g => <option key={g}>{g}</option>)}
              </select>
            </div>
          </div>

          <div className={`upload-zone ${preview ? "has-file" : ""}`} onClick={() => fileRef.current?.click()} style={{ marginTop: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
            />
            {preview ? "✅ 已選擇圖片（點擊可重新影）" : "📷 點擊影相 / 選擇數學題圖片"}
          </div>

          {preview && (
            <div style={{ marginTop: 12, textAlign: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="題目預覽" style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: "1px solid var(--border)" }} />
            </div>
          )}

          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button className="btn btn-primary" style={{ fontSize: "1.05rem", padding: "12px 36px" }} disabled={!imageB64 || loading} onClick={ask}>
              {loading ? "⏳ 小助教思考中…" : "✨ 問小助教"}
            </button>
          </div>

          {error && <div className="warn-box" style={{ marginTop: 12 }}>⚠️ {error}</div>}
        </div>

        {result && result.not_clear && (
          <div className="card"><div className="info-box">🙂 {result.message || "請影清楚啲再試。"}</div></div>
        )}

        {result && !result.not_clear && (
          <div className="card" ref={resultRef}>
            {result.question_summary && (
              <div className="info-box">📖 <strong>題目：</strong>{result.question_summary}</div>
            )}
            {result.concept && (
              <p style={{ margin: "10px 0", color: "var(--fg2)" }}>🏷️ 考緊：<strong>{result.concept}</strong></p>
            )}

            {(result.steps || []).length > 0 && (
              <>
                <h3 style={{ margin: "12px 0 8px" }}>📝 一步一步教你</h3>
                {(result.steps || []).map((s, i) => (
                  <div key={i} className="step">
                    <div className="step-num">{i + 1}</div>
                    <div className="step-body">
                      <div>{s.explain}</div>
                      {s.math ? <div style={{ marginTop: 4 }}>{asMath(s.math, true)}</div> : null}
                    </div>
                  </div>
                ))}
              </>
            )}

            {result.diagram_svg && sanitizeSvg(result.diagram_svg) && (
              <>
                <h3 style={{ margin: "14px 0 8px" }}>🖼️ 圖解</h3>
                <div
                  style={{ textAlign: "center", overflowX: "auto", padding: 8, background: "#fff", borderRadius: 12, border: "1px solid var(--border)" }}
                  dangerouslySetInnerHTML={{ __html: sanitizeSvg(result.diagram_svg).replace("<svg", "<svg style=\"max-width:100%;height:auto\"") }}
                />
              </>
            )}

            {result.answer && (
              <div className="success-box" style={{ marginTop: 14, fontSize: "1.05rem" }}>
                ✅ <strong>答案：</strong>{result.answer}
              </div>
            )}

            {result.practice?.question && (
              <div className="practice-card">
                <h3 style={{ marginBottom: 6 }}>🎯 試多一題</h3>
                <div>{result.practice.question}</div>
                {result.practice.hint && <div style={{ marginTop: 6, fontSize: "0.88rem", color: "var(--fg2)" }}>💡 提示：{result.practice.hint}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
