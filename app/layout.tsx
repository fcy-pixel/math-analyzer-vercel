import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "基慈小學 · 數學系統",
  description: "AI 數學批改與學習工具",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
