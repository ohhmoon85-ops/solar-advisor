// lib/layoutEditor.ts — 배치 편집 상태 관리 (v5.2)
// SolarLayoutCanvas 위에서 동작하는 인터랙티브 편집 상태/로직

import type { PanelPlacement } from './layoutEngine'

// ── 타입 ───────────────────────────────────────────────────────────

export interface Corridor {
  id: number
  type: 'inspection' | 'drainage'
  afterRowIndex: number   // 이 행 다음(북쪽)에 삽입
  widthM: number          // 통로 폭 (m)
}

export interface RowConfig {
  rowIndex: number
  stackCount: 1 | 2 | 3            // 단 수
  rowSpacingOverride?: number       // 수동 이격거리 (m), undefined = 자동
  hasCorridorAfter: boolean
  corridorWidthM?: number
}

export interface EditorSnapshot {
  placements: PanelPlacement[]
  corridors: Corridor[]
  rowConfigs: RowConfig[]
}

export interface EditorState {
  placements: PanelPlacement[]
  selectedIds: Set<number>
  corridors: Corridor[]
  rowConfigs: RowConfig[]
  editHistory: EditorSnapshot[]     // undo 스택 (최대 20)
  isDirty: boolean
  /** 자동배치 원본 — "자동배치로 초기화" 복원용 */
  originalPlacements: PanelPlacement[]
}

export type EditorAction =
  | { type: 'ADD_PANEL'; placement: Omit<PanelPlacement, 'id'> }
  | { type: 'REMOVE_PANEL'; id: number }
  | { type: 'REMOVE_SELECTED' }
  | { type: 'SELECT_PANEL'; id: number; additive: boolean }
  | { type: 'DESELECT_ALL' }
  | { type: 'SELECT_RECT'; ids: number[] }
  | { type: 'ADD_CORRIDOR'; corridor: Omit<Corridor, 'id'> }
  | { type: 'REMOVE_CORRIDOR'; id: number }
  | { type: 'REMOVE_ALL_CORRIDORS' }
  | { type: 'SET_ROW_STACK'; rowIndex: number; stackCount: 1 | 2 | 3 }
  | { type: 'SET_ROW_SPACING'; rowIndex: number; spacingM: number | undefined }
  | { type: 'ROTATE_SELECTED'; angleDeg: number }
  | { type: 'MOVE_SELECTED'; dx: number; dy: number }
  | { type: 'UNDO' }
  | { type: 'RESET' }
  | { type: 'APPLY_QUICK'; preset: 'dense' | 'standard' | 'corridors' | 'stack3'; baseSpacing: number }

// ── 초기화 ─────────────────────────────────────────────────────────

export function initEditorState(placements: PanelPlacement[]): EditorState {
  return {
    placements: deepCopyPlacements(placements),
    selectedIds: new Set(),
    corridors: [],
    rowConfigs: [],
    editHistory: [],
    isDirty: false,
    originalPlacements: deepCopyPlacements(placements),
  }
}

// ── 내부 헬퍼 ──────────────────────────────────────────────────────

function deepCopyPlacements(placements: PanelPlacement[]): PanelPlacement[] {
  return placements.map(p => ({
    ...p,
    corners: [...p.corners] as typeof p.corners,
  }))
}

function snapshotState(state: EditorState): EditorSnapshot {
  return {
    placements: deepCopyPlacements(state.placements),
    corridors: state.corridors.map(c => ({ ...c })),
    rowConfigs: state.rowConfigs.map(r => ({ ...r })),
  }
}

function pushHistory(state: EditorState): EditorState {
  const snap = snapshotState(state)
  const history = [...state.editHistory, snap].slice(-20)
  return { ...state, editHistory: history }
}

function getRowConfigOrDefault(state: EditorState, rowIndex: number): RowConfig {
  return state.rowConfigs.find(r => r.rowIndex === rowIndex) ?? {
    rowIndex,
    stackCount: 1,
    hasCorridorAfter: false,
  }
}

function upsertRowConfig(state: EditorState, config: RowConfig): EditorState {
  const idx = state.rowConfigs.findIndex(r => r.rowIndex === config.rowIndex)
  const newConfigs = idx >= 0
    ? state.rowConfigs.map((r, i) => (i === idx ? config : r))
    : [...state.rowConfigs, config]
  return { ...state, rowConfigs: newConfigs }
}

let _corridorIdSeq = 1
function nextCorridorId(): number { return _corridorIdSeq++ }

// ── Reducer ────────────────────────────────────────────────────────

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {

    case 'ADD_PANEL': {
      const saved = pushHistory(state)
      const newId = state.placements.length > 0
        ? Math.max(...state.placements.map(p => p.id)) + 1
        : 0
      return {
        ...saved,
        placements: [...saved.placements, { ...action.placement, id: newId }],
        isDirty: true,
      }
    }

    case 'REMOVE_PANEL': {
      const saved = pushHistory(state)
      return {
        ...saved,
        placements: saved.placements.filter(p => p.id !== action.id),
        selectedIds: new Set([...saved.selectedIds].filter(id => id !== action.id)),
        isDirty: true,
      }
    }

    case 'REMOVE_SELECTED': {
      if (state.selectedIds.size === 0) return state
      const saved = pushHistory(state)
      return {
        ...saved,
        placements: saved.placements.filter(p => !state.selectedIds.has(p.id)),
        selectedIds: new Set(),
        isDirty: true,
      }
    }

    case 'SELECT_PANEL': {
      if (action.additive) {
        const sel = new Set(state.selectedIds)
        sel.has(action.id) ? sel.delete(action.id) : sel.add(action.id)
        return { ...state, selectedIds: sel }
      }
      return { ...state, selectedIds: new Set([action.id]) }
    }

    case 'DESELECT_ALL':
      return { ...state, selectedIds: new Set() }

    case 'SELECT_RECT':
      return { ...state, selectedIds: new Set(action.ids) }

    case 'ADD_CORRIDOR': {
      const saved = pushHistory(state)
      const corridor: Corridor = { ...action.corridor, id: nextCorridorId() }
      const corridors = [...saved.corridors, corridor]
      const rowCfg = getRowConfigOrDefault(saved, corridor.afterRowIndex)
      return upsertRowConfig(
        { ...saved, corridors, isDirty: true },
        { ...rowCfg, hasCorridorAfter: true, corridorWidthM: corridor.widthM }
      )
    }

    case 'REMOVE_CORRIDOR': {
      const saved = pushHistory(state)
      const target = state.corridors.find(c => c.id === action.id)
      const corridors = saved.corridors.filter(c => c.id !== action.id)
      let next = { ...saved, corridors, isDirty: true }
      if (target) {
        const stillHas = corridors.some(c => c.afterRowIndex === target.afterRowIndex)
        const rowCfg = getRowConfigOrDefault(next, target.afterRowIndex)
        next = upsertRowConfig(next, {
          ...rowCfg,
          hasCorridorAfter: stillHas,
          corridorWidthM: stillHas ? rowCfg.corridorWidthM : undefined,
        })
      }
      return next
    }

    case 'REMOVE_ALL_CORRIDORS': {
      const saved = pushHistory(state)
      const rowConfigs = saved.rowConfigs.map(r => ({
        ...r, hasCorridorAfter: false, corridorWidthM: undefined,
      }))
      return { ...saved, corridors: [], rowConfigs, isDirty: true }
    }

    case 'SET_ROW_STACK': {
      const saved = pushHistory(state)
      const rowCfg = getRowConfigOrDefault(saved, action.rowIndex)
      return upsertRowConfig(
        { ...saved, isDirty: true },
        { ...rowCfg, stackCount: action.stackCount }
      )
    }

    case 'SET_ROW_SPACING': {
      const saved = pushHistory(state)
      const rowCfg = getRowConfigOrDefault(saved, action.rowIndex)
      return upsertRowConfig(
        { ...saved, isDirty: true },
        { ...rowCfg, rowSpacingOverride: action.spacingM }
      )
    }

    case 'ROTATE_SELECTED': {
      if (state.selectedIds.size === 0) return state
      const saved = pushHistory(state)
      const cos = Math.cos(action.angleDeg * Math.PI / 180)
      const sin = Math.sin(action.angleDeg * Math.PI / 180)
      const placements = saved.placements.map(p => {
        if (!state.selectedIds.has(p.id)) return p
        const cx = p.centerX, cy = p.centerY
        const rot = (pt: { x: number; y: number }) => ({
          x: cx + (pt.x - cx) * cos - (pt.y - cy) * sin,
          y: cy + (pt.x - cx) * sin + (pt.y - cy) * cos,
        })
        return { ...p, corners: p.corners.map(rot) as typeof p.corners }
      })
      return { ...saved, placements, isDirty: true }
    }

    case 'MOVE_SELECTED': {
      if (state.selectedIds.size === 0) return state
      const saved = pushHistory(state)
      const placements = saved.placements.map(p => {
        if (!state.selectedIds.has(p.id)) return p
        return {
          ...p,
          centerX: p.centerX + action.dx,
          centerY: p.centerY + action.dy,
          corners: p.corners.map(c => ({ x: c.x + action.dx, y: c.y + action.dy })) as typeof p.corners,
        }
      })
      return { ...saved, placements, isDirty: true }
    }

    case 'UNDO': {
      if (state.editHistory.length === 0) return state
      const history = [...state.editHistory]
      const snap = history.pop()!
      return {
        ...state,
        placements: snap.placements,
        corridors: snap.corridors,
        rowConfigs: snap.rowConfigs,
        editHistory: history,
        isDirty: history.length > 0,
      }
    }

    case 'RESET':
      return initEditorState(state.originalPlacements)

    case 'APPLY_QUICK': {
      const saved = pushHistory(state)
      const rows = getUniqueRows(saved.placements)

      switch (action.preset) {
        case 'dense':
          // 최밀집: 원본 배치 완전 복원 + 통로·다단 제거
          return {
            ...saved,
            placements: deepCopyPlacements(saved.originalPlacements),
            corridors: [],
            rowConfigs: [],
            isDirty: true,
          }

        case 'standard': {
          // 표준 배치: 10행마다 1.0m 점검통로 + 통로만큼 끝 행 제거
          const stdCorridors: Corridor[] = rows
            .filter((_, i) => (i + 1) % 10 === 0 && i < rows.length - 1)
            .map(rowIdx => ({
              id: nextCorridorId(),
              type: 'inspection' as const,
              afterRowIndex: rowIdx,
              widthM: 1.0,
            }))
          const stdRowConfigs = stdCorridors.map(c => ({
            rowIndex: c.afterRowIndex,
            stackCount: 1 as const,
            hasCorridorAfter: true,
            corridorWidthM: c.widthM,
          }))
          let stdPlacements = saved.placements
          if (stdCorridors.length > 0 && rows.length > 1) {
            const rowCenterY = (rowIdx: number) => {
              const rp = saved.placements.filter(p => p.row === rowIdx)
              return rp.reduce((s, p) => s + p.centerY, 0) / (rp.length || 1)
            }
            const avgPitch = Math.abs(rowCenterY(rows[rows.length - 1]) - rowCenterY(rows[0])) / (rows.length - 1)
            const rowsToRemove = Math.max(1, Math.round((1.0 / (avgPitch || 2.5)) * stdCorridors.length))
            const keepRows = new Set(rows.slice(0, rows.length - rowsToRemove))
            stdPlacements = saved.placements.filter(p => keepRows.has(p.row))
          }
          return { ...saved, placements: stdPlacements, corridors: stdCorridors, rowConfigs: stdRowConfigs, isDirty: true }
        }

        case 'corridors': {
          // 5행마다 점검통로 삽입 + 통로 공간만큼 끝 행 제거
          const newCorridors: Corridor[] = rows
            .filter((_, i) => (i + 1) % 5 === 0 && i < rows.length - 1)
            .map(rowIdx => ({
              id: nextCorridorId(),
              type: 'inspection' as const,
              afterRowIndex: rowIdx,
              widthM: 1.2,
            }))
          const rowConfigs = newCorridors.map(c => ({
            rowIndex: c.afterRowIndex,
            stackCount: 1 as const,
            hasCorridorAfter: true,
            corridorWidthM: c.widthM,
          }))

          // 통로당 차지하는 행 수 추정 (행 간 평균 피치 기준)
          let placements = saved.placements
          if (newCorridors.length > 0 && rows.length > 1) {
            const rowCenterY = (rowIdx: number) => {
              const rp = saved.placements.filter(p => p.row === rowIdx)
              return rp.reduce((s, p) => s + p.centerY, 0) / (rp.length || 1)
            }
            const avgPitch = Math.abs(rowCenterY(rows[rows.length - 1]) - rowCenterY(rows[0])) / (rows.length - 1)
            const rowsToRemove = Math.max(1, Math.round((1.2 / (avgPitch || 2.5)) * newCorridors.length))
            const keepRows = new Set(rows.slice(0, rows.length - rowsToRemove))
            placements = saved.placements.filter(p => keepRows.has(p.row))
          }

          return { ...saved, placements, corridors: newCorridors, rowConfigs, isDirty: true }
        }

        case 'stack3': {
          // 전체 3단: 각 행을 패널 높이+0.05m 간격으로 2회 복제 → 수량 3배
          const GAP = 0.05  // 단 내 패널 간격 (m)
          const newPlacements = [...saved.placements]
          let nextId = newPlacements.length > 0
            ? Math.max(...newPlacements.map(p => p.id)) + 1 : 0

          for (const rowIdx of rows) {
            const rowPanels = saved.placements.filter(p => p.row === rowIdx)
            if (rowPanels.length === 0) continue
            // 첫 패널 corners[0](SW) - corners[3](NW) = 남쪽 방향 벡터
            const ref = rowPanels[0]
            const svx = ref.corners[0].x - ref.corners[3].x
            const svy = ref.corners[0].y - ref.corners[3].y
            const svLen = Math.sqrt(svx * svx + svy * svy)
            if (svLen < 0.01) continue
            // 1단 간격 = 패널 투영 높이 + GAP
            const sx = svx * (1 + GAP / svLen)
            const sy = svy * (1 + GAP / svLen)
            for (let k = 1; k <= 2; k++) {
              for (const p of rowPanels) {
                newPlacements.push({
                  id: nextId++, row: p.row, col: p.col,
                  centerX: p.centerX + sx * k,
                  centerY: p.centerY + sy * k,
                  corners: p.corners.map(c => ({
                    x: c.x + sx * k, y: c.y + sy * k,
                  })) as typeof p.corners,
                })
              }
            }
          }
          const rowConfigs = rows.map(rowIdx => ({
            rowIndex: rowIdx, stackCount: 3 as const, hasCorridorAfter: false,
          }))
          return { ...saved, placements: newPlacements, rowConfigs, isDirty: true }
        }

        default:
          return saved
      }
    }

    default:
      return state
  }
}

// ── 공개 유틸리티 ────────────────────────────────────────────────────

/** 배치 목록에서 고유 행 인덱스 오름차순 */
export function getUniqueRows(placements: PanelPlacement[]): number[] {
  return [...new Set(placements.map(p => p.row))].sort((a, b) => a - b)
}

/** 행별 패널 그룹화 */
export function groupByRow(placements: PanelPlacement[]): Map<number, PanelPlacement[]> {
  const map = new Map<number, PanelPlacement[]>()
  for (const p of placements) {
    if (!map.has(p.row)) map.set(p.row, [])
    map.get(p.row)!.push(p)
  }
  return map
}

/**
 * 단수(stackCount)에 따른 유효 경사 길이
 * L_eff = L × stackCount + 0.05 × (stackCount - 1)
 */
export function getStackedLength(lengthM: number, stackCount: number): number {
  return lengthM * stackCount + 0.05 * (stackCount - 1)
}

/** 편집 결과 요약 통계 */
export function getEditSummary(state: EditorState) {
  const autoPanelCount = state.originalPlacements.length
  const currentPanelCount = state.placements.length
  const delta = currentPanelCount - autoPanelCount
  const originalIds = new Set(state.originalPlacements.map(p => p.id))
  const currentIds = new Set(state.placements.map(p => p.id))
  const addedCount = [...currentIds].filter(id => !originalIds.has(id)).length
  const removedCount = [...originalIds].filter(id => !currentIds.has(id)).length
  return {
    autoPanelCount,
    currentPanelCount,
    delta,
    addedCount,
    removedCount,
    corridorCount: state.corridors.length,
    stackedRowCount: state.rowConfigs.filter(r => r.stackCount > 1).length,
  }
}
