'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useSolarStore } from '@/store/useStore'
import { INSTALLATION_TYPES } from '@/lib/constants'
import { calcAnnual, calcYearlyTable, calcROI, findBreakevenYear } from '@/lib/calculations'
import type { InstallationType } from '@/lib/constants'

const LOAN_YEARS_OPTIONS = [5, 10, 15, 20]
const INTEREST_SCENARIOS = [
  { label: '에너지공단 2.0%', rate: 2.0 },
  { label: '시중은행 4.5%', rate: 4.5 },
  { label: '변동 6.0%', rate: 6.0 },
  { label: '고금리 8.0%', rate: 8.0 },
]

function fmt(n: number) { return Math.round(n).toLocaleString() }

export default function RevenueTab() {
  const {
    mapResult,
    capacityKw, setCapacityKw,
    installationType, setInstallationType,
    totalCost, setTotalCost,
    loanRatio, setLoanRatio,
    loanRate, setLoanRate,
    loanYears, setLoanYears,
  } = useSolarStore()

  const [activeView, setActiveView] = useState<'table' | 'chart' | 'compare'>('chart')

  // Auto-fill from mapResult
  useEffect(() => {
    if (mapResult) {
      setCapacityKw(mapResult.capacityKwp)
    }
  }, [mapResult, setCapacityKw])

  const revenue = useMemo(() => calcAnnual(capacityKw, installationType), [capacityKw, installationType])

  const equity = useMemo(() => totalCost * (1 - loanRatio / 100), [totalCost, loanRatio])

  const yearlyData = useMemo(
    () => calcYearlyTable(capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears),
    [capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears]
  )

  const breakevenYear = useMemo(() => findBreakevenYear(yearlyData), [yearlyData])
  const roi = useMemo(() => calcROI(yearlyData, equity), [yearlyData, equity])
  const netIncome1st = useMemo(() => yearlyData[0]?.netIncome ?? 0, [yearlyData])

  // Compare bar chart data
  const compareData = useMemo(() => INSTALLATION_TYPES.map(type => {
    const r = calcAnnual(capacityKw, type)
    return { name: type.replace('형', '').replace('농지', ''), total: Math.round(r.total / 10000) }
  }), [capacityKw])

  // Interest scenario table
  const scenarioData = useMemo(() =>
    INTEREST_SCENARIOS.map(s => {
      const rows = calcYearlyTable(capacityKw, installationType, totalCost, loanRatio, s.rate, loanYears)
      return { label: s.label, rate: s.rate, breakeven: findBreakevenYear(rows) }
    }), [capacityKw, installationType, totalCost, loanRatio, loanYears]
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col xl:flex-row gap-4">
        {/* Input panel */}
        <div className="w-full xl:w-80 flex-shrink-0 space-y-4">
          {mapResult && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
              <div className="text-xs text-blue-600 font-semibold mb-1">📍 이음지도 연동</div>
              <div className="text-sm text-blue-800">{mapResult.address || '입력된 주소 없음'}</div>
              <div className="text-xs text-blue-600 mt-1">
                {mapResult.panelCount}장 · {mapResult.capacityKwp} kWp
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
            <h3 className="font-semibold text-gray-800">입력 파라미터</h3>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">설비 용량 (kW)</label>
              <input
                type="number" min={1} max={10000} step={0.1}
                value={capacityKw}
                onChange={e => setCapacityKw(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">설치 유형</label>
              <select
                value={installationType}
                onChange={e => setInstallationType(e.target.value as InstallationType)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {INSTALLATION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">총 사업비 (만원)</label>
              <input
                type="number" min={100} step={100}
                value={totalCost}
                onChange={e => setTotalCost(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">
                대출 비율: <span className="text-blue-600 font-bold">{loanRatio}%</span>
              </label>
              <input type="range" min={0} max={90} step={5} value={loanRatio}
                onChange={e => setLoanRatio(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="text-xs text-gray-500 mt-1">
                자기자본: {fmt(equity)}만원 · 대출금: {fmt(totalCost * loanRatio / 100)}만원
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">
                대출 금리: <span className="text-blue-600 font-bold">{loanRate}%</span>
              </label>
              <input type="range" min={0} max={10} step={0.5} value={loanRate}
                onChange={e => setLoanRate(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">대출 기간</label>
              <div className="grid grid-cols-4 gap-1">
                {LOAN_YEARS_OPTIONS.map(y => (
                  <button key={y} onClick={() => setLoanYears(y)}
                    className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      loanYears === y ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                    }`}
                  >
                    {y}년
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-4 text-white">
              <div className="text-xs opacity-80 mb-1">연간 총수익</div>
              <div className="text-xl font-bold">{fmt(revenue.total / 10000)}<span className="text-sm font-normal ml-1">만원</span></div>
              <div className="text-xs opacity-70 mt-1">SMP {fmt(revenue.smpRevenue / 10000)} + REC {fmt(revenue.recRevenue / 10000)}</div>
            </div>
            <div className="bg-gradient-to-br from-green-500 to-green-600 rounded-xl p-4 text-white">
              <div className="text-xs opacity-80 mb-1">1년차 순이익</div>
              <div className="text-xl font-bold">{fmt(netIncome1st)}<span className="text-sm font-normal ml-1">만원</span></div>
              <div className="text-xs opacity-70 mt-1">운영비 2% 제외</div>
            </div>
            <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl p-4 text-white">
              <div className="text-xs opacity-80 mb-1">손익분기점</div>
              <div className="text-xl font-bold">
                {breakevenYear > 0 ? `${breakevenYear}년차` : '20년 초과'}
              </div>
              <div className="text-xs opacity-70 mt-1">자기자본 회수 기준</div>
            </div>
            <div className="bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl p-4 text-white">
              <div className="text-xs opacity-80 mb-1">20년 투자수익률</div>
              <div className="text-xl font-bold">{roi > 0 ? roi : '-'}<span className="text-sm font-normal ml-1">%</span></div>
              <div className="text-xs opacity-70 mt-1">ROI (자기자본 기준)</div>
            </div>
          </div>

          {/* Revenue breakdown */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-gray-500 mb-1">연간 발전량</div>
                <div className="text-lg font-bold text-gray-800">{fmt(revenue.annualKwh)} kWh</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">SMP 수익</div>
                <div className="text-lg font-bold text-blue-600">{fmt(revenue.smpRevenue / 10000)} 만원</div>
                <div className="text-xs text-gray-400">110원/kWh</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">REC 수익</div>
                <div className="text-lg font-bold text-green-600">{fmt(revenue.recRevenue / 10000)} 만원</div>
                <div className="text-xs text-gray-400">가중치 {revenue.recRevenue > 0 ? (revenue.recRevenue / (revenue.annualKwh / 1000) / (installationType === '건물지붕형' ? 105000 : 70000)).toFixed(1) : '-'}</div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex border-b border-gray-200">
              {[
                { key: 'chart', label: '누적 손익 차트' },
                { key: 'table', label: '20년 상세 테이블' },
                { key: 'compare', label: '유형별 비교' },
              ].map(tab => (
                <button key={tab.key}
                  onClick={() => setActiveView(tab.key as typeof activeView)}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    activeView === tab.key
                      ? 'border-b-2 border-blue-500 text-blue-600 bg-blue-50'
                      : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-4">
              {activeView === 'chart' && (
                <div>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={yearlyData.map(r => ({ ...r, year: `${r.year}년` }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${fmt(v)}`} />
                      <Tooltip formatter={(v) => [`${fmt(Number(v))}만원`, '']} />
                      <Legend />
                      <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4" label={{ value: '손익분기', position: 'right', fontSize: 11 }} />
                      <Line type="monotone" dataKey="cumulative" name="누적 손익(만원)" stroke="#3b82f6" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="netIncome" name="연간 순이익(만원)" stroke="#10b981" strokeWidth={1.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {activeView === 'table' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="px-2 py-2 text-left font-semibold text-gray-600">연도</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">발전량(kWh)</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">총수익(만원)</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">대출상환(만원)</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">운영비(만원)</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">순이익(만원)</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-600">누적(만원)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyData.map(row => (
                        <tr key={row.year}
                          className={`border-t border-gray-100 ${
                            row.isLoanPaid ? 'bg-yellow-50 font-semibold' :
                            row.isBreakeven ? 'bg-green-50' : ''
                          }`}
                        >
                          <td className="px-2 py-1.5">
                            {row.year}년차
                            {row.isBreakeven && <span className="ml-1 text-green-600">★</span>}
                            {row.isLoanPaid && <span className="ml-1 text-yellow-600 text-xs">대출완납</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">{row.kwh.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right">{row.totalRevenue.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right text-red-600">{row.loanPayment.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right text-orange-600">{row.opCost.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-medium">{row.netIncome.toLocaleString()}</td>
                          <td className={`px-2 py-1.5 text-right font-bold ${row.cumulative >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {row.cumulative.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeView === 'compare' && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">설치 유형별 연간 총수익 비교 ({capacityKw}kW 기준)</h4>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={compareData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={v => `${v}만`} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={60} />
                        <Tooltip formatter={(v) => [`${fmt(Number(v))}만원`]} />
                        <Bar dataKey="total" name="연간 총수익(만원)" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">금리 시나리오별 손익분기점</h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">금리 시나리오</th>
                          <th className="px-3 py-2 text-center font-semibold text-gray-600">금리</th>
                          <th className="px-3 py-2 text-center font-semibold text-gray-600">손익분기점</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scenarioData.map(s => (
                          <tr key={s.label} className={`border-t border-gray-100 ${s.rate === loanRate ? 'bg-blue-50 font-semibold' : ''}`}>
                            <td className="px-3 py-2">{s.label}</td>
                            <td className="px-3 py-2 text-center">{s.rate}%</td>
                            <td className={`px-3 py-2 text-center font-bold ${s.breakeven > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {s.breakeven > 0 ? `${s.breakeven}년차` : '20년 초과'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* 설치장소별 정책자금 및 특례 (Chapter 8) */}
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">설치장소별 정책자금 및 REC 특례</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border border-gray-200 rounded-lg overflow-hidden">
                        <thead>
                          <tr className="bg-slate-700 text-white">
                            <th className="px-3 py-2 text-left font-semibold">설치 장소</th>
                            <th className="px-3 py-2 text-center font-semibold">REC 가중치</th>
                            <th className="px-3 py-2 text-center font-semibold">정책자금</th>
                            <th className="px-3 py-2 text-left font-semibold">비고</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { place: '건물지붕형 / 공장·창고', rec: '1.5', fund: '지원', note: 'BIPV 우대, 에너지공단 2%', highlight: installationType === '건물지붕형' },
                            { place: '산업단지 지붕형', rec: '1.5', fund: '지원', note: '개발행위허가 불필요', highlight: false },
                            { place: '일반토지형', rec: '1.2', fund: '조건부', note: '주거이격·농지전용 확인 필수', highlight: installationType === '일반토지형' },
                            { place: '영농형농지', rec: '1.2', fund: '지원', note: '농지전용허가 + 영농 병행 필수', highlight: installationType === '영농형농지' },
                            { place: '임야형', rec: '0.7', fund: '제한', note: '산지전용허가 취득 난이도 높음', highlight: installationType === '임야형' },
                            { place: '수상형 (저수지·댐)', rec: '1.6', fund: '협의', note: '수면 점용허가 별도, 최고 가중치', highlight: false },
                          ].map((row, i) => (
                            <tr key={i} className={`border-t border-gray-100 ${row.highlight ? 'bg-blue-50 font-semibold' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                              <td className="px-3 py-2 font-medium text-gray-800">
                                {row.place}
                                {row.highlight && <span className="ml-1.5 text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded-full">선택됨</span>}
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className={`font-bold ${parseFloat(row.rec) >= 1.5 ? 'text-green-600' : parseFloat(row.rec) <= 0.7 ? 'text-red-500' : 'text-blue-600'}`}>
                                  {row.rec}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                  row.fund === '지원' ? 'bg-green-100 text-green-700' :
                                  row.fund === '조건부' ? 'bg-yellow-100 text-yellow-700' :
                                  row.fund === '제한' ? 'bg-red-100 text-red-600' :
                                  'bg-gray-100 text-gray-600'
                                }`}>
                                  {row.fund}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-gray-600">{row.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 text-xs text-gray-400">
                      * 정책자금: 에너지공단 신·재생에너지 설비 설치비 융자 (연 2.0%, 최대 70%, 15년 거치 5년 상환 가능)
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
