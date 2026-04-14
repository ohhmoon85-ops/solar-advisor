'use client'

// components/RoiSummary.tsx — LCOE·NPV·최적 패널 수 비교 컴포넌트
// RevenueTab의 20년 현금흐름 테이블/차트와 중복되지 않도록,
// 이 컴포넌트는 LCOE·NPV·3모드 비교 등 추가 지표만 표시합니다

import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import type { RoiResult, OptimalResult } from '@/lib/roiAnalyzer'

// ── 타입 ───────────────────────────────────────────────────────────

interface Props {
  roiResult: RoiResult
  panelCount: number
  panelType: string
  /** findOptimalPanelCount 결과 (선택) */
  optimizationResults?: OptimalResult[]
  optimalMode?: string
}

// ── 포맷 헬퍼 ──────────────────────────────────────────────────────

function fmtWon(n: number) { return `${Math.round(n).toLocaleString()}만원` }
function fmtKwh(n: number) { return `${Math.round(n).toLocaleString()}kWh` }

// ── 컴포넌트 ───────────────────────────────────────────────────────

export default function RoiSummary({
  roiResult,
  panelCount,
  panelType,
  optimizationResults,
  optimalMode,
}: Props) {
  const {
    totalCostMan,
    annualKwh,
    annualRevenueMan,
    paybackYears,
    roi20yr,
    lcoeWon,
    npvMan,
    totalKwp,
    yearlyRevenues,
  } = roiResult

  // 손익분기점 연도
  const breakevenYear = yearlyRevenues.find(r => r.cumulative >= 0)?.year ?? -1

  // 차트: 투자비 기준선 (음수 → 양수 전환점)
  const chartData = useMemo(() =>
    yearlyRevenues.map(r => ({
      year: `${r.year}년`,
      누적수익: r.cumulative,
    })), [yearlyRevenues])

  return (
    <div className="space-y-5">

      {/* ── 핵심 지표 4개 ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: '총 투자비',
            value: fmtWon(totalCostMan),
            sub: `${panelCount}장 · ${totalKwp}kWp`,
            color: 'text-blue-400',
          },
          {
            label: '연간 예상 수익',
            value: fmtWon(annualRevenueMan),
            sub: fmtKwh(annualKwh),
            color: 'text-green-400',
          },
          {
            label: '투자회수기간',
            value: paybackYears > 0 ? `${paybackYears}년` : '20년 초과',
            sub: breakevenYear > 0 ? `${breakevenYear}년차 흑자 전환` : '',
            color: paybackYears > 0 && paybackYears <= 12 ? 'text-emerald-400' : 'text-yellow-400',
          },
          {
            label: '20년 ROI',
            value: `${roi20yr}%`,
            sub: panelType,
            color: roi20yr >= 100 ? 'text-emerald-400' : 'text-orange-400',
          },
        ].map(card => (
          <div key={card.label}
            className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-1">
            <div className="text-xs text-slate-400">{card.label}</div>
            <div className={`text-lg font-bold ${card.color}`}>{card.value}</div>
            <div className="text-xs text-slate-500">{card.sub}</div>
          </div>
        ))}
      </div>

      {/* ── LCOE · NPV ── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">LCOE (균등화 발전비용)</div>
          <div className="text-xl font-bold text-purple-400">
            {lcoeWon.toLocaleString()}원<span className="text-sm font-normal text-slate-400">/kWh</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            총 투자비 ÷ 20년 예상 발전량
          </div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">NPV (할인율 4%)</div>
          <div className={`text-xl font-bold ${npvMan >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {npvMan >= 0 ? '+' : ''}{fmtWon(npvMan)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {npvMan >= 0 ? '투자 가치 있음' : '투자 재검토 필요'}
          </div>
        </div>
      </div>

      {/* ── 누적 수익 라인 차트 ── */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3">
        <div className="text-xs text-slate-400 mb-3">연도별 누적 수익 (만원)</div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="year"
              tick={{ fontSize: 9, fill: '#94a3b8' }}
              interval={3}
            />
            <YAxis
              tick={{ fontSize: 9, fill: '#94a3b8' }}
              tickFormatter={v => `${(v / 1000).toFixed(0)}천`}
              width={38}
            />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(v: unknown) => [`${Math.round(Number(v)).toLocaleString()}만원`, '누적 수익']}
            />
            <ReferenceLine y={0} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1.5} />
            <Line
              type="monotone"
              dataKey="누적수익"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── 3모드 비교 테이블 (findOptimalPanelCount 결과) ── */}
      {optimizationResults && optimizationResults.length > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-700 text-xs text-slate-400">
            배치 모드별 비교 (LCOE 최저 = 최적)
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700">
                {['모드', '패널 수', '연간 발전량', '투자회수', 'LCOE'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-slate-400 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {optimizationResults.map(opt => {
                const isOptimal = opt.mode === optimalMode
                return (
                  <tr key={opt.mode}
                    className={`border-b border-slate-700/50 ${isOptimal ? 'bg-emerald-950/30' : ''}`}>
                    <td className="px-3 py-2">
                      <span className={`font-semibold ${isOptimal ? 'text-emerald-400' : 'text-slate-300'}`}>
                        {opt.mode}
                        {isOptimal && ' ★'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{opt.panelCount}장</td>
                    <td className="px-3 py-2 text-slate-300">
                      {fmtKwh(opt.roi.annualKwh)}
                    </td>
                    <td className="px-3 py-2 text-slate-300">
                      {opt.roi.paybackYears > 0 ? `${opt.roi.paybackYears}년` : '—'}
                    </td>
                    <td className={`px-3 py-2 font-medium ${isOptimal ? 'text-emerald-400' : 'text-slate-300'}`}>
                      {opt.lcoe.toLocaleString()}원
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
