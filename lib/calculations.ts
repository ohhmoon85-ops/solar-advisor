import {
  SMP, REC_PRICE, REC_WEIGHT, GENERATION_HOURS, DEGRADATION_RATE,
  OP_COST_PER_KW, OP_COST_INFLATION_RATE,
  type InstallationType,
} from './constants'

export interface Revenue {
  annualKwh: number
  smpRevenue: number // 원
  recRevenue: number // 원
  total: number // 원
}

export interface YearlyData {
  year: number
  kwh: number
  totalRevenue: number // 만원
  loanPayment: number // 만원
  opCost: number // 만원
  netIncome: number // 만원
  cumulative: number // 만원
  isBreakeven: boolean
  isLoanPaid: boolean
}

export interface LoanResult {
  annualPayment: number // 원
  monthlyPayment: number // 원
}

export interface PriceParams {
  smp?: number        // 원/kWh (기본: SMP 상수)
  recBuilding?: number // 원/MWh (기본: REC_PRICE.건물지붕형)
  recLand?: number    // 원/MWh (기본: REC_PRICE.일반토지형)
}

export function calcAnnual(
  kW: number,
  type: InstallationType,
  genHours: number = GENERATION_HOURS,
  prices: PriceParams = {}
): Revenue {
  const smpPrice = prices.smp ?? SMP
  const recPriceBuilding = prices.recBuilding ?? REC_PRICE.건물지붕형
  const recPriceLand = prices.recLand ?? REC_PRICE.일반토지형

  const annualKwh = kW * genHours * 365
  const smpRevenue = annualKwh * smpPrice
  const recPrice = type === '건물지붕형' ? recPriceBuilding : recPriceLand
  const weight = REC_WEIGHT[type] ?? 1.0
  const recRevenue = (annualKwh / 1000) * recPrice * weight
  return { annualKwh, smpRevenue, recRevenue, total: smpRevenue + recRevenue }
}

export function calcLoan(principal: number, rate: number, years: number): LoanResult {
  if (rate === 0) {
    const monthly = principal / (years * 12)
    return { annualPayment: monthly * 12, monthlyPayment: monthly }
  }
  const r = rate / 100 / 12
  const n = years * 12
  const monthly = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  return { annualPayment: monthly * 12, monthlyPayment: monthly }
}

export function calcYearlyTable(
  kW: number,
  type: InstallationType,
  totalCost: number,          // 만원
  loanRatio: number,          // 총 대출 비율 (%)
  loanRate: number,           // 일반(시중) 대출 금리 (%)
  loanYears: number,
  genHours: number = GENERATION_HOURS,
  prices: PriceParams = {},
  policyLoanRatio: number = 0, // 정책금융 비율 (%, ≤ loanRatio)
  policyLoanRate: number = 0   // 정책금리 (%)
): YearlyData[] {
  const smpPrice = prices.smp ?? SMP
  const recPriceBuilding = prices.recBuilding ?? REC_PRICE.건물지붕형
  const recPriceLand = prices.recLand ?? REC_PRICE.일반토지형

  const clampedPolicyRatio = Math.min(policyLoanRatio, loanRatio)
  const commercialRatio = loanRatio - clampedPolicyRatio

  const equity = totalCost * (1 - loanRatio / 100)
  const policyAmount = totalCost * (clampedPolicyRatio / 100)   // 만원
  const commercialAmount = totalCost * (commercialRatio / 100)  // 만원

  const policyPayment = policyAmount > 0
    ? calcLoan(policyAmount * 10000, policyLoanRate, loanYears).annualPayment
    : 0
  const commercialPayment = commercialAmount > 0
    ? calcLoan(commercialAmount * 10000, loanRate, loanYears).annualPayment
    : 0
  const annualPayment = policyPayment + commercialPayment

  const rows: YearlyData[] = []
  // Phase U: 누적 = 순이익의 합 (자기자본 차감 X).
  // 시공사 검증 — 누적[1]은 1년 차 순이익과 동일해야 함.
  // 손익분기점(isBreakeven)은 "누적 ≥ 자기자본" = 자기자본 회수 시점으로 재정의.
  let cumulative = 0

  for (let year = 1; year <= 20; year++) {
    const degradationFactor = Math.pow(1 - DEGRADATION_RATE, year - 1)
    const kwhThisYear = kW * genHours * 365 * degradationFactor

    const smpRev = kwhThisYear * smpPrice
    const recPrice = type === '건물지붕형' ? recPriceBuilding : recPriceLand
    const weight = REC_WEIGHT[type] ?? 1.0
    const recRev = (kwhThisYear / 1000) * recPrice * weight
    const totalRevWon = smpRev + recRev
    const totalRevMan = totalRevWon / 10000

    const loanPaymentMan = year <= loanYears ? annualPayment / 10000 : 0
    // 운영비 = 설비용량(kW) × 11,200원/kW × (1.03)^(year-1)
    //   2026-05 시공사 표준 — 매출 × 2% 공식에서 변경
    //   매년 3% 물가상승률(인건비·자재비) 반영
    //   예: 123.54 kW → 1년차 138만원, 2년차 142만원, 3년차 147만원...
    const inflationFactor = Math.pow(1 + OP_COST_INFLATION_RATE, year - 1)
    const opCostMan = (kW * OP_COST_PER_KW / 10000) * inflationFactor
    const netIncomeMan = totalRevMan - loanPaymentMan - opCostMan

    cumulative += netIncomeMan

    // Phase U 보완: 손익분기 = 총 사업비 회수 시점 (누적 순이익 ≥ 총 투자금 첫 해)
    // 시공사 의도: "1.1억 투자금 만큼이 되는 해 = 5년 차 당시 1.1억 투자 대비 초과 누적이 된다"
    // → equity(자기자본 3,300) 가 아니라 totalCost(총 사업비 11,000)와 비교
    const isBreakeven = cumulative >= totalCost && (rows.length === 0 || rows[rows.length - 1].cumulative < totalCost)
    const isLoanPaid = year === loanYears + 1

    rows.push({
      year,
      kwh: Math.round(kwhThisYear),
      totalRevenue: Math.round(totalRevMan),
      loanPayment: Math.round(loanPaymentMan),
      opCost: Math.round(opCostMan),
      netIncome: Math.round(netIncomeMan),
      cumulative: Math.round(cumulative),
      isBreakeven,
      isLoanPaid,
    })
  }

  return rows
}

/**
 * 20년 ROI (자기자본 기준) — 자기자본 대비 순수익률
 * Phase U: cumulative가 순이익의 합으로 정의 변경됨에 따라 ROI 분자를
 * (누적 - 자기자본) 으로 보정 → 의미(자기자본 대비 수익률) 보존
 */
export function calcROI(rows: YearlyData[], equity: number): number {
  if (equity <= 0) return 0
  const totalNet = rows[rows.length - 1].cumulative
  return Math.round(((totalNet - equity) / equity) * 100)
}

/**
 * 손익분기점 = 누적 순이익이 임계값을 회수하는 첫 해
 * Phase U 보완: threshold = 총 사업비 (totalCost) 또는 자기자본(equity) 등 호출처에서 결정
 *   RevenueTab은 totalCost(총 투자금) 사용 — 시공사 의도 "투자금 회수 시점"
 * 미지정 시 threshold=0 으로 동작 (레거시 호환)
 */
export function findBreakevenYear(rows: YearlyData[], threshold = 0): number {
  for (const row of rows) {
    if (row.cumulative >= threshold) return row.year
  }
  return -1
}