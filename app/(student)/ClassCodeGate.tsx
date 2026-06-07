"use client";
import { useState, useEffect, useCallback } from "react";

const FLAG = "ksz_student_ok";

export default function ClassCodeGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [ok, setOk] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try { if (localStorage.getItem(FLAG) === "1") setOk(true); } catch {}
    setReady(true);
  }, []);

  const submit = useCallback(async () => {
    const c = code.trim();
    if (!c) { setError("請輸入班級代碼"); return; }
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/student-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { setError(data.error || "代碼不正確，請再試。"); return; }
      try { localStorage.setItem(FLAG, "1"); } catch {}
      setOk(true);
    } catch {
      setError("連線失敗，請檢查網絡後再試。");
    } finally {
      setLoading(false);
    }
  }, [code]);

  const reset = () => {
    try { localStorage.removeItem(FLAG); } catch {}
    fetch("/api/student-auth", { method: "DELETE" }).catch(() => {});
    setOk(false);
    setCode("");
  };

  if (!ready) return null;

  if (ok) {
    return (
      <>
        <button className="code-reset" onClick={reset} title="換班級代碼">換代碼</button>
        {children}
      </>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 440 }}>
      <div className="card gate-card">
        <div className="gate-mascot">🦊</div>
        <h2 className="gate-title">數學小助教</h2>
        <p className="gate-sub">輸入老師畀你嘅班級代碼就可以開始！</p>
        <input
          className="gate-input"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="班級代碼"
          autoFocus
        />
        <button className="btn btn-primary gate-btn" disabled={loading} onClick={submit}>
          {loading ? "⏳ 進入中…" : "開始學習 🚀"}
        </button>
        {error && <div className="warn-box" style={{ marginTop: 14 }}>⚠️ {error}</div>}
      </div>
    </div>
  );
}
