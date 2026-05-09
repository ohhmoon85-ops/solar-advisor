import { create } from 'zustand'
import { SMP, REC_PRICE } from '@/lib/constants'
import type { SpacingPolicy } from '@/lib/layoutEngine'
import type { InstallationType } from '@/lib/constants'
import type { SimulationRecord } from '@/lib/simulationHistory'

const PRICE_LS_KEY = 'solar_price_overrides'

// ── Phase C-1: 지붕 폴리곤 그리기 타입 ─────────────────────────────
export interface GeoPoint { lng: number; lat: number }

export interface RoofPolygon {
  id: string
  points: GeoPoint[]
  areaM2: number
}

/** 경위도 폴리곤 면적 계산 (Shoelace, Equirectangular 근사) */
function calcGeoPolygonAreaM2(points: GeoPoint[]): number {
  if (points.length < 3) return 0
  const cLat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const cLon = points.reduce((s, p) => s + p.lng, 0) / points.length
  const mpdLonVal = 111319.9 * Math.cos((cLat * Math.PI) / 180)
  const MPD_LAT_V = 111319.9
  const local = points.map(p => ({
    x: (p.lng - cLon) * mpdLonVal,
    y: (p.lat - cLat) * MPD_LAT_V,
  }))
  let area = 0
  for (let i = 0; i < local.length; i++) {
    const j = (i + 1) % local.length
    area += local[i].x * local[j].y - local[j].x * local[i].y
  }
  return Math.abs(area / 2)
}

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

  // 단수별 그늘 정책
  spacingPolicy: SpacingPolicy
  setSpacingPolicy: (policy: SpacingPolicy) => void
  constructionStdGap: number | undefined
  setConstructionStdGap: (gap: number | undefined) => void
  userBoundaryMargin: number | undefined
  setUserBoundaryMargin: (margin: number | undefined) => void
  userRowSpacing: number | undefined
  setUserRowSpacing: (spacing: number | undefined) => void
  userFirstStackGap: number | undefined
  setUserFirstStackGap: (gap: number | undefined) => void

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

  /** /api/smp 실시간 응답값 (KPX) — 헤더·ParcelInfoCard·PDF 공통 단일 소스 */
  liveSmp: number | null
  liveSmpFetchedAt: number | null
  setLiveSmp: (smp: number | null) => void

  // ── 시뮬레이션 이력 ─────────────────────────────────────────────
  /** SVG 정밀 분석 최신 결과 JSON (저장 모달에서 snapshot으로 사용) */
  lastFullAnalysisJson: string | null
  setLastFullAnalysisJson: (json: string | null) => void

  /** 정밀 분석 실행 시 설정된 주소 레이블 (도면 탭 표제란용) */
  lastAnalysisAddress: string | null
  setLastAnalysisAddress: (a: string | null) => void

  /** 이력 패널(드로어) 열림 상태 */
  historyPanelOpen: boolean
  setHistoryPanelOpen: (open: boolean) => void

  /** 저장 모달 열림 상태 */
  showSaveModal: boolean
  setShowSaveModal: (show: boolean) => void

  /** 이력에서 불러오기 대기 중인 record */
  pendingRestore: SimulationRecord | null
  setPendingRestore: (r: SimulationRecord | null) => void

  /** 이력 건수 (헤더 버튼 배지용) */
  historyCount: number
  setHistoryCount: (n: number) => void

  // ── Phase C-1: 지붕 폴리곤 그리기 ────────────────────────────────
  roofPolygons: RoofPolygon[]
  drawingMode: boolean
  currentDrawingPoints: GeoPoint[]
  setDrawingMode: (on: boolean) => void
  addDrawingPoint: (point: GeoPoint) => void
  popDrawingPoint: () => void
  clearDrawing: () => void
  commitPolygon: () => void
  removePolygon: (id: string) => void
  clearAllPolygons: () => void
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

  spacingPolicy: 'construction_std' as SpacingPolicy,
  setSpacingPolicy: (policy) => set({ spacingPolicy: policy }),
  constructionStdGap: undefined,
  setConstructionStdGap: (gap) => set({ constructionStdGap: gap }),
  userBoundaryMargin: undefined,
  setUserBoundaryMargin: (margin) => set({ userBoundaryMargin: margin }),
  userRowSpacing: undefined,
  setUserRowSpacing: (spacing) => set({ userRowSpacing: spacing }),
  userFirstStackGap: undefined,
  setUserFirstStackGap: (gap) => set({ userFirstStackGap: gap }),

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

  liveSmp: null,
  liveSmpFetchedAt: null,
  setLiveSmp: (smp) => set({ liveSmp: smp, liveSmpFetchedAt: smp != null ? Date.now() : null }),

  lastFullAnalysisJson: null,
  setLastFullAnalysisJson: (json) => set({ lastFullAnalysisJson: json }),

  lastAnalysisAddress: null,
  setLastAnalysisAddress: (a) => set({ lastAnalysisAddress: a }),

  historyPanelOpen: false,
  setHistoryPanelOpen: (open) => set({ historyPanelOpen: open }),

  showSaveModal: false,
  setShowSaveModal: (show) => set({ showSaveModal: show }),

  pendingRestore: null,
  setPendingRestore: (r) => set({ pendingRestore: r }),

  historyCount: 0,
  setHistoryCount: (n) => set({ historyCount: n }),

  // ── Phase C-1: 지붕 폴리곤 그리기 ────────────────────────────────
  roofPolygons: [],
  drawingMode: false,
  currentDrawingPoints: [],
  setDrawingMode: (on) => set({ drawingMode: on }),
  addDrawingPoint: (point) => set(s => ({ currentDrawingPoints: [...s.currentDrawingPoints, point] })),
  popDrawingPoint: () => set(s => ({ currentDrawingPoints: s.currentDrawingPoints.slice(0, -1) })),
  clearDrawing: () => set({ currentDrawingPoints: [] }),
  commitPolygon: () => set(s => {
    if (s.currentDrawingPoints.length < 3) return {}
    const areaM2 = calcGeoPolygonAreaM2(s.currentDrawingPoints)
    return {
      roofPolygons: [...s.roofPolygons, {
        id: `roof-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        points: [...s.currentDrawingPoints],
        areaM2,
      }],
      currentDrawingPoints: [],
    }
  }),
  removePolygon: (id) => set(s => ({ roofPolygons: s.roofPolygons.filter(p => p.id !== id) })),
  clearAllPolygons: () => set({ roofPolygons: [] }),
}))
