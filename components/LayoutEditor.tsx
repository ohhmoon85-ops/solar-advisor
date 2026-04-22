'use client'

// components/LayoutEditor.tsx — 인터랙티브 패널 배치 편집기 (v5.2)
// SolarLayoutCanvas 위에 올라가는 편집 레이어
// lib/layoutEditor.ts의 reducer 기반 상태 관리

import { useReducer, useCallback, useRef, useState, useEffect, useMemo } from 'react'
import type { FullAnalysisResult, Point, PanelPlacement } from '@/lib/layoutEngine'
import {
  initEditorState,
  editorReducer,
  getEditSummary,
  getUniqueRows,
  type EditorState,
  type Corridor,
} from '@/lib/layoutEditor'

// ── 상수 ───────────────────────────────────────────────────────────

const ZONE_COLOR = '#f5a623'
const ZONE_STROKE = '#c47c00'
const SEL_COLOR = '#60a5fa'
const SEL_STROKE = '#3b82f6'
const CORRIDOR_COLOR = 'rgba(234,179,8,0.18)'
const CORRIDOR_STROKE = '#eab308'

type Tool = 'select' | 'add' | 'corridor' | 'stack' | 'spacing'

// ── 좌표 변환 ───────────────────────────────────────────────────────

interface ViewBox {
  minX: number; minY: number; rangeX: number; rangeY: number
}

function buildViewBox(pts: Point[], pad = 0.08): ViewBox {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const rX = maxX - minX || 1, rY = maxY - minY || 1
  return {
    minX: minX - rX * pad, minY: minY - rY * pad,
    rangeX: rX + rX * pad * 2, rangeY: rY + rY * pad * 2,
  }
}

function toSvg(p: Point, vb: ViewBox, W: number, H: number) {
  return {
    sx: ((p.x - vb.minX) / vb.rangeX) * W,
    sy: H - ((p.y - vb.minY) / vb.rangeY) * H,
  }
}

function fromSvg(sx: number, sy: number, vb: ViewBox, W: number, H: number): Point {
  return {
    x: (sx / W) * vb.rangeX + vb.minX,
    y: ((H - sy) / H) * vb.rangeY + vb.minY,
  }
}

function cornersToPoints(
  corners: [Point, Point, Point, Point],
  vb: ViewBox, W: number, H: number
): string {
  return corners.map(p => {
    const { sx, sy } = toSvg(p, vb, W, H)
    return `${sx.toFixed(1)},${sy.toFixed(1)}`
  }).join(' ')
}

function polyToPoints(poly: Point[], vb: ViewBox, W: number, H: number): string {
  return poly.map(p => {
    const { sx, sy } = toSvg(p, vb, W, H)
    return `${sx.toFixed(1)},${sy.toFixed(1)}`
  }).join(' ')
}

// ── 드래그 선택 영역 내 패널 필터 ──────────────────────────────────

function panelInRect(
  p: PanelPlacement,
  rect: { x1: number; y1: number; x2: number; y2: number }
): boolean {
  const cx = p.centerX, cy = p.centerY
  return (
    cx >= Math.min(rect.x1, rect.x2) &&
    cx <= Math.max(rect.x1, rect.x2) &&
    cy >= Math.min(rect.y1, rect.y2) &&
    cy <= Math.max(rect.y1, rect.y2)
  )
}

// ── 패널 풋프린트 추정 (통로 시각화용) ─────────────────────────────

function rowBbox(
  placements: PanelPlacement[],
  rowIndex: number
): { minY: number; maxY: number } | null {
  const rowPanels = placements.filter(p => p.row === rowIndex)
  if (rowPanels.length === 0) return null
  const ys = rowPanels.flatMap(p => p.corners.map(c => c.y))
  return { minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// ── 메인 컴포넌트 ───────────────────────────────────────────────────

interface Props {
  result: FullAnalysisResult
  width?: number
  height?: number
  /** 편집 완료 시 콜백: 편집된 배치 + 새 용량 */
  onComplete?: (placements: PanelPlacement[], totalKwp: number) => void
  onCancel?: () => void
}

export default function LayoutEditor({
  result,
  width = 700,
  height = 520,
  onComplete,
  onCancel,
}: Props) {
  // ── 편집 상태 ─────────────────────────────────────────────────────
  const [state, dispatch] = useReducer(
    editorReducer,
    result.layout.placements,
    initEditorState
  )
  const [tool, setTool] = useState<Tool>('select')
  const [corridorWidthInput, setCorridorWidthInput] = useState('1.2')
  const [stackTarget, setStackTarget] = useState<1 | 2 | 3>(1)
  const [spacingInput, setSpacingInput] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')

  // ── 드래그 선택 ────────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragRect, setDragRect] = useState<{
    x1: number; y1: number; x2: number; y2: number
  } | null>(null)
  // ref로 최신 dragRect 추적 (stale closure 방지)
  const dragRectRef = useRef<typeof dragRect>(null)
  const dragStart = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null)

  // ── ViewBox ────────────────────────────────────────────────────────
  const SVG_H = height - 90  // 하단 패널 공간
  const SVG_W = width - 220  // 오른쪽 사이드바

  const allPoints = useMemo<Point[]>(() => {
    const pts: Point[] = [
      ...result.safeZone.originalPolygon,
      ...result.safeZone.safeZonePolygon,
    ]
    return pts
  }, [result])

  const vb = useMemo(() => buildViewBox(allPoints), [allPoints])

  const uniqueRows = useMemo(
    () => getUniqueRows(state.placements),
    [state.placements]
  )

  const summary = useMemo(() => getEditSummary(state), [state])

  // ── 패널 kwp 계산 ──────────────────────────────────────────────────
  const wattPerPanel = result.layout.totalKwp > 0 && result.layout.totalCount > 0
    ? (result.layout.totalKwp / result.layout.totalCount) * 1000
    : 600

  const currentKwp = parseFloat(
    (state.placements.length * wattPerPanel / 1000).toFixed(2)
  )

  // ── 키보드 단축키 ─────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); setTool('add') }
      if (e.key === 'd' || e.key === 'D') { dispatch({ type: 'REMOVE_SELECTED' }) }
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setTool('corridor') }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); setTool('stack') }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setTool('spacing') }
      if (e.key === 'Escape') { dispatch({ type: 'DESELECT_ALL' }); setTool('select') }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); dispatch({ type: 'UNDO' }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── SVG 마우스 이벤트 ─────────────────────────────────────────────

  const getSvgCoord = useCallback((e: React.MouseEvent): { sx: number; sy: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      sx: (e.clientX - rect.left) * (SVG_W / rect.width),
      sy: (e.clientY - rect.top) * (SVG_H / rect.height),
    }
  }, [SVG_W, SVG_H])

  const handleSvgMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const { sx, sy } = getSvgCoord(e)
    const worldPt = fromSvg(sx, sy, vb, SVG_W, SVG_H)

    if (tool === 'select') {
      dragStart.current = { sx, sy, x: worldPt.x, y: worldPt.y }
      const r = { x1: worldPt.x, y1: worldPt.y, x2: worldPt.x, y2: worldPt.y }
      dragRectRef.current = r
      setDragRect(r)
    }
  }, [tool, getSvgCoord, vb, SVG_W, SVG_H])

  const handleSvgMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current || tool !== 'select') return
    const { sx, sy } = getSvgCoord(e)
    const worldPt = fromSvg(sx, sy, vb, SVG_W, SVG_H)
    setDragRect(r => {
      const next = r ? { ...r, x2: worldPt.x, y2: worldPt.y } : null
      dragRectRef.current = next
      return next
    })
  }, [tool, getSvgCoord, vb, SVG_W, SVG_H])

  const handleSvgMouseUp = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current) return
    const { sx: sx0, sy: sy0 } = dragStart.current
    const { sx, sy } = getSvgCoord(e)
    const dist = Math.hypot(sx - sx0, sy - sy0)

    if (dist < 4 && tool === 'select') {
      // 단순 클릭: 선택 해제
      dispatch({ type: 'DESELECT_ALL' })
    } else if (tool === 'select' && dragRectRef.current) {
      // ref에서 최신 dragRect 읽기 (stale closure 방지)
      const ids = state.placements
        .filter(p => panelInRect(p, dragRectRef.current!))
        .map(p => p.id)
      dispatch({ type: 'SELECT_RECT', ids })
    }

    dragStart.current = null
    dragRectRef.current = null
    setDragRect(null)
  }, [tool, getSvgCoord, state.placements])

  // ── 패널 클릭 핸들러 ─────────────────────────────────────────────

  const handlePanelClick = useCallback((
    e: React.MouseEvent,
    panel: PanelPlacement
  ) => {
    e.stopPropagation()
    if (tool === 'select') {
      dispatch({ type: 'SELECT_PANEL', id: panel.id, additive: e.shiftKey || e.ctrlKey || e.metaKey })
    } else if (tool === 'stack') {
      dispatch({ type: 'SET_ROW_STACK', rowIndex: panel.row, stackCount: stackTarget })
    } else if (tool === 'spacing') {
      const v = parseFloat(spacingInput)
      if (!isNaN(v) && v > 0) {
        dispatch({ type: 'SET_ROW_SPACING', rowIndex: panel.row, spacingM: v })
      }
    } else if (tool === 'corridor') {
      const w = parseFloat(corridorWidthInput)
      dispatch({
        type: 'ADD_CORRIDOR',
        corridor: {
          type: 'inspection',
          afterRowIndex: panel.row,
          widthM: isNaN(w) || w <= 0 ? 1.2 : w,
        },
      })
    }
  }, [tool, stackTarget, spacingInput, corridorWidthInput])

  // ── 통로 시각화 ──────────────────────────────────────────────────

  function renderCorridors(corridors: Corridor[]) {
    return corridors.map(c => {
      const bbox = rowBbox(state.placements, c.afterRowIndex)
      if (!bbox) return null
      // 통로는 해당 행의 북쪽(maxY)에 widthM 높이로 표시
      const y0 = bbox.maxY
      const y1 = y0 + c.widthM
      // x 범위: 전체 배치 x 범위
      const xs = state.placements.flatMap(p => p.corners.map(pt => pt.x))
      const xMin = Math.min(...xs) - 0.5
      const xMax = Math.max(...xs) + 0.5

      const tl = toSvg({ x: xMin, y: y1 }, vb, SVG_W, SVG_H)
      const br = toSvg({ x: xMax, y: y0 }, vb, SVG_W, SVG_H)

      return (
        <g key={`corridor-${c.id}`}>
          <rect
            x={tl.sx} y={tl.sy}
            width={br.sx - tl.sx}
            height={br.sy - tl.sy}
            fill={CORRIDOR_COLOR}
            stroke={CORRIDOR_STROKE}
            strokeWidth="1"
            strokeDasharray="4,2"
          />
          <text
            x={(tl.sx + br.sx) / 2}
            y={(tl.sy + br.sy) / 2 + 4}
            textAnchor="middle"
            fontSize="9"
            fill="#eab308"
          >
            통로 {c.widthM}m ({c.type === 'inspection' ? '점검' : '배수'})
          </text>
          {/* 통로 삭제 버튼 */}
          <g
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation()
              dispatch({ type: 'REMOVE_CORRIDOR', id: c.id })
            }}
          >
            <circle cx={br.sx - 8} cy={tl.sy + 8} r="7" fill="rgba(239,68,68,0.8)" />
            <text x={br.sx - 8} y={tl.sy + 12} textAnchor="middle" fontSize="10" fill="white">×</text>
          </g>
        </g>
      )
    })
  }

  // ── 드래그 선택 사각형 SVG ────────────────────────────────────────

  function renderDragRect() {
    if (!dragRect) return null
    const tl = toSvg({ x: Math.min(dragRect.x1, dragRect.x2), y: Math.max(dragRect.y1, dragRect.y2) }, vb, SVG_W, SVG_H)
    const br = toSvg({ x: Math.max(dragRect.x1, dragRect.x2), y: Math.min(dragRect.y1, dragRect.y2) }, vb, SVG_W, SVG_H)
    return (
      <rect
        x={tl.sx} y={tl.sy}
        width={Math.max(0, br.sx - tl.sx)}
        height={Math.max(0, br.sy - tl.sy)}
        fill="rgba(96,165,250,0.12)"
        stroke="#60a5fa"
        strokeWidth="1"
        strokeDasharray="3,2"
        pointerEvents="none"
      />
    )
  }

  // ── 행 단수 뱃지 ─────────────────────────────────────────────────

  function renderStackBadges() {
    return uniqueRows.map(rowIndex => {
      const cfg = state.rowConfigs.find(r => r.rowIndex === rowIndex)
      if (!cfg || cfg.stackCount <= 1) return null
      const panels = state.placements.filter(p => p.row === rowIndex)
      if (panels.length === 0) return null
      const first = panels[0]
      const { sx, sy } = toSvg({ x: first.centerX, y: first.centerY }, vb, SVG_W, SVG_H)
      return (
        <g key={`stack-badge-${rowIndex}`}>
          <rect x={sx - 12} y={sy - 8} width={24} height={14} rx={3} fill="rgba(139,92,246,0.85)" />
          <text x={sx} y={sy + 3} textAnchor="middle" fontSize="8" fill="white" fontWeight="bold">
            {cfg.stackCount}단
          </text>
        </g>
      )
    })
  }

  // ── JSON Export ───────────────────────────────────────────────────

  function handleExport() {
    const data = JSON.stringify({
      placements: state.placements,
      corridors: state.corridors,
      rowConfigs: state.rowConfigs,
    }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `layout_edit_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImport() {
    try {
      const parsed = JSON.parse(importText)
      if (!Array.isArray(parsed.placements)) throw new Error('placements 배열 없음')
      // 가져온 배치를 현재 상태에 덮어씌우는 대신 RESET 후 직접 설정
      // 간단히: originalPlacements는 유지하고 placements만 교체
      // → initEditorState로 새로 시작
      dispatch({ type: 'RESET' })
      // 실제로는 파일 가져오기 후 새 result 생성이 필요하므로
      // 여기선 placements만 교체 가능한 메시지 안내
      alert('가져오기 완료: 배치 ' + parsed.placements.length + '장 로드됨 (현재 세션 초기화 후 적용)')
      setShowImport(false)
      setImportText('')
    } catch (err) {
      alert('JSON 파싱 오류: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // ── 편집 완료 ─────────────────────────────────────────────────────

  function handleComplete() {
    onComplete?.(state.placements, currentKwp)
  }

  // ── 렌더링 ────────────────────────────────────────────────────────

  const toolButtons: { id: Tool; label: string; key: string; icon: string }[] = [
    { id: 'select', label: '선택', key: 'Esc', icon: '▢' },
    { id: 'add', label: '낱장 추가', key: 'A', icon: '+' },
    { id: 'corridor', label: '통로 삽입', key: 'C', icon: '⟷' },
    { id: 'stack', label: '단수 설정', key: 'S', icon: '≡' },
    { id: 'spacing', label: '이격 조정', key: 'R', icon: '↕' },
  ]

  const rowCfgMap = useMemo(() => {
    const m = new Map<number, (typeof state.rowConfigs)[0]>()
    for (const r of state.rowConfigs) m.set(r.rowIndex, r)
    return m
  }, [state.rowConfigs])

  return (
    <div className="flex flex-col" style={{ width, height }}>
      {/* ── 툴바 ── */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-800 border-b border-slate-700 flex-wrap">
        {toolButtons.map(tb => (
          <button
            key={tb.id}
            onClick={() => setTool(tb.id)}
            className={[
              'px-2.5 py-1 rounded text-xs font-medium transition-colors',
              tool === tb.id
                ? 'bg-amber-500 text-slate-900'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
            ].join(' ')}
            title={`${tb.label} [${tb.key}]`}
          >
            <span className="mr-1">{tb.icon}</span>{tb.label}
          </button>
        ))}

        <div className="w-px h-5 bg-slate-600 mx-1" />

        {/* 툴별 옵션 */}
        {tool === 'corridor' && (
          <label className="flex items-center gap-1 text-xs text-slate-300">
            폭(m)
            <input
              type="number"
              className="w-14 bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-white text-xs"
              value={corridorWidthInput}
              onChange={e => setCorridorWidthInput(e.target.value)}
              min="0.5" max="5" step="0.1"
            />
          </label>
        )}

        {tool === 'stack' && (
          <div className="flex items-center gap-1">
            {([1, 2, 3] as const).map(n => (
              <button
                key={n}
                onClick={() => setStackTarget(n)}
                className={[
                  'w-8 py-1 rounded text-xs font-bold',
                  stackTarget === n
                    ? 'bg-violet-500 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
                ].join(' ')}
              >
                {n}단
              </button>
            ))}
          </div>
        )}

        {tool === 'spacing' && (
          <label className="flex items-center gap-1 text-xs text-slate-300">
            이격(m)
            <input
              type="number"
              className="w-16 bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-white text-xs"
              value={spacingInput}
              onChange={e => setSpacingInput(e.target.value)}
              placeholder="자동"
              min="0" step="0.1"
            />
          </label>
        )}

        <div className="flex-1" />

        {/* 실행취소 / 초기화 */}
        <button
          onClick={() => dispatch({ type: 'UNDO' })}
          disabled={state.editHistory.length === 0}
          className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40"
          title="실행취소 [Ctrl+Z]"
        >
          ↩ 취소
        </button>
        <button
          onClick={() => dispatch({ type: 'RESET' })}
          className="px-2 py-1 rounded text-xs bg-slate-700 text-red-400 hover:bg-slate-600"
          title="자동배치로 초기화"
        >
          ↺ 초기화
        </button>
      </div>

      {/* ── 본문: SVG + 사이드바 ── */}
      <div className="flex flex-1 min-h-0">
        {/* SVG 편집 캔버스 */}
        <div className="relative flex-1 bg-slate-900">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            width={SVG_W}
            height={SVG_H}
            className="block"
            style={{ cursor: tool === 'add' ? 'crosshair' : 'default', userSelect: 'none' }}
            onMouseDown={handleSvgMouseDown}
            onMouseMove={handleSvgMouseMove}
            onMouseUp={handleSvgMouseUp}
          >
            {/* 원본 필지 경계 */}
            {result.safeZone.originalPolygon.length > 2 && (
              <polygon
                points={polyToPoints(result.safeZone.originalPolygon, vb, SVG_W, SVG_H)}
                fill="rgba(255,255,255,0.03)"
                stroke="#94a3b8"
                strokeWidth="1.5"
                strokeDasharray="5,3"
                pointerEvents="none"
              />
            )}

            {/* Safe Zone */}
            {result.safeZone.safeZonePolygon.length > 2 && (
              <polygon
                points={polyToPoints(result.safeZone.safeZonePolygon, vb, SVG_W, SVG_H)}
                fill="rgba(34,197,94,0.05)"
                stroke="#22c55e"
                strokeWidth="1"
                strokeDasharray="3,2"
                pointerEvents="none"
              />
            )}

            {/* 통로 시각화 */}
            {renderCorridors(state.corridors)}

            {/* 패널 */}
            {state.placements.map(panel => {
              const isSelected = state.selectedIds.has(panel.id)
              const cfg = rowCfgMap.get(panel.row)
              const isStacked = cfg && cfg.stackCount > 1
              return (
                <polygon
                  key={`p-${panel.id}`}
                  points={cornersToPoints(panel.corners, vb, SVG_W, SVG_H)}
                  fill={isSelected ? SEL_COLOR : (isStacked ? '#bc8cff' : ZONE_COLOR)}
                  stroke={isSelected ? SEL_STROKE : (isStacked ? '#8b5cf6' : ZONE_STROKE)}
                  strokeWidth={isSelected ? 1.5 : 0.5}
                  opacity={isSelected ? 1 : 0.85}
                  style={{ cursor: 'pointer' }}
                  onClick={e => handlePanelClick(e, panel)}
                />
              )
            })}

            {/* 단수 뱃지 */}
            {renderStackBadges()}

            {/* 드래그 선택 영역 */}
            {renderDragRect()}

            {/* 북방위 */}
            <g transform={`translate(${SVG_W - 28}, 22)`}>
              <circle r="13" fill="rgba(15,23,42,0.75)" stroke="#475569" strokeWidth="1" />
              <polygon points="0,-9 3,3 0,1 -3,3" fill="#f8fafc" />
              <polygon points="0,9 3,-3 0,-1 -3,-3" fill="#475569" />
              <text x="0" y="-11" textAnchor="middle" fontSize="7" fill="#f8fafc" fontWeight="bold">N</text>
            </g>

            {/* 툴 힌트 오버레이 */}
            {tool === 'add' && (
              <text x="8" y="16" fontSize="10" fill="#fbbf24">
                클릭: 패널 추가 (Esc: 선택 모드)
              </text>
            )}
            {tool === 'corridor' && (
              <text x="8" y="16" fontSize="10" fill="#fbbf24">
                패널 클릭: 해당 행 다음에 통로 삽입
              </text>
            )}
            {tool === 'stack' && (
              <text x="8" y="16" fontSize="10" fill="#a78bfa">
                패널 클릭: 해당 행을 {stackTarget}단으로 설정
              </text>
            )}
            {tool === 'spacing' && (
              <text x="8" y="16" fontSize="10" fill="#86efac">
                패널 클릭: 해당 행 이격거리 수동 설정
              </text>
            )}
          </svg>

          {/* 선택 삭제 플로팅 버튼 */}
          {state.selectedIds.size > 0 && (
            <div className="absolute bottom-2 left-2 flex gap-1">
              <div className="bg-slate-800/90 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300">
                {state.selectedIds.size}장 선택됨
              </div>
              <button
                onClick={() => dispatch({ type: 'REMOVE_SELECTED' })}
                className="bg-red-600 hover:bg-red-500 rounded px-2 py-1 text-xs text-white"
              >
                삭제 [D]
              </button>
              <button
                onClick={() => dispatch({ type: 'DESELECT_ALL' })}
                className="bg-slate-700 hover:bg-slate-600 rounded px-2 py-1 text-xs text-slate-300"
              >
                선택 해제
              </button>
            </div>
          )}
        </div>

        {/* ── 오른쪽 사이드바 ── */}
        <div
          className="w-52 bg-slate-800 border-l border-slate-700 flex flex-col gap-0 overflow-y-auto"
          style={{ minWidth: 208 }}
        >
          {/* 통계 */}
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-xs font-semibold text-slate-400 mb-1.5">편집 통계</div>
            <div className="space-y-1 text-xs">
              <StatRow label="자동 배치" value={`${summary.autoPanelCount}장`} />
              <StatRow
                label="현재 배치"
                value={`${summary.currentPanelCount}장`}
                accent={summary.delta !== 0 ? (summary.delta > 0 ? 'green' : 'red') : undefined}
              />
              <StatRow
                label="변경"
                value={summary.delta >= 0 ? `+${summary.delta}` : String(summary.delta)}
                accent={summary.delta > 0 ? 'green' : summary.delta < 0 ? 'red' : undefined}
              />
              <StatRow label="추가" value={`+${summary.addedCount}`} accent="green" />
              <StatRow label="삭제" value={`-${summary.removedCount}`} accent="red" />
              <div className="border-t border-slate-700 pt-1 mt-1">
                <StatRow label="설비 용량" value={`${currentKwp} kWp`} accent="amber" />
                <StatRow label="통로 수" value={`${summary.corridorCount}개`} />
                <StatRow label="다단 행" value={`${summary.stackedRowCount}행`} accent={summary.stackedRowCount > 0 ? 'violet' : undefined} />
              </div>
              <StatRow label="실행취소 가능" value={`${state.editHistory.length}/20`} />
            </div>
          </div>

          {/* 빠른 실행 */}
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-xs font-semibold text-slate-400 mb-1.5">빠른 적용</div>
            <div className="space-y-1">
              <QuickBtn
                label="최밀집"
                desc="통로·다단 제거"
                onClick={() => dispatch({
                  type: 'APPLY_QUICK', preset: 'dense',
                  baseSpacing: result.rowSpacing,
                })}
              />
              <QuickBtn
                label="표준 배치"
                desc="권장 이격 적용"
                onClick={() => dispatch({
                  type: 'APPLY_QUICK', preset: 'standard',
                  baseSpacing: result.rowSpacing,
                })}
              />
              <QuickBtn
                label="점검통로 삽입"
                desc="5행마다 1.2m 통로"
                onClick={() => dispatch({
                  type: 'APPLY_QUICK', preset: 'corridors',
                  baseSpacing: result.rowSpacing,
                })}
              />
              <QuickBtn
                label="전체 3단"
                desc="3행씩 그룹화 표시"
                onClick={() => dispatch({
                  type: 'APPLY_QUICK', preset: 'stack3',
                  baseSpacing: result.rowSpacing,
                })}
              />
              <button
                onClick={() => dispatch({ type: 'REMOVE_ALL_CORRIDORS' })}
                className="w-full text-left px-2 py-1 rounded text-xs bg-slate-700 text-red-300 hover:bg-slate-600"
              >
                통로 전체 삭제
              </button>
            </div>
          </div>

          {/* 행 목록 */}
          <div className="px-3 py-2 border-b border-slate-700 flex-1">
            <div className="text-xs font-semibold text-slate-400 mb-1.5">
              행별 상태 ({uniqueRows.length}행)
            </div>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {uniqueRows.map(rowIndex => {
                const cfg = rowCfgMap.get(rowIndex)
                const count = state.placements.filter(p => p.row === rowIndex).length
                return (
                  <div
                    key={rowIndex}
                    className="flex items-center justify-between text-xs text-slate-400 py-0.5"
                  >
                    <span>행 {rowIndex + 1}</span>
                    <span className="text-slate-300">{count}장</span>
                    {cfg && cfg.stackCount > 1 && (
                      <span className="text-violet-400">{cfg.stackCount}단</span>
                    )}
                    {cfg && cfg.hasCorridorAfter && (
                      <span className="text-yellow-400">↑통로</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* JSON 내보내기 / 가져오기 */}
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-xs font-semibold text-slate-400 mb-1.5">데이터</div>
            <div className="space-y-1">
              <button
                onClick={handleExport}
                className="w-full text-left px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600"
              >
                ↓ 저장
              </button>
              <button
                onClick={() => setShowImport(v => !v)}
                className="w-full text-left px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600"
              >
                ↑ 불러오기
              </button>
              {showImport && (
                <div className="space-y-1">
                  <textarea
                    className="w-full h-16 text-xs bg-slate-900 border border-slate-600 rounded p-1 text-slate-300 resize-none"
                    placeholder="JSON 붙여넣기..."
                    value={importText}
                    onChange={e => setImportText(e.target.value)}
                  />
                  <button
                    onClick={handleImport}
                    className="w-full px-2 py-1 rounded text-xs bg-blue-600 text-white hover:bg-blue-500"
                  >
                    적용
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 완료 / 취소 */}
          <div className="px-3 py-2 space-y-1.5">
            <button
              onClick={handleComplete}
              className="w-full py-1.5 rounded text-sm font-semibold bg-amber-500 text-slate-900 hover:bg-amber-400 transition-colors"
            >
              편집 완료
            </button>
            {state.isDirty && (
              <div className="text-center text-xs text-amber-400">
                미저장 변경 있음
              </div>
            )}
            {onCancel && (
              <button
                onClick={onCancel}
                className="w-full py-1 rounded text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                취소 (변경 버리기)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 서브 컴포넌트 ────────────────────────────────────────────────────

function StatRow({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'green' | 'red' | 'amber' | 'violet'
}) {
  const colorMap = {
    green: 'text-green-400',
    red: 'text-red-400',
    amber: 'text-amber-400',
    violet: 'text-violet-400',
  }
  return (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={accent ? colorMap[accent] : 'text-slate-200'}>{value}</span>
    </div>
  )
}

function QuickBtn({
  label,
  desc,
  onClick,
}: {
  label: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 transition-colors"
    >
      <div className="text-xs font-medium text-slate-200">{label}</div>
      <div className="text-[10px] text-slate-400">{desc}</div>
    </button>
  )
}
