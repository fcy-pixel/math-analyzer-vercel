import type { Metadata } from "next";
import "./student.css";
import ClassCodeGate from "./ClassCodeGate";

export const metadata: Metadata = {
  title: "數學小助教",
  description: "影一張數學題，跟住一步步做，學識為止！",
};

// Student app: its own cartoon shell, gated by a class code (no Google sign-in).
export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="kidapp">
      <ClassCodeGate>{children}</ClassCodeGate>
    </div>
  );
}
