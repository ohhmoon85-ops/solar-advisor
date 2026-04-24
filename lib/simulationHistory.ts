// lib/simulationHistory.ts — 시뮬레이션 이력 관리 엔진 (v1.0)
// 저장: localStorage (1차) / JSON·CSV 내보내기 (2차, 백업·기기 이전용)
// 서버 DB 사용 없음 — 인터넷 없는 현장 환경 고려

import type { PlotType } from './layoutEngine'

// ── 타입 정의 ───────────────────────────────────────────────────────

export interface SimulationRecord {
  id: string                     // crypto.randomUUID()
  savedAt: string                // ISO 날짜문자열

  clientName?: string            // 수요자 이름 (선택)
  clientMemo?: string            // 메모 (예: "재상담 예정", "계약 완료")
  memoColor?: 'green' | 'blue' | 'gray' | 'default'  // 카드 좌측 테두리 색

  // 주소·위치
  address: string
  latitude: number
  region: string                 // 예: "남부(경상/전라)"

  // 부지 정보
  plotAreaM2: number
  plotType: PlotType
  jimokLabel?: string
  isJimokChangePlanned: boolean
  hasRiverBoundary: boolean
  hasRoadBoundary: boolean

  // 패널 설정
  panelId: string                // 예: "TYPE_A"
  panelLabel: string             // 예: "TYPE A (640~665W)"
  azimuthDeg: number
  slopeAngleDeg?: number
  tiltAngle: number              // 최적 경사각

  // 배치 결과
  rowSpacing: number
  totalPanels: number
  totalKwp: number
  utilizationRate: number
  layoutMode: 'dense' | 'efficiency' | 'balanced'
  isManuallyEdited: boolean
  zoneCount: number

  // ROI 결과
  totalCostKrw: number
  annualKwh: number
  annualRevenueKrw: number
  paybackYears: number
  roi20yr: number                // 20년 ROI (%)
  lcoe: number

  // 원본 데이터 (재로드용)
  fullAnalysisSnapshot: string   // FullAnalysisResult | MultiZoneResult JSON
  editorStateSnapshot?: string   // EditorState JSON (수동 편집 시)
}

export interface HistoryStats {
  totalCount: number
  totalKwpSum: number
  avgPaybackYears: number
  mostUsedPanelType: string
  regionDistribution: Record<string, number>
}

export interface FilterOptions {
  dateFrom?: string
  dateTo?: string
  plotType?: PlotType
  minKwp?: number
  maxKwp?: number
  layoutMode?: string
  region?: string
}

// ── 상수 ────────────────────────────────────────────────────────────

export const HISTORY_STORAGE_KEY = 'solarAdvisor_history'
const MAX_HISTORY_COUNT = 200
const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024  // 5MB

// ── 내부 헬퍼 ───────────────────────────────────────────────────────

function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false
  try {
    localStorage.setItem('__test__', '1')
    localStorage.removeItem('__test__')
    return true
  } catch {
    return false
  }
}

function loadRaw(): SimulationRecord[] {
  if (!isLocalStorageAvailable()) return []
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as SimulationRecord[]
  } catch {
    return []
  }
}

function saveRaw(records: SimulationRecord[]): void {
  if (!isLocalStorageAvailable()) return
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records))
  } catch (e: unknown) {
    console.error('[simulationHistory] 저장 실패:', e)
    throw new Error('QUOTA_EXCEEDED')
  }
}

function checkQuota(incoming: SimulationRecord): boolean {
  if (!isLocalStorageAvailable()) return true
  try {
    const current = localStorage.getItem(HISTORY_STORAGE_KEY) ?? '[]'
    const added = JSON.stringify(incoming)
    return (current.length + added.length) < STORAGE_LIMIT_BYTES
  } catch {
    return false
  }
}

function formatDateForFilename(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

// ── 공개 API ────────────────────────────────────────────────────────

/**
 * 이력 저장
 * 200건 초과 시 가장 오래된 것부터 자동 삭제
 * 저장 용량 5MB 초과 시 에러 throw
 */
export function saveSimulation(
  record: Omit<SimulationRecord, 'id' | 'savedAt'>
): SimulationRecord {
  if (!isLocalStorageAvailable()) {
    throw new Error('STORAGE_UNAVAILABLE')
  }

  const newRecord: SimulationRecord = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    savedAt: new Date().toISOString(),
    ...record,
  }

  if (!checkQuota(newRecord)) {
    throw new Error('QUOTA_EXCEEDED')
  }

  const all = loadRaw()
  const trimmed = [newRecord, ...all].slice(0, MAX_HISTORY_COUNT)
  saveRaw(trimmed)
  return newRecord
}

/** 전체 이력 조회 (최신순) */
export function getAllSimulations(): SimulationRecord[] {
  return loadRaw().sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** ID로 단건 조회 */
export function getSimulationById(id: string): SimulationRecord | null {
  return loadRaw().find(r => r.id === id) ?? null
}

/** 메타정보 수정 (clientName, clientMemo, memoColor 등) */
export function updateSimulation(id: string, updates: Partial<SimulationRecord>): void {
  const all = loadRaw()
  const idx = all.findIndex(r => r.id === id)
  if (idx < 0) return
  all[idx] = { ...all[idx], ...updates, id, savedAt: all[idx].savedAt }
  saveRaw(all)
}

/** 단건 삭제 */
export function deleteSimulation(id: string): void {
  saveRaw(loadRaw().filter(r => r.id !== id))
}

/** 전체 삭제 */
export function deleteAllSimulations(): void {
  if (!isLocalStorageAvailable()) return
  try { localStorage.removeItem(HISTORY_STORAGE_KEY) } catch { /* ignore */ }
}

/** 텍스트 검색 (address, clientName, clientMemo) */
export function searchSimulations(query: string): SimulationRecord[] {
  if (!query.trim()) return getAllSimulations()
  const q = query.trim().toLowerCase()
  return getAllSimulations().filter(r =>
    r.address.toLowerCase().includes(q) ||
    (r.clientName ?? '').toLowerCase().includes(q) ||
    (r.clientMemo ?? '').toLowerCase().includes(q)
  )
}

/** 복합 필터 */
export function filterSimulations(filters: FilterOptions): SimulationRecord[] {
  return getAllSimulations().filter(r => {
    if (filters.dateFrom && r.savedAt < filters.dateFrom) return false
    if (filters.dateTo && r.savedAt > filters.dateTo + 'T23:59:59') return false
    if (filters.plotType && r.plotType !== filters.plotType) return false
    if (filters.minKwp !== undefined && r.totalKwp < filters.minKwp) return false
    if (filters.maxKwp !== undefined && r.totalKwp > filters.maxKwp) return false
    if (filters.layoutMode && r.layoutMode !== filters.layoutMode) return false
    if (filters.region && r.region !== filters.region) return false
    return true
  })
}

/** 통계 요약 */
export function getStatsSummary(): HistoryStats {
  const all = getAllSimulations()
  if (all.length === 0) {
    return { totalCount: 0, totalKwpSum: 0, avgPaybackYears: 0, mostUsedPanelType: '-', regionDistribution: {} }
  }

  const totalKwpSum = all.reduce((s, r) => s + r.totalKwp, 0)
  const validPayback = all.filter(r => r.paybackYears > 0)
  const avgPaybackYears = validPayback.length > 0
    ? validPayback.reduce((s, r) => s + r.paybackYears, 0) / validPayback.length
    : 0

  const panelCount: Record<string, number> = {}
  const regionCount: Record<string, number> = {}
  for (const r of all) {
    panelCount[r.panelLabel] = (panelCount[r.panelLabel] ?? 0) + 1
    regionCount[r.region] = (regionCount[r.region] ?? 0) + 1
  }
  const mostUsedPanelType = Object.entries(panelCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-'

  return { totalCount: all.length, totalKwpSum, avgPaybackYears, mostUsedPanelType, regionDistribution: regionCount }
}

// ── 내보내기·가져오기 ────────────────────────────────────────────────

/** 전체 이력 → JSON 파일 다운로드 */
export function exportToJson(): void {
  const all = getAllSimulations()
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `solarpath_history_${formatDateForFilename(new Date())}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * JSON 파일 가져오기 → 기존 이력에 병합 (id 중복 제외)
 * @returns 가져온 건수
 */
export function importFromJson(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string) as SimulationRecord[]
        if (!Array.isArray(data)) throw new Error('올바른 형식이 아닙니다')
        const existing = loadRaw()
        const existingIds = new Set(existing.map(r => r.id))
        const newOnes = data.filter(r => r.id && r.savedAt && !existingIds.has(r.id))
        const merged = [...newOnes, ...existing]
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
          .slice(0, MAX_HISTORY_COUNT)
        saveRaw(merged)
        resolve(newOnes.length)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('파일 읽기 실패'))
    reader.readAsText(file)
  })
}

/** 전체 이력 → CSV 파일 다운로드 (Excel 한글 BOM 포함) */
export function exportToCsv(): void {
  const all = getAllSimulations()

  const headers = [
    '저장일시', '수요자명', '메모', '주소', '권역',
    '부지면적(m²)', '설치유형', '패널모델',
    '설치장수', '설치용량(kWp)', '최적경사각(°)',
    '이격거리(m)', '총설치비(만원)', '연간수익(만원)',
    '투자회수(년)', '20년ROI(%)',
  ]

  function esc(v: string | number | undefined): string {
    const s = String(v ?? '')
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }

  function fmtDate(iso: string): string {
    try {
      const d = new Date(iso)
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
    } catch { return iso }
  }

  // 하위호환: farmland/forest/land_change_planned는 신규 입력 불가,
  // 과거 저장 레코드의 CSV 내보내기를 위해 매핑 유지
  const plotTypeLabel: Record<string, string> = {
    land: '일반토지형', roof: '건물지붕형',
    farmland: '영농형농지', forest: '임야형',
    land_change_planned: '지목변경예정',
  }

  const rows = all.map(r => [
    fmtDate(r.savedAt),
    r.clientName ?? '',
    r.clientMemo ?? '',
    r.address,
    r.region,
    r.plotAreaM2.toFixed(0),
    plotTypeLabel[r.plotType] ?? r.plotType,
    r.panelLabel,
    r.totalPanels,
    r.totalKwp.toFixed(2),
    r.tiltAngle,
    r.rowSpacing.toFixed(2),
    Math.round(r.totalCostKrw / 10000),
    Math.round(r.annualRevenueKrw / 10000),
    r.paybackYears > 0 ? r.paybackYears.toFixed(1) : '회수불가',
    r.roi20yr.toFixed(1),
  ].map(v => esc(v as string)))

  const csvContent = [headers.map(h => esc(h)).join(','), ...rows.map(r => r.join(','))].join('\r\n')

  // UTF-8 BOM → Excel 한글 깨짐 방지
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `solarpath_history_${formatDateForFilename(new Date())}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** localStorage 사용 가능 여부 */
export { isLocalStorageAvailable }
