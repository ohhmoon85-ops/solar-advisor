'use client'

// components/SolarLayoutCanvas.tsx — 지리 미터 좌표 기반 SVG 배치 시각화 (v5.2)
// v5.2: FullAnalysisResult | MultiZoneResult 지원, 방위각 회전 패널(polygon), 검증 배지
// 외부 차트 라이브러리 없이 React + SVG만 사용

import { useState, useMemo, useRef, useCallback } from 'react'
import type { FullAnalysisResult, Point, Polygon, PanelPlacement } from '@/lib/layoutEngine'
import { type MultiZoneResult, type ZoneLayoutResult, isMultiZoneResult } from '@/lib/multiZoneLayout'

// ── 상수 ───────────────────────────────────────────────────────────

/** 구역별 색상 (최대 5구역) */
const ZONE_COLORS = ['rgba(230,81,0,0.85)', 'rgba(0,137,123,0.85)', '#bc8cff', '#3fb950', '#f85149']
const ZONE_STROKES = ['#BF360C', '#004D40', '#8b5cf6', '#2e7d32', '#c62828']

const MIN_ZOOM = 0.5
const MAX_ZOOM = 12

// ── 타입 ───────────────────────────────────────────────────────────

interface Props {
  result: FullAnalysisResult | MultiZoneResult
  width?: number
  height?: number
  showLabels?: boolean
  activeZoneId?: string
  geoOrigin?: { lat: number; lon: number }
}

// ── 좌표 변환 헬퍼 ─────────────────────────────────────────────────

interface ViewBox {
  minX: number; minY: number; rangeX: number; rangeY: number
}

function buildViewBox(points: Point[], svgW: number, svgH: number, paddingPct = 0.08): ViewBox {
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const dataRangeX = maxX - minX || 1
  const dataRangeY = maxY - minY || 1
  // Equal aspect ratio: choose scale so both axes fit within SVG with padding
  const scaleX = svgW / (dataRangeX * (1 + paddingPct * 2))
  const scaleY = svgH / (dataRangeY * (1 + paddingPct * 2))
  const scale = Math.min(scaleX, scaleY)
  const rangeX = svgW / scale
  const rangeY = svgH / scale
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    minX: centerX - rangeX / 2,
    minY: centerY - rangeY / 2,
    rangeX,
    rangeY,
  }
}

function toSvg(
  p: Point,
  vb: ViewBox,
  svgW: number,
  svgH: number
): { sx: number; sy: number } {
  const sx = ((p.x - vb.minX) / vb.rangeX) * svgW
  // Y축 반전: 지리 좌표는 북=+, SVG는 하향=+
  const sy = svgH - ((p.y - vb.minY) / vb.rangeY) * svgH
  return { sx, sy }
}

function polygonToSvgPoints(
  poly: Polygon,
  vb: ViewBox,
  svgW: number,
  svgH: number
): string {
  return poly
    .map(p => {
      const { sx, sy } = toSvg(p, vb, svgW, svgH)
      return `${sx.toFixed(1)},${sy.toFixed(1)}`
    })
    .join(' ')
}

/** 패널 4 꼭짓점 → SVG polygon points 문자열 (방위각 회전 지원) */
function panelCornersToSvgPoints(
  corners: [Point, Point, Point, Point],
  vb: ViewBox,
  svgW: number,
  svgH: number
): string {
  return corners
    .map(p => {
      const { sx, sy } = toSvg(p, vb, svgW, svgH)
      return `${sx.toFixed(1)},${sy.toFixed(1)}`
    })
    .join(' ')
}

/** 패널 중심 SVG 좌표 */
function panelCenter(
  corners: [Point, Point, Point, Point],
  vb: ViewBox,
  svgW: number,
  svgH: number
): { sx: number; sy: number } {
  const cx = (corners[0].x + corners[2].x) / 2
  const cy = (corners[0].y + corners[2].y) / 2
  return toSvg({ x: cx, y: cy }, vb, svgW, svgH)
}

// ── 위성 타일 좌표 헬퍼 (Web Mercator / TMS) ───────────────────────
function lonToTileX(lon: number, z: number) { return Math.floor((lon + 180) / 360 * (1 << z)) }
function latToTileY(lat: number, z: number) {
  const lr = lat * Math.PI / 180
  return Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * (1 << z))
}
function tileToLon(tx: number, z: number) { return tx / (1 << z) * 360 - 180 }
function tileToLat(ty: number, z: number) {
  const n = Math.PI - 2 * Math.PI * ty / (1 << z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

// ── 단일 구역 레이어 ────────────────────────────────────────────────

interface ZoneLayerProps {
  result: FullAnalysisResult | ZoneLayoutResult
  vb: ViewBox
  svgW: number
  svgH: number
  panelColor: string
  panelStroke: string
  zoneIndex: number
  hoveredPanel: PanelPlacement | null
  onHover: (p: PanelPlacement | null) => void
  showOriginal: boolean
  isActive: boolean
  zoneLabel?: string
  hasSatBg?: boolean
}

function ZoneLayer({
  result, vb, svgW, svgH,
  panelColor, panelStroke, zoneIndex,
  hoveredPanel, onHover, showOriginal, zoneLabel,
  isActive, hasSatBg = false,
}: ZoneLayerProps) {
  const { safeZone, layout } = result
  const { originalPolygon, safeZonePolygon } = safeZone

  // 구역 무게중심 (라벨 위치)
  const centroid = useMemo(() => {
    if (safeZonePolygon.length === 0) return null
    const cx = safeZonePolygon.reduce((s, p) => s + p.x, 0) / safeZonePolygon.length
    const cy = safeZonePolygon.reduce((s, p) => s + p.y, 0) / safeZonePolygon.length
    return toSvg({ x: cx, y: cy }, vb, svgW, svgH)
  }, [safeZonePolygon, vb, svgW, svgH])

  return (
    <g>
      {/* Layer 1: 마진 구간 — 원본 필지를 연한 빨간색으로 채움 (safe zone 밖만 보임) */}
      {showOriginal && originalPolygon.length > 2 && (
        <polygon
          points={polygonToSvgPoints(originalPolygon, vb, svgW, svgH)}
          fill="rgba(211,47,47,0.15)"
          stroke="none"
        />
      )}

      {/* Layer 2a: Safe Zone 덮개 — 위성 배경 없을 때만 불투명 흰 덮개 적용 */}
      {showOriginal && safeZonePolygon.length > 2 && !hasSatBg && (
        <polygon
          points={polygonToSvgPoints(safeZonePolygon, vb, svgW, svgH)}
          fill="rgba(240,253,244,0.92)"
          stroke="none"
        />
      )}

      {/* Layer 2b: Safe Zone — 초록 점선 테두리 + 연초록 채움 */}
      {safeZonePolygon.length > 2 && (
        <polygon
          points={polygonToSvgPoints(safeZonePolygon, vb, svgW, svgH)}
          fill="rgba(46,125,50,0.12)"
          stroke="#2E7D32"
          strokeWidth="2.0"
          strokeDasharray="8,4"
        />
      )}

      {/* Layer 2c: 원본 필지 경계선 — 파란 테두리 + 연한 파란 채움 */}
      {showOriginal && originalPolygon.length > 2 && (
        <polygon
          points={polygonToSvgPoints(originalPolygon, vb, svgW, svgH)}
          fill="rgba(21,101,192,0.08)"
          stroke="#1565C0"
          strokeWidth="2.5"
        />
      )}

      {/* 패널 (polygon 렌더 — 방위각 회전 지원) */}
      {layout.placements.map(panel => {
        const pts = panelCornersToSvgPoints(panel.corners, vb, svgW, svgH)
        const isHovered = hoveredPanel?.id === panel.id && hoveredPanel?.row === panel.row
        return (
          <polygon
            key={`z${zoneIndex}-p${panel.id}`}
            points={pts}
            fill={isHovered ? '#ffffff' : (isActive !== false ? panelColor : 'rgba(230,81,0,0.45)')}
            stroke={panelStroke}
            strokeWidth={isHovered ? 1.5 : 0.5}
            opacity={isHovered ? 1 : 0.85}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => onHover(panel)}
            onMouseLeave={() => onHover(null)}
          />
        )
      })}

      {/* 구역 라벨 (다구역 모드) */}
      {zoneLabel && centroid && (
        <g>
          <rect
            x={centroid.sx - 18} y={centroid.sy - 10}
            width={36} height={18} rx={4}
            fill="rgba(15,23,42,0.75)"
          />
          <text
            x={centroid.sx} y={centroid.sy + 4}
            textAnchor="middle" fontSize={10}
            fill={panelColor} fontWeight="bold"
          >
            {zoneLabel}
          </text>
        </g>
      )}
    </g>
  )
}

// ── 메인 컴포넌트 ───────────────────────────────────────────────────

export default function SolarLayoutCanvas({
  result,
  width = 600,
  height = 460,
  showLabels = true,
  activeZoneId,
  geoOrigin,
}: Props) {
  const [hoveredPanel, setHoveredPanel] = useState<PanelPlacement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  // Refs to avoid stale closures in event handlers
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const touchDistRef = useRef<number | null>(null)
  const touchZoomStartRef = useRef(1)
  const touchPanStartRef = useRef({ x: 0, y: 0 })
  const touchMidStartRef = useRef({ x: 0, y: 0 })

  // Keep refs in sync with state
  zoomRef.current = zoom
  panRef.current = pan

  const isMulti = isMultiZoneResult(result)

  // 단일/다구역 → 공통 데이터 추출
  const analysisItems: (FullAnalysisResult | ZoneLayoutResult)[] = isMulti
    ? (result as MultiZoneResult).zones
    : [result as FullAnalysisResult]

  const totalCount = isMulti
    ? (result as MultiZoneResult).totalCount
    : (result as FullAnalysisResult).layout.totalCount
  const totalKwp = isMulti
    ? (result as MultiZoneResult).totalKwp
    : (result as FullAnalysisResult).layout.totalKwp

  // 검증 결과 (단일 구역만 표시)
  const validation = !isMulti ? (result as FullAnalysisResult).validation : undefined
  const hasWarning = validation && !validation.isValid

  const LEGEND_H = 80
  const svgW = width
  const svgH = height - LEGEND_H
  const drawH = svgH

  // ViewBox: 모든 구역의 좌표 통합
  const allPoints = useMemo<Point[]>(() => {
    const pts: Point[] = []
    for (const item of analysisItems) {
      pts.push(...item.safeZone.originalPolygon)
      pts.push(...item.safeZone.safeZonePolygon)
    }
    return pts
  }, [analysisItems])

  const vb = useMemo(() => buildViewBox(allPoints, svgW, drawH), [allPoints, svgW, drawH])

  // 위성 + 도로 타일 공통 지오메트리 (geoOrigin 제공 시만)
  // SVG viewBox는 equirectangular → tileToLat/tileToLon으로 정확한 지리 높이 계산
  const svgTileData = useMemo(() => {
    if (!geoOrigin || vb.rangeX <= 0 || vb.rangeY <= 0) return []
    const latRad = geoOrigin.lat * Math.PI / 180
    const mpdLon = 111319.9 * Math.cos(latRad)
    const geoMinLat = geoOrigin.lat + vb.minY / 111319.9
    const geoMaxLat = geoOrigin.lat + (vb.minY + vb.rangeY) / 111319.9
    const geoMinLon = geoOrigin.lon + vb.minX / mpdLon
    const geoMaxLon = geoOrigin.lon + (vb.minX + vb.rangeX) / mpdLon
    const rangeM = Math.max(vb.rangeX, vb.rangeY)
    // 소형 필지(~60m)에서 z=14 산출 -> 타일 8000% 스트레칭 문제 수정.
    // SVG 표시 밀도(m/px) 역산으로 z=17-18 확보 (한국 소형 필지 최적).
    const displayMPerPx = rangeM / Math.min(svgW, drawH)
    const z = Math.min(18, Math.max(15, Math.round(
      Math.log2(40075016.7 * Math.cos(latRad) / (256 * displayMPerPx))
    )))
    const txMin = lonToTileX(geoMinLon, z)
    const txMax = lonToTileX(geoMaxLon, z)
    const tyMin = latToTileY(geoMaxLat, z) // 북쪽 = 작은 ty
    const tyMax = latToTileY(geoMinLat, z)
    const data: { key: string; z: number; tx: number; ty: number; x: number; y: number; w: number; h: number; bbox: string }[] = []
    for (let tx = txMin; tx <= txMax; tx++) {
      for (let ty = tyMin; ty <= tyMax; ty++) {
        const lon0 = tileToLon(tx, z), lon1 = tileToLon(tx + 1, z)
        const lat0 = tileToLat(ty, z), lat1 = tileToLat(ty + 1, z) // lat0 > lat1 (북>남)
        const enu0 = { x: (lon0 - geoOrigin.lon) * mpdLon, y: (lat0 - geoOrigin.lat) * 111319.9 }
        const enu1 = { x: (lon1 - geoOrigin.lon) * mpdLon, y: (lat1 - geoOrigin.lat) * 111319.9 }
        const nw = toSvg(enu0, vb, svgW, drawH) // NW → SVG 상단-좌
        const se = toSvg(enu1, vb, svgW, drawH) // SE → SVG 하단-우
        // WMS bbox: latS,west,latN,east (WMS 1.3.0 EPSG:4326)
        const bbox = `${lat1.toFixed(6)},${lon0.toFixed(6)},${lat0.toFixed(6)},${lon1.toFixed(6)}`
        data.push({ key: `${z}/${tx}/${ty}`, z, tx, ty, x: nw.sx, y: nw.sy, w: se.sx - nw.sx, h: se.sy - nw.sy, bbox })
      }
    }
    return data
  }, [geoOrigin, vb, svgW, drawH])

  // Layer 1: 위성 배경 타일 (VWorld Satellite WMTS)
  const bgTiles = useMemo(() =>
    svgTileData.map(t => ({ ...t, url: `/api/vworld?type=satellite&z=${t.z}&x=${t.tx}&y=${t.ty}` }))
  , [svgTileData])

  // Layer 2: 도로 오버레이 타일 (VWorld Base WMTS, multiply -- 도로 라벨)
  const roadTiles = useMemo(() =>
    svgTileData.map(t => ({ ...t, url: `/api/vworld?type=basetile&z=${t.z}&x=${t.tx}&y=${t.ty}` }))
  , [svgTileData])

  // Layer 3: VWorld WMS 지적 경계 오버레이 (lp_pa_cbnd_bubun -- 투명 PNG)
  // 지번 경계선 참조 (위성/도로 위에 표시)
  const cadBdTiles = useMemo(() =>
    svgTileData.map(t => ({
      ...t,
      url: `/api/vworld?type=wms&bbox=${encodeURIComponent(t.bbox)}&layers=lp_pa_cbnd_bubun&width=256&height=256&transparent=true`,
    }))
  , [svgTileData])

  // Layer 4: VWorld WMS 지형도 (lt_c_landinfobasemap -- 도로+지번)
  // 위성 없을 때도 도로 확인 가능한 지도 배경
  const topoTiles = useMemo(() =>
    svgTileData.map(t => ({
      ...t,
      url: `/api/vworld?type=wms&bbox=${encodeURIComponent(t.bbox)}&layers=lt_c_landinfobasemap&width=256&height=256&transparent=true`,
    }))
  , [svgTileData])

  // ── 줌/팬 핸들러 ─────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 0.89
    const curZoom = zoomRef.current
    const curPan = panRef.current
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, curZoom * factor))

    // 커서 위치 기준으로 확대/축소
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const dataX = (mouseX - curPan.x) / curZoom
    const dataY = (mouseY - curPan.y) / curZoom
    const newPan = {
      x: mouseX - dataX * newZoom,
      y: mouseY - dataY * newZoom,
    }

    setZoom(newZoom)
    setPan(newPan)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    // 패널 호버 중 드래그 방지 (패널 클릭은 hover로만 처리)
    isDraggingRef.current = true
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    panStartRef.current = { ...panRef.current }
    ;(e.currentTarget as SVGSVGElement).style.cursor = 'grabbing'
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDraggingRef.current) return
    setPan({
      x: panStartRef.current.x + e.clientX - dragStartRef.current.x,
      y: panStartRef.current.y + e.clientY - dragStartRef.current.y,
    })
  }, [])

  const handleMouseUp = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    isDraggingRef.current = false
    ;(e.currentTarget as SVGSVGElement).style.cursor = 'grab'
  }, [])

  const handleMouseLeave = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    isDraggingRef.current = false
    ;(e.currentTarget as SVGSVGElement).style.cursor = 'grab'
  }, [])

  // 터치 핸들러 (1손가락: 팬, 2손가락: 핀치 줌)
  const handleTouchStart = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      )
      touchDistRef.current = dist
      touchZoomStartRef.current = zoomRef.current
      touchPanStartRef.current = { ...panRef.current }
      touchMidStartRef.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      }
    } else if (e.touches.length === 1) {
      isDraggingRef.current = true
      dragStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      panStartRef.current = { ...panRef.current }
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    e.preventDefault()
    if (e.touches.length === 2 && touchDistRef.current !== null) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      )
      const scale = dist / touchDistRef.current
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, touchZoomStartRef.current * scale))

      const curMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const curMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2
      const startMid = touchMidStartRef.current
      const startPan = touchPanStartRef.current
      const startZoom = touchZoomStartRef.current

      // 핀치 중심점 기준 줌 + 팬 반영
      const dataX = (startMid.x - startPan.x) / startZoom
      const dataY = (startMid.y - startPan.y) / startZoom
      setZoom(newZoom)
      setPan({
        x: curMidX - dataX * newZoom,
        y: curMidY - dataY * newZoom,
      })
    } else if (e.touches.length === 1 && isDraggingRef.current) {
      setPan({
        x: panStartRef.current.x + e.touches[0].clientX - dragStartRef.current.x,
        y: panStartRef.current.y + e.touches[0].clientY - dragStartRef.current.y,
      })
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    isDraggingRef.current = false
    touchDistRef.current = null
  }, [])

  const handleReset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  if (allPoints.length < 3) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        배치 데이터가 없습니다
      </div>
    )
  }

  // 줌 퍼센트 표시
  const zoomPct = Math.round(zoom * 100)

  return (
    <div className="relative" style={{ width, height }}>
      <svg
        id="svg-layout-canvas"
        viewBox={`0 0 ${svgW} ${drawH}`}
        width={svgW}
        height={drawH}
        className={`${svgTileData.length > 0 ? 'bg-stone-100' : 'bg-slate-900'} rounded-lg border border-slate-700 select-none`}
        style={{ display: 'block', cursor: 'grab', touchAction: 'none' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 줌/팬 변환 그룹 */}
        <g transform={`translate(${pan.x.toFixed(2)}, ${pan.y.toFixed(2)}) scale(${zoom.toFixed(4)})`}>
          {/* Layer 0: VWorld 지형도 — 위성 없을 때만 표시 */}
          {svgTileData.length === 0 && topoTiles.map(t => (
            <image key={"topo-" + t.key} href={t.url}
              x={t.x} y={t.y} width={t.w} height={t.h}
              preserveAspectRatio="none"
              opacity={0.9}
            />
          ))}

          {/* Layer 1: 위성 타일 */}
          {bgTiles.map(t => (
            <image key={t.key} href={t.url}
              x={t.x} y={t.y} width={t.w} height={t.h}
              preserveAspectRatio="none"
            />
          ))}

          {/* Layer 2: VWorld Base 도로 오버레이 (multiply, opacity 0.55) */}
          {roadTiles.map(t => (
            <image key={"road-" + t.key} href={t.url}
              x={t.x} y={t.y} width={t.w} height={t.h}
              preserveAspectRatio="none"
              style={{ mixBlendMode: "multiply" }}
              opacity={0.55}
            />
          ))}

          {/* Layer 3: VWorld WMS 지번 경계선 (lp_pa_cbnd_bubun — 투명 PNG) */}
          {/* 실제 지번 경계·도로 위치 참조 — 도로 위 패널 수동 삭제 시 활용 */}
          {cadBdTiles.map(t => (
            <image key={"cad-" + t.key} href={t.url}
              x={t.x} y={t.y} width={t.w} height={t.h}
              preserveAspectRatio="none"
              opacity={0.85}
            />
          ))}

          {/* 구역 레이어 (경계선 + 패널) — cadBdTiles 위에 렌더 */}
          {analysisItems.map((item, idx) => (
            <ZoneLayer
              key={`zone-${idx}`}
              result={item}
              vb={vb}
              svgW={svgW}
              svgH={drawH}
              panelColor={ZONE_COLORS[idx % ZONE_COLORS.length]}
              panelStroke={ZONE_STROKES[idx % ZONE_STROKES.length]}
              zoneIndex={idx}
              hoveredPanel={hoveredPanel}
              onHover={setHoveredPanel}
              showOriginal={true}
              isActive={!activeZoneId || (item as ZoneLayoutResult).zoneLabel === activeZoneId + '구역'}
              zoneLabel={isMulti ? (item as ZoneLayoutResult).zoneLabel : undefined}
              hasSatBg={svgTileData.length > 0}
            />
          ))}

          {/* 호버 툴팁 (줌 그룹 내부 — 패널과 같이 이동) */}
          {hoveredPanel && (() => {
            const ctr = panelCenter(hoveredPanel.corners, vb, svgW, drawH)
            const tx = Math.min(ctr.sx, svgW - 110)
            const ty = Math.max(ctr.sy - 32, 8)
            return (
              <g>
                <rect x={tx - 4} y={ty - 14} width="110" height="20"
                  fill="rgba(15,23,42,0.92)" rx="3" />
                <text x={tx} y={ty} fontSize="9" fill="#f8fafc" textAnchor="start">
                  {`행${hoveredPanel.row + 1} 열${hoveredPanel.col + 1}  #${hoveredPanel.id + 1}`}
                </text>
              </g>
            )
          })()}
        </g>

        {/* 북방위 표시 (줌과 무관하게 고정) */}
        <g transform={`translate(${svgW - 36}, 28)`}>
          <circle r="16" fill="rgba(15,23,42,0.7)" stroke="#475569" strokeWidth="1" />
          <polygon points="0,-12 4,4 0,2 -4,4" fill="#f8fafc" />
          <polygon points="0,12 4,-4 0,-2 -4,-4" fill="#475569" />
          <text x="0" y="-14" textAnchor="middle" fontSize="8" fill="#f8fafc" fontWeight="bold">N</text>
        </g>

        {/* 검증 경고 배지 (좌상단, 줌 고정) */}
        {hasWarning && validation && (
          <g transform="translate(8, 8)">
            <rect x={0} y={0} width={220} height={36} rx={5}
              fill="rgba(180,83,9,0.9)" stroke="#f59e0b" strokeWidth="1" />
            <text x={8} y={14} fontSize={9} fill="#fef3c7" fontWeight="bold">
              ⚠ 실증 검증 이상
            </text>
            <text x={8} y={27} fontSize={8} fill="#fde68a">
              {validation.message.length > 38
                ? validation.message.slice(0, 38) + '…'
                : validation.message}
            </text>
          </g>
        )}

        {/* 줌 레벨 표시 (우하단) */}
        <g transform={`translate(${svgW - 8}, ${drawH - 8})`}>
          <rect x={-44} y={-16} width={44} height={16} rx={3}
            fill="rgba(15,23,42,0.7)" />
          <text x={-22} y={-4} fontSize={9} fill="#94a3b8" textAnchor="middle">
            {zoomPct}%
          </text>
        </g>
      </svg>

      {/* 줌 컨트롤 버튼 (SVG 우측 하단 오버레이) */}
      <div
        className="absolute flex flex-col gap-1"
        style={{ bottom: LEGEND_H + 8, right: 8 }}
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          onClick={() => {
            const newZoom = Math.min(MAX_ZOOM, zoom * 1.3)
            setZoom(newZoom)
            setPan(p => ({
              x: svgW / 2 - (svgW / 2 - p.x) * (newZoom / zoom),
              y: drawH / 2 - (drawH / 2 - p.y) * (newZoom / zoom),
            }))
          }}
          className="w-7 h-7 bg-slate-700 hover:bg-slate-600 text-white text-sm font-bold rounded flex items-center justify-center border border-slate-500 transition-colors"
          title="확대"
        >+</button>
        <button
          onClick={() => {
            const newZoom = Math.max(MIN_ZOOM, zoom / 1.3)
            setZoom(newZoom)
            setPan(p => ({
              x: svgW / 2 - (svgW / 2 - p.x) * (newZoom / zoom),
              y: drawH / 2 - (drawH / 2 - p.y) * (newZoom / zoom),
            }))
          }}
          className="w-7 h-7 bg-slate-700 hover:bg-slate-600 text-white text-sm font-bold rounded flex items-center justify-center border border-slate-500 transition-colors"
          title="축소"
        >−</button>
        <button
          onClick={handleReset}
          className={[
            'w-7 h-7 text-white text-[10px] font-bold rounded flex items-center justify-center border transition-colors',
            zoom !== 1 || pan.x !== 0 || pan.y !== 0
              ? 'bg-amber-600 hover:bg-amber-500 border-amber-400'
              : 'bg-slate-700 hover:bg-slate-600 border-slate-500',
          ].join(' ')}
          title="전체 보기 (Fit)"
        >↺</button>
      </div>

      {/* 통계 오버레이 (상단) */}
      {showLabels && (
        <div className="absolute top-2 left-2 flex gap-2 flex-wrap">
          {[
            { label: '설치 수', value: `${totalCount}장` },
            { label: '설비 용량', value: `${totalKwp}kWp` },
            ...(isMulti ? [{ label: '구역 수', value: `${(result as MultiZoneResult).zones.length}구역` }]
              : [
                {
                  label: '설치 효율',
                  value: `${((result as FullAnalysisResult).layout.coverageRatio * 100).toFixed(1)}%`,
                },
                {
                  label: '최적 경사',
                  value: `${(result as FullAnalysisResult).optimalTilt}°`,
                },
              ]),
          ].map(s => (
            <div key={s.label}
              className="bg-slate-900/80 border border-slate-600 rounded px-2 py-0.5 text-xs">
              <span className="text-slate-400">{s.label} </span>
              <span className="text-white font-semibold">{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* 범례 */}
      <div className="flex items-center gap-3 px-2 pt-2 pb-1 text-xs text-slate-400 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-3 rounded-sm border-2 border-blue-700" style={{ background: 'rgba(211,47,47,0.18)' }} />
          원본 필지
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-3 rounded-sm border border-dashed" style={{ borderColor: '#2E7D32', background: 'rgba(46,125,50,0.15)' }} />
          Safe Zone
        </span>
        {isMulti
          ? (result as MultiZoneResult).zones.map((z, idx) => (
              <span key={idx} className="flex items-center gap-1">
                <span className="inline-block w-4 h-3 rounded-sm"
                  style={{ backgroundColor: ZONE_COLORS[idx % ZONE_COLORS.length] }} />
                {z.zoneLabel}
              </span>
            ))
          : (
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-3 rounded-sm"
                style={{ backgroundColor: ZONE_COLORS[0] }} />
              패널
            </span>
          )
        }
        {!isMulti && (
          <span className="ml-auto text-slate-500">
            이격 {(result as FullAnalysisResult).rowSpacing.toFixed(2)}m
            {(result as FullAnalysisResult).azimuthDeg !== 180
              ? ` · 방위 ${(result as FullAnalysisResult).azimuthDeg}°`
              : ''}
          </span>
        )}
        <span className="text-slate-600 text-[10px]">휠: 확대/축소 · 드래그: 이동</span>
      </div>
    </div>
  )
}
