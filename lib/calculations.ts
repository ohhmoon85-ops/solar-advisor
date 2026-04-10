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

export function calcAnnual(
  kW: number,
  type: InstallationType,
  genHours: number = GENERATION_HOURS  // KIER 실측값 또는 기본값 3.5h
): Revenue {
  const annualKwh = kW * genHours * 365
  const smpRevenue = annualKwh * SMP
  const recPrice = type === '건물지붕형' ? REC_PRICE.건물지붕형 : REC_PRICE.일반토지형
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
  totalCost: number, // 만원
  loanRatio: number, // %
  loanRate: number, // %
  loanYears: number,
  genHours: number = GENERATION_HOURS  // KIER 실측값 또는 기본값 3.5h
): YearlyData[] {
  const equity = totalCost * (1 - loanRatio / 100) // 자기자본 (만원)
  const loanAmount = totalCost * (loanRatio / 100) // 대출금 (만원)
  const { annualPayment } = calcLoan(loanAmount * 10000, loanRate, loanYears) // 원 단위

  const rows: YearlyData[] = []
  let cumulative = -equity // 자기자본 투입으로 시작

  for (let year = 1; year <= 20; year++) {
    const degradationFactor = Math.pow(1 - DEGRADATION_RATE, year - 1)
    const kwhThisYear = kW * genHours * 365 * degradationFactor

    const smpRev = kwhThisYear * SMP
    const recPrice = type === '건물지붕형' ? REC_PRICE.건물지붕형 : REC_PRICE.일반토지형
    const weight = REC_WEIGHT[type] ?? 1.0
    const recRev = (kwhThisYear / 1000) * recPrice * weight
    const totalRevWon = smpRev + recRev // 원
    const totalRevMan = totalRevWon / 10000 // 만원

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
