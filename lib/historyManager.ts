// lib/historyManager.ts — 현장 분석 이력 관리 (localStorage 기반)

const LS_KEY = 'solar_site_history'
const MAX_ENTRIES = 50

export interface HistoryEntry {
  id: string
  savedAt: string        // ISO timestamp
  addresses: string[]    // 입력한 지번 목록
  parcelLabel: string    // VWorld 공식 레이블 (예: "경기도 용인시 ...")
  installType: string    // 건물지붕형 | 일반토지형 | ...
  moduleIndex: number
  tiltAngle: number
  panelCount: number
  capacityKwp: number
  annualKwh: number
  areaSqm: number
  lat?: number
  lon?: number
  memo: string           // 현장 메모 (사용자 입력)
}

function loadAll(): HistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as HistoryEntry[]
  } catch {
    return []
  }
}

function saveAll(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries))
  } catch { /* ignore quota errors */ }
}

/** 전체 이력 조회 (최신순) */
export function getHistory(): HistoryEntry[] {
  return loadAll().sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** 이력 저장 (동일 주소+유형이면 덮어쓰기, 없으면 앞에 추가) */
export function saveHistory(
  entry: Omit<HistoryEntry, 'id' | 'savedAt' | 'memo'>
): HistoryEntry {
  const all = loadAll()

  // 동일 대표 주소 + 설치 유형 → 기존 항목 업데이트 (메모 유지)
  const key = entry.addresses.filter(Boolean).join('|') + '|' + entry.installType
  const existIdx = all.findIndex(
    e => e.addresses.filter(Boolean).join('|') + '|' + e.installType === key
  )

  const now = new Date().toISOString()
  if (existIdx >= 0) {
    const updated: HistoryEntry = {
      ...all[existIdx],
      ...entry,
      savedAt: now,
    }
    all[existIdx] = updated
    saveAll(all)
    return updated
  }

  const newEntry: HistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: now,
    memo: '',
    ...entry,
  }

  const trimmed = [newEntry, ...all].slice(0, MAX_ENTRIES)
  saveAll(trimmed)
  return newEntry
}

/** 메모 수정 */
export function updateMemo(id: string, memo: string): void {
  const all = loadAll()
  const idx = all.findIndex(e => e.id === id)
  if (idx >= 0) {
    all[idx] = { ...all[idx], memo }
    saveAll(all)
  }
}

/** 단건 삭제 */
export function deleteHistory(id: string): void {
  const all = loadAll().filter(e => e.id !== id)
  saveAll(all)
}

/** 전체 삭제 */
export function clearHistory(): void {
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
}
