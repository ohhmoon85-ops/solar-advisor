// lib/roiAnalyzer.ts — LCOE·NPV·최적 패널 수 분석 모듈
// lib/calculations.ts의 20년 현금흐름 계산과 중복되지 않도록,
// 이 모듈은 LCOE·NPV·패널 수 최적화에만 집중합니다

import type { LayoutResult } from './layoutEngine'

// ── 타입 ───────────────────────────────────────────────────────────

export interface RoiInput {
  panelCount: number           // 패널 수
  wattNominal: number          // 패널 공칭 출력 (W)
  /** 패널 단가 (원/장) */
  costPerPanel: number
  /** 기본 시공비 (원/kWp) */
  installCostPerKwp: number
  /** 연간 유지비 (원) — 0이면 설치비의 1% 자동 계산 */
  annualMaintenanceCost?: number
  /** 전력 판매 단가 (원/kWh) — SMP + REC 합산 */
  electricityPriceKrw: number
  /** 연간 출력 열화율 (%) — 기본 0.5% */
  annualDegradationPct?: number
  /** 분석 기간 (년) — 기본 20 */
  analysisYears?: number
  /** 할인율 (%) — NPV 계산 기준, 기본 4% */
  discountRatePct?: number
}

export interface RoiResult {
  totalCostMan: number         // 총 투자비 (만원)
  annualKwh: number            // 1년차 발전량 (kWh)
  annualRevenueMan: number     // 1년차 수익 (만원)
  paybackYears: number         // 투자회수기간 (년), -1=회수 불가
  roi20yr: number              // 20년 ROI (%)
  lcoeWon: number              // LCOE (원/kWh)
  npvMan: number               // NPV (만원)
  totalKwp: number             // 설치 용량 (kWp)
  /** 연도별 누적 수익 (만원) — 차트용 */
  yearlyRevenues: { year: number; cumulative: number }[]
}

export type OptimizationMode = 'Dense' | 'Efficiency' | 'Balanced'

export interface OptimalResult {
  mode: OptimizationMode
  panelCount: number
  roi: RoiResult
  lcoe: number
}

// ── 기본값 ─────────────────────────────────────────────────────────

const DEFAULTS = {
  costPerPanelTypeA: 200000,       // 원/장
  costPerPanelTypeB: 240000,       // 원/장
  installCostPerKwp: 500000,       // 원/kWp (시공비)
  electricityPriceKrw: 130,        // 원/kWh (SMP+REC 보수적 추정)
  annualDegradationPct: 0.5,
  analysisYears: 20,
  discountRatePct: 4.0,
  annualPeakHours: 1400,           // h/yr
  systemEfficiency: 0.8,
}

export { DEFAULTS as ROI_DEFAULTS }

// ── 핵심 계산 함수 ─────────────────────────────────────────────────

/**
 * ROI 전체 지표 계산
 * calculations.ts의 20년 현금흐름 테이블과 별개로,
 * LCOE·NPV·투자회수기간에 특화된 분석을 제공합니다
 */
export function calculateRoi(input: RoiInput): RoiResult {
  const {
    panelCount,
    wattNominal,
    costPerPanel,
    installCostPerKwp,
    electricityPriceKrw,
    annualDegradationPct = DEFAULTS.annualDegradationPct,
    analysisYears = DEFAULTS.analysisYears,
    discountRatePct = DEFAULTS.discountRatePct,
  } = input

  const totalKwp = (panelCount * wattNominal) / 1000

  // 총 투자비 (원)
  const panelCost = panelCount * costPerPanel
  const installCost = totalKwp * installCostPerKwp
  const totalCostWon = panelCost + installCost
  const totalCostMan = totalCostWon / 10000

  // 연간 유지비 (원)
  const annualMaint =
    input.annualMaintenanceCost !== undefined
      ? input.annualMaintenanceCost
      : totalCostWon * 0.01

  // 1년차 발전량·수익
  const annualKwh =
    totalKwp * DEFAULTS.annualPeakHours * DEFAULTS.systemEfficiency
  const annualRevenueWon = annualKwh * electricityPriceKrw
  const annualRevenueMan = annualRevenueWon / 10000

  // 연도별 누적 수익 및 NPV
  const degFactor = 1 - annualDegradationPct / 100
  const discountRate = discountRatePct / 100

  let cumulativeWon = -totalCostWon
  let npvWon = -totalCostWon
  let paybackYears = -1
  const yearlyRevenues: { year: number; cumulative: number }[] = []
  let totalLifetimeKwh = 0

  for (let yr = 1; yr <= analysisYears; yr++) {
    const kwhThisYear = annualKwh * Math.pow(degFactor, yr - 1)
    const revenueWon = kwhThisYear * electricityPriceKrw
    const netWon = revenueWon - annualMaint
    cumulativeWon += netWon
    npvWon += netWon / Math.pow(1 + discountRate, yr)
    totalLifetimeKwh += kwhThisYear

    if (paybackYears === -1 && cumulativeWon >= 0) paybackYears = yr
    yearlyRevenues.push({ year: yr, cumulative: Math.round(cumulativeWon / 10000) })
  }

  // LCOE (원/kWh)
  const lcoeWon = totalLifetimeKwh > 0
    ? Math.round(totalCostWon / totalLifetimeKwh)
    : 0

  // 20년 ROI (%)
  const roi20yr =
    totalCostWon > 0
      ? Math.round((cumulativeWon / totalCostWon) * 100)
      : 0

  return {
    totalCostMan: Math.round(totalCostMan),
    annualKwh: Math.round(annualKwh),
    annualRevenueMan: Math.round(annualRevenueMan),
    paybackYears,
    roi20yr,
    lcoeWon,
    npvMan: Math.round(npvWon / 10000),
    totalKwp: Math.round(totalKwp * 100) / 100,
    yearlyRevenues,
  }
}

/**
 * kWp 비율 검증
 * 패널 수 × 공칭 출력이 신고 kWp와 1% 이내 오차인지 확인
 * @param panelCount 패널 수
 * @param wattNominal 패널 공칭 출력 (W)
 * @param reportedKwp 신고·계획 kWp
 * @returns true = 정상 (오차 < 1%), false = 불일치
 */
export function validateKwpRatio(
  panelCount: number,
  wattNominal: number,
  reportedKwp: number
): boolean {
  if (reportedKwp <= 0) return false
  const expectedKwp = (panelCount * wattNominal) / 1000
  const errorRatio = Math.abs(expectedKwp - reportedKwp) / reportedKwp
  return errorRatio < 0.01  // 1% 이내
}

/**
 * 배치 결과에서 3가지 모드(Dense/Efficiency/Balanced)별 최적 패널 수 비교
 * LCOE가 가장 낮은 모드를 optimalMode로 반환
 */
export function findOptimalPanelCount(
  layoutResult: LayoutResult,
  priceInput: {
    wattNominal: number
    costPerPanel: number
    installCostPerKwp: number
    electricityPriceKrw: number
  }
): { results: OptimalResult[]; optimalMode: OptimizationMode } {
  const totalPanels = layoutResult.totalCount

  const modeRatios: Record<OptimizationMode, number> = {
    Dense: 1.0,          // 전체 패널
    Balanced: 0.8,       // 80%
    Efficiency: 0.6,     // 60% (간격 넓혀 연간 발전 효율 우선)
  }

  const results: OptimalResult[] = (
    ['Dense', 'Balanced', 'Efficiency'] as OptimizationMode[]
  ).map(mode => {
    const count = Math.max(1, Math.round(totalPanels * modeRatios[mode]))
    const roi = calculateRoi({ panelCount: count, ...priceInput })
    return { mode, panelCount: count, roi, lcoe: roi.lcoeWon }
  })

  const optimalMode = results.reduce((best, cur) =>
    cur.lcoe < best.lcoe ? cur : best
  ).mode

  return { results, optimalMode }
}
