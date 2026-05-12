'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useSolarStore } from '@/store/useStore'
import { INSTALLATION_TYPES, GENERATION_HOURS } from '@/lib/constants'
import { calcAnnual, calcYearlyTable, calcROI, findBreakevenYear } from '@/lib/calculations'
import type { InstallationType } from '@/lib/constants'
import { calculateRoi, findOptimalPanelCount, ROI_DEFAULTS } from '@/lib/roiAnalyzer'
import RoiSummary from '@/components/RoiSummary'

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
    policyLoanRatio, setPolicyLoanRatio,
    policyLoanRate, setPolicyLoanRate,
    loanRate, setLoanRate,
    loanYears, setLoanYears,
    kierPvHours, kierGhi,
    priceOverride,
    setShowSaveModal,
  } = useSolarStore()

  const [activeView, setActiveView] = useState<'table' | 'chart' | 'compare'>('chart')
  const [useKierData, setUseKierData] = useState(true) // KIER 실측값 사용 여부
  const [pdfLoading, setPdfLoading] = useState(false)
  // Phase T: PDF 캡처 영역 (KPI + Revenue breakdown + Tabs, LCOE는 제외)
  const pdfRegionRef = useRef<HTMLDivElement>(null)

  // 실제 계산에 사용할 발전 시간 (KIER 실측 or 기본 3.5h)
  const effectiveGenHours = useKierData && kierPvHours ? kierPvHours : GENERATION_HOURS

  // Auto-fill from mapResult
  useEffect(() => {
    if (mapResult) {
      setCapacityKw(mapResult.capacityKwp)
    }
  }, [mapResult, setCapacityKw])

  const revenue = useMemo(
    () => calcAnnual(capacityKw, installationType, effectiveGenHours, priceOverride),
    [capacityKw, installationType, effectiveGenHours, priceOverride]
  )

  const equity = useMemo(() => totalCost * (1 - loanRatio / 100), [totalCost, loanRatio])

  const yearlyData = useMemo(
    () => calcYearlyTable(capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears, effectiveGenHours, priceOverride, policyLoanRatio, policyLoanRate),
    [capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears, effectiveGenHours, priceOverride, policyLoanRatio, policyLoanRate]
  )

  // Phase U 보완: 손익분기 = 총 사업비 회수 시점 (누적 순이익 ≥ totalCost)
  // 시공사 의도: "1.1억 투자금만큼이 되는 해" — 사업주가 총 투자금을 완전히 회수한 시점
  const breakevenYear = useMemo(() => findBreakevenYear(yearlyData, totalCost), [yearlyData, totalCost])
  const roi = useMemo(() => calcROI(yearlyData, equity), [yearlyData, equity])
  const netIncome1st = useMemo(() => yearlyData[0]?.netIncome ?? 0, [yearlyData])

  // Compare bar chart data
  const compareData = useMemo(() => INSTALLATION_TYPES.map(type => {
    const r = calcAnnual(capacityKw, type, effectiveGenHours, priceOverride)
    return { name: type.replace('형', '').replace('농지', ''), total: Math.round(r.total / 10000) }
  }), [capacityKw, effectiveGenHours])

  // Interest scenario table (일반 대출금리만 변동, 정책금리는 고정)
  const scenarioData = useMemo(() =>
    INTEREST_SCENARIOS.map(s => {
      const rows = calcYearlyTable(capacityKw, installationType, totalCost, loanRatio, s.rate, loanYears, effectiveGenHours, priceOverride, policyLoanRatio, policyLoanRate)
      return { label: s.label, rate: s.rate, breakeven: findBreakevenYear(rows, totalCost) }
    }), [capacityKw, installationType, totalCost, loanRatio, loanYears, effectiveGenHours, priceOverride, policyLoanRatio, policyLoanRate]
  )

  // ── LCOE·NPV 분석 (roiAnalyzer — calculations.ts 20년 테이블과 중복 없이 추가 지표만) ──
  const [showRoiSummary, setShowRoiSummary] = useState(false)

  // 패널 수 추정: mapResult가 있으면 실제 패널 수, 없으면 용량 기반 추정
  const estimatedPanelCount = useMemo(() => {
    if (mapResult?.panelCount) return mapResult.panelCount
    // 용량(kWp) ÷ 패널 공칭(kWp/장) — 단결정 PERC 550W 기준
    return Math.round((capacityKw * 1000) / 550)
  }, [mapResult, capacityKw])

  const roiResult = useMemo(() =>
    calculateRoi({
      panelCount: estimatedPanelCount,
      wattNominal: 550,
      costPerPanel: ROI_DEFAULTS.costPerPanelTypeA,
      installCostPerKwp: ROI_DEFAULTS.installCostPerKwp,
      electricityPriceKrw: priceOverride.smp + (priceOverride.recBuilding / 1000) * 1.5,
    }),
    [estimatedPanelCount, priceOverride]
  )

  const { results: optimizationResults, optimalMode } = useMemo(() =>
    findOptimalPanelCount(
      { placements: [], totalCount: estimatedPanelCount, totalKwp: capacityKw, coverageRatio: 0, theoreticalMax: 0, utilizationRate: 0 },
      {
        wattNominal: 550,
        costPerPanel: ROI_DEFAULTS.costPerPanelTypeA,
        installCostPerKwp: ROI_DEFAULTS.installCostPerKwp,
        electricityPriceKrw: priceOverride.smp + (priceOverride.recBuilding / 1000) * 1.5,
      }
    ),
    [estimatedPanelCount, capacityKw, priceOverride]
  )

  // ── Phase T: PDF 저장 ────────────────────────────────────────────
  // 캡처 대상: pdfRegionRef (KPI 4 + Revenue breakdown + 현재 활성 탭)
  // 패턴: html2canvas로 cloneNode 영역 + 헤더/메타 합성 캡처 → jsPDF A4 분할
  const handleSavePDF = async () => {
    const src = pdfRegionRef.current
    if (!src) return
    setPdfLoading(true)
    try {
      const { jsPDF } = await import('jspdf')
      // html2canvas-pro: Tailwind v4 oklch/lab/oklab 색 함수 지원
      // (기존 html2canvas@1.4.1은 lab() 파싱 실패 → "unsupported color function" 오류)
      const { default: html2canvas } = await import('html2canvas-pro')

      // 오프스크린 합성 div — 헤더 + 메타 정보 + 캡처 영역 cloneNode
      const offDiv = document.createElement('div')
      offDiv.style.cssText = [
        'position:fixed;left:-9999px;top:0;',
        'background:white;padding:20px;',
        'width:794px;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;',
        'color:#1a1a1a;line-height:1.4;',
      ].join('')

      const today = new Date().toLocaleDateString('ko-KR')
      const viewLabel = activeView === 'chart' ? '누적 손익 차트'
        : activeView === 'table' ? '20년 상세 테이블' : '유형별 비교'
      const addressLabel = mapResult?.address ?? '주소 미연동'

      // 헤더 + 입력 메타 (PDF 단독으로 봐도 맥락 이해 가능하도록)
      offDiv.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;border-bottom:2px solid #3b82f6;padding-bottom:10px">
          <span style="font-size:22px">📊</span>
          <div style="flex:1">
            <div style="font-size:18px;font-weight:bold;color:#1e293b">수익성 시뮬레이션 결과</div>
            <div style="font-size:11px;color:#64748b">SolarAdvisor v5.2 — ${today} 생성 · ${viewLabel}</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:11px">
          <tr style="background:#f8fafc">
            <td style="padding:5px 10px;color:#64748b;width:90px;border:1px solid #e2e8f0">📍 주소</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${addressLabel}</td>
            <td style="padding:5px 10px;color:#64748b;width:90px;border:1px solid #e2e8f0">설비 용량</td>
            <td style="padding:5px 10px;color:#1e293b;font-weight:bold;border:1px solid #e2e8f0">${capacityKw} kW</td>
          </tr>
          <tr>
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">설치 유형</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${installationType}</td>
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">총 사업비</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${fmt(totalCost)} 만원</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">총 대출</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${loanRatio}% (정책 ${Math.min(policyLoanRatio, loanRatio)}%@${policyLoanRate}% · 시중 ${Math.max(loanRatio - policyLoanRatio, 0)}%@${loanRate}%)</td>
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">대출 기간</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${loanYears}년</td>
          </tr>
          <tr>
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">SMP</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${priceOverride.smp.toFixed(2)} 원/kWh</td>
            <td style="padding:5px 10px;color:#64748b;border:1px solid #e2e8f0">발전 시간</td>
            <td style="padding:5px 10px;color:#1e293b;border:1px solid #e2e8f0">${effectiveGenHours} h/일${useKierData && kierPvHours ? ' (KIER 실측)' : ''}</td>
          </tr>
        </table>
      `

      // 캡처 영역 깊은 복제 (recharts SVG·table 포함)
      const cloned = src.cloneNode(true) as HTMLElement
      // 복제본의 button 등 인터랙티브 요소는 PDF에서 의미 없음 — 그대로 두되 가독성만 유지
      offDiv.appendChild(cloned)
      document.body.appendChild(offDiv)

      try {
        const captured = await html2canvas(offDiv, {
          scale: 2,
          backgroundColor: '#ffffff',
          useCORS: true,
          logging: false,
        })
        const pdf = new jsPDF('p', 'mm', 'a4')
        const pageW = pdf.internal.pageSize.getWidth()
        const pageH = pdf.internal.pageSize.getHeight()
        const margin = 8
        const printW = pageW - margin * 2
        const printH = (captured.height / captured.width) * printW

        // 페이지 분할 (긴 콘텐츠 대응 — 20년 테이블은 분할 필요)
        let yRemain = printH
        let srcY = 0
        while (yRemain > 0) {
          const sliceH = Math.min(pageH - margin * 2, yRemain)
          const slice = document.createElement('canvas')
          slice.width = captured.width
          slice.height = Math.round((sliceH / printW) * captured.width)
          const ctx = slice.getContext('2d')!
          ctx.drawImage(captured, 0, srcY, captured.width, slice.height, 0, 0, captured.width, slice.height)
          pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin, margin, printW, sliceH)
          yRemain -= sliceH
          srcY += slice.height
          if (yRemain > 0) pdf.addPage()
        }
        const addrSafe = (addressLabel || 'site').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)
        pdf.save(`수익성_${addrSafe}_${viewLabel}_${today.replace(/[.\s]/g, '')}.pdf`)
      } finally {
        document.body.removeChild(offDiv)
      }
    } catch (err) {
      console.error('PDF 생성 실패:', err)
      alert('PDF 생성 중 오류: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setPdfLoading(false)
    }
  }

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

          {/* KIER 실측 일사량 배지 */}
          {kierPvHours && (
            <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-xs font-semibold text-emerald-700 flex items-center gap-1">
                    ☀️ KIER 실측 일사량 연동
                  </div>
                  <div className="text-xs text-emerald-600 mt-0.5">
                    발전량 {kierPvHours}h/일
                    {kierGhi ? `  ·  GHI ${Math.round(kierGhi)} kWh/m²/년` : ''}
                    {' '}(기준 3.5h 대비 {kierPvHours >= 3.5 ? '+' : ''}{((kierPvHours - 3.5) / 3.5 * 100).toFixed(1)}%)
                  </div>
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useKierData}
                    onChange={e => setUseKierData(e.target.checked)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                  <span className="text-xs font-medium text-emerald-700">실측값 적용</span>
                </label>
              </div>
              {!useKierData && (
                <div className="mt-1.5 text-xs text-gray-400">기본값 3.5h/일로 계산 중</div>
              )}
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
                총 대출 비율: <span className="text-blue-600 font-bold">{loanRatio}%</span>
              </label>
              <input type="range" min={0} max={90} step={5} value={loanRatio}
                onChange={e => {
                  const v = Number(e.target.value)
                  setLoanRatio(v)
                  if (policyLoanRatio > v) setPolicyLoanRatio(v)
                }}
                className="w-full accent-blue-500"
              />
              <div className="text-xs text-gray-500 mt-1">
                자기자본: {fmt(equity)}만원 · 총 대출금: {fmt(totalCost * loanRatio / 100)}만원
              </div>
            </div>

            {/* 대출금리 2분할 */}
            <div className="rounded-lg border border-gray-200 p-3 space-y-3 bg-gray-50">
              <div className="text-xs font-semibold text-gray-600 mb-1">대출 금리 구분</div>

              {/* 정책금융 */}
              <div className="bg-blue-50 rounded-lg p-2.5 border border-blue-100">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-blue-700">🏦 정책금융</span>
                  <span className="text-xs text-blue-600">
                    {fmt(totalCost * Math.min(policyLoanRatio, loanRatio) / 100)}만원
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex-1">
                    <div className="text-xs text-gray-500 mb-0.5">
                      비율: <span className="font-bold text-blue-600">{Math.min(policyLoanRatio, loanRatio)}%</span>
                    </div>
                    <input type="range" min={0} max={loanRatio} step={5} value={Math.min(policyLoanRatio, loanRatio)}
                      onChange={e => setPolicyLoanRatio(Number(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                  </div>
                  <div className="w-20 flex-shrink-0">
                    <div className="text-xs text-gray-500 mb-0.5">금리 (%)</div>
                    <input type="number" min={0} max={5} step={0.1} value={policyLoanRate}
                      onChange={e => setPolicyLoanRate(Number(e.target.value))}
                      className="w-full border border-blue-200 rounded px-2 py-1 text-xs text-center bg-white"
                    />
                  </div>
                </div>
              </div>

              {/* 일반 대출 */}
              <div className="bg-orange-50 rounded-lg p-2.5 border border-orange-100">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-orange-700">🏛 일반(시중) 대출</span>
                  <span className="text-xs text-orange-600">
                    {fmt(totalCost * Math.max(loanRatio - policyLoanRatio, 0) / 100)}만원
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex-1">
                    <div className="text-xs text-gray-500 mb-0.5">
                      비율: <span className="font-bold text-orange-600">{Math.max(loanRatio - policyLoanRatio, 0)}%</span>
                      <span className="text-gray-400 ml-1">(자동 = 총 대출 − 정책)</span>
                    </div>
                    <div className="h-4 bg-orange-200 rounded-full mt-1.5">
                      <div
                        className="h-4 bg-orange-400 rounded-full transition-all"
                        style={{ width: `${loanRatio > 0 ? Math.max(loanRatio - policyLoanRatio, 0) / loanRatio * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-20 flex-shrink-0">
                    <div className="text-xs text-gray-500 mb-0.5">금리 (%)</div>
                    <input type="number" min={0} max={15} step={0.5} value={loanRate}
                      onChange={e => setLoanRate(Number(e.target.value))}
                      className="w-full border border-orange-200 rounded px-2 py-1 text-xs text-center bg-white"
                    />
                  </div>
                </div>
              </div>
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
          {/* Phase T: PDF 캡처 영역 — KPI + Revenue breakdown + Tabs (LCOE는 외부) */}
          <div ref={pdfRegionRef} className="space-y-4">
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
              <div className="text-xs opacity-70 mt-1">운영비 11,200원/kW·연 3% 상승</div>
            </div>
            <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl p-4 text-white">
              <div className="text-xs opacity-80 mb-1">손익분기점</div>
              <div className="text-xl font-bold">
                {breakevenYear > 0 ? `${breakevenYear}년차` : '20년 초과'}
              </div>
              <div className="text-xs opacity-70 mt-1">총 사업비 회수 기준</div>
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
                <div className="text-xs text-gray-400">{priceOverride.smp}원/kWh</div>
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
            <div className="flex border-b border-gray-200 items-stretch">
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
              {/* Phase T: PDF 저장 — 활성 탭 + KPI 4개 함께 출력 */}
              <button
                onClick={handleSavePDF}
                disabled={pdfLoading}
                className="px-3 py-2.5 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-60 flex items-center gap-1"
                title="현재 활성 탭과 KPI 지표를 A4 PDF로 저장"
              >
                {pdfLoading ? '생성 중…' : '↓ PDF'}
              </button>
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
                      {/* Phase U 보완: 손익분기 기준선 = 총 사업비 (이 선을 넘는 해가 투자금 회수 시점) */}
                      <ReferenceLine y={totalCost} stroke="#ef4444" strokeDasharray="4 4" label={{ value: `총 사업비 회수선 (${fmt(totalCost)}만원)`, position: 'right', fontSize: 10 }} />
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
                            { place: '일반토지형', rec: '1.2', fund: '조건부', note: '주거이격·농지전용 확인 필수', highlight: installationType === '일반토지형' },
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
          </div>{/* /pdfRegionRef — Phase T */}
        </div>
      </div>

      {/* ── LCOE·NPV 심화 분석 (RoiSummary — 20년 테이블과 중복 없는 추가 지표) ── */}
      <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-100 text-sm flex items-center gap-2">
              🔬 LCOE · NPV 심화 분석
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              균등화 발전비용(LCOE) · 순현재가치(NPV) · 배치 모드별 비교
              <span className="ml-2 text-slate-500">· 패널 {estimatedPanelCount}장 기준</span>
            </p>
          </div>
          <button
            onClick={() => setShowRoiSummary(v => !v)}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
            {showRoiSummary ? '접기' : '펼치기'}
          </button>
        </div>

        {showRoiSummary && (
          <RoiSummary
            roiResult={roiResult}
            panelCount={estimatedPanelCount}
            panelType="단결정 PERC 550W"
            optimizationResults={optimizationResults}
            optimalMode={optimalMode}
          />
        )}

        {!showRoiSummary && (
          <div className="grid grid-cols-3 gap-3 text-xs">
            {[
              { label: 'LCOE', value: `${roiResult.lcoeWon.toLocaleString()}원/kWh` },
              { label: 'NPV (4%)', value: `${roiResult.npvMan >= 0 ? '+' : ''}${roiResult.npvMan.toLocaleString()}만원` },
              { label: '회수기간', value: roiResult.paybackYears > 0 ? `${roiResult.paybackYears}년` : '—' },
            ].map(item => (
              <div key={item.label} className="bg-slate-800 rounded-lg px-3 py-2 text-center">
                <div className="text-slate-400">{item.label}</div>
                <div className="font-semibold text-slate-100 mt-0.5">{item.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* 이력 저장 버튼 */}
        {mapResult && (
          <div className="mt-4 pt-4 border-t border-slate-700">
            <button
              onClick={() => setShowSaveModal(true)}
              className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              💾 이 시뮬레이션 이력에 저장
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
