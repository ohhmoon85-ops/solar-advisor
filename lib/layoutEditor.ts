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
  | { type: 'SELECT_ROWS'; rowIndices: number[]; additive?: boolean }
  | { type: 'SPREAD_ROWS'; deltaM: number; rowIndices?: number[] }
  | { type: 'REINIT'; placements: PanelPlacement[] }
  | { type: 'MARK_SAVED' }

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

// 통로 위 행들을 북쪽으로 이동 (통로 삽입 시 실제 패널 위치 갱신)
function shiftRowsAboveCorridors(
  placements: PanelPlacement[],
  corridors: Corridor[],
  rowAvgY: Map<number, number>
): PanelPlacement[] {
  if (corridors.length === 0) return placements
  const rows = [...new Set(placements.map(p => p.row))]
  const shiftMap = new Map<number, number>()
  for (const r of rows) {
    const rY = rowAvgY.get(r) ?? 0
    let total = 0
    for (const c of corridors) {
      const cY = rowAvgY.get(c.afterRowIndex) ?? 0
      if (cY < rY) total += c.widthM
    }
    shiftMap.set(r, total)
  }
  return placements.map(p => {
    const dy = shiftMap.get(p.row) ?? 0
    if (dy === 0) return p
    return {
      ...p,
      centerY: p.centerY + dy,
      corners: p.corners.map(c => ({ x: c.x, y: c.y + dy })) as typeof p.corners,
    }
  })
}

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

    case 'SELECT_ROWS': {
      const ids = state.placements
        .filter(p => action.rowIndices.includes(p.row))
        .map(p => p.id)
      const newSelected = action.additive
        ? new Set([...state.selectedIds, ...ids])
        : new Set(ids)
      return { ...state, selectedIds: newSelected }
    }

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
      const rowCfg = getRowConfigOrDefault(state, action.rowIndex)
      const currentStack = rowCfg.stackCount || 1
      if (currentStack === action.stackCount) return state
      const saved = pushHistory(state)
      const rowPanels = saved.placements.filter(p => p.row === action.rowIndex)
      if (rowPanels.length === 0) {
        return upsertRowConfig({ ...saved, isDirty: true }, { ...rowCfg, stackCount: action.stackCount })
      }
      // 기준 패널: Y 오름차순(남→북) 정렬 후 1/currentStack 만큼이 원본 1단
      const basePanelCount = Math.max(1, Math.round(rowPanels.length / currentStack))
      const sortedByY = [...rowPanels].sort((a, b) => a.centerY - b.centerY)
      const basePanels = sortedByY.slice(0, basePanelCount)
      // 북쪽 방향 이동 벡터: corners[3](NW) - corners[0](SW) → 패널을 북쪽으로 쌓음
      const ref = basePanels[0]
      const svx = ref.corners[3].x - ref.corners[0].x
      const svy = ref.corners[3].y - ref.corners[0].y
      const svLen = Math.sqrt(svx * svx + svy * svy)
      const GAP = 0.05
      const sx = svLen >= 0.01 ? svx * (1 + GAP / svLen) : 0
      const sy = svLen >= 0.01 ? svy * (1 + GAP / svLen) : 0
      // 해당 행 패널 전체 제거 후 재구성
      let newPlacements = saved.placements.filter(p => p.row !== action.rowIndex)
      newPlacements = [...newPlacements, ...basePanels]
      let nextId = saved.placements.length > 0
        ? Math.max(...saved.placements.map(p => p.id)) + 1 : 0
      for (let k = 1; k < action.stackCount; k++) {
        for (const p of basePanels) {
          newPlacements.push({
            id: nextId++, row: p.row, col: p.col,
            centerX: p.centerX + sx * k,
            centerY: p.centerY + sy * k,
            corners: p.corners.map(c => ({ x: c.x + sx * k, y: c.y + sy * k })) as typeof p.corners,
          })
        }
      }
      return upsertRowConfig(
        { ...saved, placements: newPlacements, isDirty: true },
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

    case 'SPREAD_ROWS': {
      // 행간 ±조정 — 회전된 그리드(방위각≠180°)에서도 정확히 동작하도록 north vector 기반 이동
      // - 첫 행(가장 남쪽)은 고정, 북쪽으로 갈수록 i*deltaM 누적 이동
      // - 단순 centerY 가산이 아닌 패널의 회전된 north 방향으로 이동 → 회전 그리드에서도 행 방향 보존
      const allRowIds = new Set(state.placements.map(p => p.row))
      const targetRows = action.rowIndices?.filter(r => allRowIds.has(r)) ?? [...allRowIds]
      if (targetRows.length < 2) return state
      const saved = pushHistory(state)
      const rowPanelMap = new Map<number, typeof saved.placements>()
      for (const p of saved.placements) {
        if (!rowPanelMap.has(p.row)) rowPanelMap.set(p.row, [])
        rowPanelMap.get(p.row)!.push(p)
      }
      // 회전된 north vector — 패널 corners[3](NW) - corners[0](SW)
      const ref = saved.placements[0]
      const upX0 = ref.corners[3].x - ref.corners[0].x
      const upY0 = ref.corners[3].y - ref.corners[0].y
      const upLen = Math.sqrt(upX0 * upX0 + upY0 * upY0)
      const upX = upLen > 0 ? upX0 / upLen : 0
      const upY = upLen > 0 ? upY0 / upLen : 1  // fallback: 정북(Y축)
      // 행 중심을 north 방향으로 투영하여 남→북 정렬
      const projOnUp = (r: number) => {
        const ps = rowPanelMap.get(r)!
        const cx = ps.reduce((s, p) => s + p.centerX, 0) / ps.length
        const cy = ps.reduce((s, p) => s + p.centerY, 0) / ps.length
        return cx * upX + cy * upY
      }
      const sortedRows = targetRows.slice().sort((a, b) => projOnUp(a) - projOnUp(b))
      const idxMap = new Map<number, number>()
      sortedRows.forEach((r, i) => idxMap.set(r, i))
      const placements = saved.placements.map(p => {
        const i = idxMap.get(p.row)
        if (i === undefined || i === 0) return p  // 첫 행 고정
        const dx = upX * action.deltaM * i
        const dy = upY * action.deltaM * i
        return {
          ...p,
          centerX: p.centerX + dx,
          centerY: p.centerY + dy,
          corners: p.corners.map(c => ({ x: c.x + dx, y: c.y + dy })) as typeof p.corners,
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

    case 'REINIT':
      return initEditorState(action.placements)

    case 'MARK_SAVED':
      return { ...state, isDirty: false, originalPlacements: deepCopyPlacements(state.placements) }

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
          // 표준 배치: originalPlacements 기반, 행 수에 맞는 통로 삽입 + 패널 실제 이동
          const stdBase = deepCopyPlacements(saved.originalPlacements)
          const stdAllRows = getUniqueRows(stdBase)
          const stdRowAvgY = new Map<number, number>()
          for (const r of stdAllRows) {
            const rp = stdBase.filter(p => p.row === r)
            stdRowAvgY.set(r, rp.reduce((s, p) => s + p.centerY, 0) / rp.length)
          }
          const stdThreshold = stdAllRows.length <= 8 ? 4 : 10
          const stdCorrWidth = 1.0
          const stdNumCorr = stdAllRows.filter((_, i) => (i + 1) % stdThreshold === 0 && i < stdAllRows.length - 1).length
          let stdPlacements = stdBase
          if (stdNumCorr > 0 && stdAllRows.length > 1) {
            const avgPitch = Math.abs(
              (stdRowAvgY.get(stdAllRows[stdAllRows.length - 1]) ?? 0) - (stdRowAvgY.get(stdAllRows[0]) ?? 0)
            ) / (stdAllRows.length - 1)
            const toRemove = Math.max(1, Math.round((stdCorrWidth / Math.max(avgPitch, 0.5)) * stdNumCorr))
            const keepRows = new Set(stdAllRows.slice(0, stdAllRows.length - toRemove))
            stdPlacements = stdBase.filter(p => keepRows.has(p.row))
          }
          const stdKeptRows = getUniqueRows(stdPlacements)
          const stdCorridors: Corridor[] = stdKeptRows
            .filter((_, i) => (i + 1) % stdThreshold === 0 && i < stdKeptRows.length - 1)
            .map(rowIdx => ({ id: nextCorridorId(), type: 'inspection' as const, afterRowIndex: rowIdx, widthM: stdCorrWidth }))
          const stdRowCfgs = stdCorridors.map(c => ({
            rowIndex: c.afterRowIndex, stackCount: 1 as const, hasCorridorAfter: true, corridorWidthM: c.widthM,
          }))
          stdPlacements = shiftRowsAboveCorridors(stdPlacements, stdCorridors, stdRowAvgY)
          return { ...saved, placements: stdPlacements, corridors: stdCorridors, rowConfigs: stdRowCfgs, isDirty: true }
        }


        case 'corridors': {
          // 점검통로 삽입: originalPlacements 기반, 행 수에 맞는 다수 통로 + 패널 실제 이동
          const corrBase = deepCopyPlacements(saved.originalPlacements)
          const corrAllRows = getUniqueRows(corrBase)
          const corrRowAvgY = new Map<number, number>()
          for (const r of corrAllRows) {
            const rp = corrBase.filter(p => p.row === r)
            corrRowAvgY.set(r, rp.reduce((s, p) => s + p.centerY, 0) / rp.length)
          }
          const corrThreshold = corrAllRows.length <= 8 ? 2 : 5
          const corrWidth = 1.2
          const corrNumCorr = corrAllRows.filter((_, i) => (i + 1) % corrThreshold === 0 && i < corrAllRows.length - 1).length
          let corrPlacements = corrBase
          if (corrNumCorr > 0 && corrAllRows.length > 1) {
            const avgPitch = Math.abs(
              (corrRowAvgY.get(corrAllRows[corrAllRows.length - 1]) ?? 0) - (corrRowAvgY.get(corrAllRows[0]) ?? 0)
            ) / (corrAllRows.length - 1)
            const toRemove = Math.max(1, Math.round((corrWidth / Math.max(avgPitch, 0.5)) * corrNumCorr))
            const keepRows = new Set(corrAllRows.slice(0, corrAllRows.length - toRemove))
            corrPlacements = corrBase.filter(p => keepRows.has(p.row))
          }
          const corrKeptRows = getUniqueRows(corrPlacements)
          const newCorridors: Corridor[] = corrKeptRows
            .filter((_, i) => (i + 1) % corrThreshold === 0 && i < corrKeptRows.length - 1)
            .map(rowIdx => ({ id: nextCorridorId(), type: 'inspection' as const, afterRowIndex: rowIdx, widthM: corrWidth }))
          const rowConfigs = newCorridors.map(c => ({
            rowIndex: c.afterRowIndex, stackCount: 1 as const, hasCorridorAfter: true, corridorWidthM: c.widthM,
          }))
          corrPlacements = shiftRowsAboveCorridors(corrPlacements, newCorridors, corrRowAvgY)
          return { ...saved, placements: corrPlacements, corridors: newCorridors, rowConfigs, isDirty: true }
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
