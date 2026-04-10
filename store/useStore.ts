import { create } from 'zustand'
import type { InstallationType } from '@/lib/constants'

interface MapResult {
  panelCount: number
  capacityKwp: number
  annualKwh: number
  area: number
  address: string
  tiltAngle: number
  moduleIndex: number
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
  loanRate: number
  setLoanRate: (rate: number) => void
  loanYears: number
  setLoanYears: (years: number) => void

  // Tab 5 → Tab 2 연동
  selectedPanelIndex: number | null
  setSelectedPanelIndex: (index: number | null) => void

  // KIER 실측 일사량 데이터
  kierPvHours: number | null   // pvPot / 365 (h/일), null = 기본값 3.5h 사용
  setKierPvHours: (h: number | null) => void
  kierGhi: number | null       // 수평면 전일사량 (kWh/m²/년)
  setKierGhi: (ghi: number | null) => void
  locationCoords: { lat: number; lon: number } | null
  setLocationCoords: (c: { lat: number; lon: number } | null) => void
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
  loanRate: 4.5,
  setLoanRate: (rate) => set({ loanRate: rate }),
  loanYears: 15,
  setLoanYears: (years) => set({ loanYears: years }),

  selectedPanelIndex: null,
  setSelectedPanelIndex: (index) => set({ selectedPanelIndex: index }),

  kierPvHours: null,
  setKierPvHours: (h) => set({ kierPvHours: h }),
  kierGhi: null,
  setKierGhi: (ghi) => set({ kierGhi: ghi }),
  locationCoords: null,
  setLocationCoords: (c) => set({ locationCoords: c }),
}))
