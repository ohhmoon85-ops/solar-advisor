import { SMP, REC_PRICE, REC_WEIGHT, GENERATION_HOURS, DEGRADATION_RATE, OP_COST_RATE, type InstallationType } from './constants'

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
  let cumulative = -equity

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
    const opCostMan = totalRevMan * OP_COST_RATE
    const netIncomeMan = totalRevMan - loanPaymentMan - opCostMan

    cumulative += netIncomeMan

    const isBreakeven = cumulative >= 0 && (rows.length === 0 || rows[rows.length - 1].cumulative < 0)
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

export function calcROI(rows: YearlyData[], equity: number): number {
  const totalNet = rows[rows.length - 1].cumulative
  return Math.round((totalNet / equity) * 100)
}

export function findBreakevenYear(rows: YearlyData[]): number {
  for (const row of rows) {
    if (row.cumulative >= 0) return row.year
  }
  return -1
}