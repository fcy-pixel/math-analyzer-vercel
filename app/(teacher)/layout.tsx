import type { Metadata } from "next";
import AuthGate from "../AuthGate";

export const metadata: Metadata = {
  title: "中華基督教會基慈小學 · 數學學生表現分析系統",
  description: "AI 批改試卷、診斷弱題、生成班級報告",
};

// Teacher tool: gated by Google sign-in (@keitsz.edu.hk).
export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
