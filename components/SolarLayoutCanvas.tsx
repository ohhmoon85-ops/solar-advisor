'use client'

// components/SolarLayoutCanvas.tsx — 지리 미터 좌표 기반 SVG 배치 시각화 (v5.2)
// v5.2: FullAnalysisResult | MultiZoneResult 지원, 방위각 회전 패널(polygon), 검증 배지
// 외부 차트 라이브러리 없이 React + SVG만 사용

import { useState, useMemo } from 'react'
import type { FullAnalysisResult, Point, Polygon, PanelPlacement } from '@/lib/layoutEngine'
import { type MultiZoneResult, type ZoneLayoutResult, isMultiZoneResult } from '@/lib/multiZoneLayout'

// ── 상수 ───────────────────────────────────────────────────────────

/** 구역별 색상 (최대 5구역) */
const ZONE_COLORS = ['#f5a623', '#4ecdc4', '#bc8cff', '#3fb950', '#f85149']
const ZONE_STROKES = ['#c47c00', '#2a9d8f', '#8b5cf6', '#2e7d32', '#c62828']

// ── 타입 ───────────────────────────────────────────────────────────

interface Props {
  result: FullAnalysisResult | MultiZoneResult
  width?: number
  height?: number
  showLabels?: boolean
}

// ── 좌표 변환 헬퍼 ─────────────────────────────────────────────────

interface ViewBox {
  minX: number; minY: number; rangeX: number; rangeY: number
}

function buildViewBox(points: Point[], paddingPct = 0.08): ViewBox {
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rangeX = maxX - minX || 1
  const rangeY = maxY - minY || 1
  const padX = rangeX * paddingPct
  const padY = rangeY * paddingPct
  return {
    minX: minX - padX,
    minY: minY - padY,
    rangeX: rangeX + padX * 2,
    rangeY: rangeY + padY * 2,
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
  zoneLabel?: string
}

function ZoneLayer({
  result, vb, svgW, svgH,
  panelColor, panelStroke, zoneIndex,
  hoveredPanel, onHover, showOriginal, zoneLabel,
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
      {/* 원본 필지 경계 */}
      {showOriginal && originalPolygon.length > 2 && (
        <polygon
          points={polygonToSvgPoints(originalPolygon, vb, svgW, svgH)}
          fill="rgba(255,255,255,0.04)"
          stroke="#94a3b8"
          strokeWidth="1.5"
          strokeDasharray="5,3"
        />
      )}

      {/* Safe Zone */}
      {safeZonePolygon.length > 2 && (
        <polygon
          points={polygonToSvgPoints(safeZonePolygon, vb, svgW, svgH)}
          fill={`${panelColor}10`}
          stroke="#22c55e"
          strokeWidth="1"
          strokeDasharray="3,2"
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
            fill={isHovered ? '#ffffff' : panelColor}
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
}: Props) {
  const [hoveredPanel, setHoveredPanel] = useState<PanelPlacement | null>(null)

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

  // ViewBox: 모든 구역의 좌표 통합
  const allPoints = useMemo<Point[]>(() => {
    const pts: Point[] = []
    for (const item of analysisItems) {
      pts.push(...item.safeZone.originalPolygon)
      pts.push(...item.safeZone.safeZonePolygon)
    }
    return pts
  }, [analysisItems])

  const vb = useMemo(() => buildViewBox(allPoints), [allPoints])

  const LEGEND_H = 80
  const svgW = width
  const svgH = height - LEGEND_H
  const drawH = svgH

  if (allPoints.length < 3) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        배치 데이터가 없습니다
      </div>
    )
  }

  return (
    <div className="relative" style={{ width, height }}>
      <svg
        viewBox={`0 0 ${svgW} ${drawH}`}
        width={svgW}
        height={drawH}
        className="bg-slate-900 rounded-lg border border-slate-700"
        style={{ display: 'block' }}
      >
        {/* 구역별 레이어 */}
        {analysisItems.map((item, idx) => {
          const color = ZONE_COLORS[idx % ZONE_COLORS.length]
          const stroke = ZONE_STROKES[idx % ZONE_STROKES.length]
          const zoneLabel = isMulti
            ? (item as ZoneLayoutResult).zoneLabel
            : undefined

          return (
            <ZoneLayer
              key={idx}
              result={item}
              vb={vb}
              svgW={svgW}
              svgH={drawH}
              panelColor={color}
              panelStroke={stroke}
              zoneIndex={idx}
              hoveredPanel={hoveredPanel}
              onHover={setHoveredPanel}
              showOriginal={idx === 0}  // 원본 필지는 첫 번째 구역만
              zoneLabel={zoneLabel}
            />
          )
        })}

        {/* 북방위 표시 */}
        <g transform={`translate(${svgW - 36}, 28)`}>
          <circle r="16" fill="rgba(15,23,42,0.7)" stroke="#475569" strokeWidth="1" />
          <polygon points="0,-12 4,4 0,2 -4,4" fill="#f8fafc" />
          <polygon points="0,12 4,-4 0,-2 -4,-4" fill="#475569" />
          <text x="0" y="-14" textAnchor="middle" fontSize="8" fill="#f8fafc" fontWeight="bold">N</text>
        </g>

        {/* 검증 경고 배지 (좌상단) */}
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

        {/* 호버 툴팁 */}
        {hoveredPanel && (() => {
          const ctr = panelCenter(hoveredPanel.corners, vb, svgW, drawH)
          const tx = Math.min(ctr.sx, svgW - 100)
          const ty = Math.max(ctr.sy - 32, 8)
          return (
            <g>
              <rect x={tx - 4} y={ty - 14} width="100" height="20"
                fill="rgba(15,23,42,0.9)" rx="3" />
              <text x={tx} y={ty} fontSize="9" fill="#f8fafc" textAnchor="start">
                {`행${hoveredPanel.row + 1} 열${hoveredPanel.col + 1}  #${hoveredPanel.id + 1}`}
              </text>
            </g>
          )
        })()}
      </svg>

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
      <div className="flex items-center gap-4 px-2 pt-2 pb-1 text-xs text-slate-400 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 border border-dashed border-slate-400" />
          원본 필지
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 border border-green-500 border-dashed" />
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
      </div>
    </div>
  )
}
