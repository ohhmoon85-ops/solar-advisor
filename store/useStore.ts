import { create } from 'zustand'
import { SMP, REC_PRICE } from '@/lib/constants'
import type { InstallationType } from '@/lib/constants'

const PRICE_LS_KEY = 'solar_price_overrides'

interface MapResult {
  panelCount: number
  capacityKwp: number
  annualKwh: number
  area: number
  address: string
  tiltAngle: number
  moduleIndex: number
}

export interface PriceOverride {
  smp: number
  recBuilding: number
  recLand: number
  lastUpdated: string
}

interface SolarStore {
  activeTab: string
  setActiveTab: (tab: string) => void

  // Tab 1 → Tab 2 연동
  mapResult: MapResult | null
  setMapResult: (result: MapResult) => void

  // Tab 2 state
  capacityKw: number
  setCapacityKw: (kw: number) => void
  installationType: InstallationType
  setInstallationType: (type: InstallationType) => void
  totalCost: number
  setTotalCost: (cost: number) => void
  loanRatio: number
  setLoanRatio: (ratio: number) => void
  policyLoanRatio: number        // 정책금융 비율 (총 사업비 대비 %)
  setPolicyLoanRatio: (ratio: number) => void
  policyLoanRate: number         // 정책금리 (%)
  setPolicyLoanRate: (rate: number) => void
  loanRate: number               // 일반(시중) 대출 금리 (%)
  setLoanRate: (rate: number) => void
  loanYears: number
  setLoanYears: (years: number) => void

  // KIER 실측 일사량 데이터
  kierPvHours: number | null
  setKierPvHours: (h: number | null) => void
  kierGhi: number | null
  setKierGhi: (ghi: number | null) => void
  locationCoords: { lat: number; lon: number } | null
  setLocationCoords: (c: { lat: number; lon: number } | null) => void

  // 단가 관리 (SMP / REC)
  priceOverride: PriceOverride
  setPriceOverride: (p: PriceOverride) => void
}

const DEFAULT_PRICE: PriceOverride = {
  smp: SMP,
  recBuilding: REC_PRICE.건물지붕형,
  recLand: REC_PRICE.일반토지형,
  lastUpdated: '2026-01-15',
}

function loadPriceOverride(): PriceOverride {
  if (typeof window === 'undefined') return DEFAULT_PRICE
  try {
    const raw = localStorage.getItem(PRICE_LS_KEY)
    if (raw) return { ...DEFAULT_PRICE, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return DEFAULT_PRICE
}

export const useSolarStore = create<SolarStore>((set) => ({
  activeTab: 'map',
  setActiveTab: (tab) => set({ activeTab: tab }),

  mapResult: null,
  setMapResult: (result) => set({ mapResult: result, capacityKw: result.capacityKwp }),

  capacityKw: 100,
  setCapacityKw: (kw) => set({ capacityKw: kw }),
  installationType: '건물지붕형',
  setInstallationType: (type) => set({ installationType: type }),
  totalCost: 16000,
  setTotalCost: (cost) => set({ totalCost: cost }),
  loanRatio: 75,
  setLoanRatio: (ratio) => set({ loanRatio: ratio }),
  policyLoanRatio: 70,
  setPolicyLoanRatio: (ratio) => set({ policyLoanRatio: ratio }),
  policyLoanRate: 2.0,
  setPolicyLoanRate: (rate) => set({ policyLoanRate: rate }),
  loanRate: 4.5,
  setLoanRate: (rate) => set({ loanRate: rate }),
  loanYears: 15,
  setLoanYears: (years) => set({ loanYears: years }),

  kierPvHours: null,
  setKierPvHours: (h) => set({ kierPvHours: h }),
  kierGhi: null,
  setKierGhi: (ghi) => set({ kierGhi: ghi }),
  locationCoords: null,
  setLocationCoords: (c) => set({ locationCoords: c }),

  priceOverride: DEFAULT_PRICE,
  setPriceOverride: (p) => {
    try { localStorage.setItem(PRICE_LS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
    set({ priceOverride: p })
  },
}))