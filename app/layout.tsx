import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolarAdvisor v5.2 — 태양광 사업성 분석 플랫폼",
  description: "태양광 발전 사업성 분석, 패널 배치도, 수익성 시뮬레이션, 조례 비교, 인허가 서류 관리",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full bg-slate-50">{children}</body>
    </html>
  );
}
