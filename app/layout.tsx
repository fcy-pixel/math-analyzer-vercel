import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "中華基督教會基慈小學 · 數學學生表現分析系統",
  description: "AI 批改試卷、診斷弱題、生成班級報告",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
