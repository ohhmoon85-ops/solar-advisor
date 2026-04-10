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
}))
