'use client'

import { useRef, useState } from 'react'
import { useSolarStore } from '@/store/useStore'
import type { FullAnalysisResult } from '@/lib/layoutEngine'
import type { MultiZoneResult } from '@/lib/multiZoneLayout'

// ── SVG canvas dimensions (A3 landscape proportion) ───────────────
const SVG_W = 1120
const SVG_H = 794
const TB_W = 200           // title block (right side)
const DRAW_W = SVG_W - TB_W  // 920 — actual drawing area
const DRAW_H = SVG_H         // 794

// Drawing area width in mm on A3 (420mm sheet minus title block)
const DRAW_W_MM = 420 - (TB_W / SVG_W) * 420   // ≈ 345 mm

const STANDARD_SCALES = [50, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 3000, 5000]
const NICE_BAR_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

// ── Coordinate utilities ──────────────────────────────────────────
interface Pt { x: number; y: number }
interface VBox { minX: number; minY: number; rangeX: number; rangeY: number }

function buildVBox(pts: Pt[], w: number, h: number, pad = 0.10): VBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const dX = maxX - minX || 1, dY = maxY - minY || 1
  const scale = Math.min(w / (dX * (1 + pad * 2)), h / (dY * (1 + pad * 2)))
  const rangeX = w / scale, rangeY = h / scale
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  return { minX: cx - rangeX / 2, minY: cy - rangeY / 2, rangeX, rangeY }
}

function pxSvg(p: Pt, vb: VBox): [number, number] {
  return [
    ((p.x - vb.minX) / vb.rangeX) * DRAW_W,
    DRAW_H - ((p.y - vb.minY) / vb.rangeY) * DRAW_H,
  ]
}

function toPts(poly: Pt[], vb: VBox): string {
  return poly.map(p => { const [x, y] = pxSvg(p, vb); return `${x.toFixed(1)},${y.toFixed(1)}` }).join(' ')
}

function selectScale(rangeX: number): number {
  const raw = (rangeX * 1000) / DRAW_W_MM
  return STANDARD_SCALES.find(s => s >= raw) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1]
}

function niceBarM(rangeX: number): number {
  const target = rangeX * 0.18
  return NICE_BAR_M.reduce((best, v) => Math.abs(v - target) < Math.abs(best - target) ? v : best)
}

function isMultiZone(v: unknown): v is MultiZoneResult {
  return typeof v === 'object' && v !== null && 'zones' in v && Array.isArray((v as MultiZoneResult).zones)
}

// ── Component ─────────────────────────────────────────────────────
export default function DrawingTab() {
  const svgRef = useRef<SVGSVGElement>(null)
  const [exporting, setExporting] = useState(false)
  const { lastFullAnalysisJson, mapResult, setActiveTab } = useSolarStore()

  // Parse analysis result
  let result: FullAnalysisResult | null = null
  let multiZoneCount = 0

  if (lastFullAnalysisJson) {
    try {
      const parsed = JSON.parse(lastFullAnalysisJson)
      if (isMultiZone(parsed)) {
        if (parsed.zones.length > 0) {
          result = parsed.zones[0]
          multiZoneCount = parsed.zones.length
        }
      } else {
        result = parsed as FullAnalysisResult
      }
    } catch { /* ignore */ }
  }

  // Empty state
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-6xl mb-5">📐</div>
        <h2 className="text-xl font-bold text-gray-700 mb-2">정밀 분석 결과가 없습니다</h2>
        <p className="text-gray-500 text-sm mb-6">지도 탭에서 부지를 선택하고 정밀 분석을 실행한 후 돌아오세요.</p>
        <button
          onClick={() => setActiveTab('map')}
          className="px-5 py-2.5 bg-blue-500 text-white rounded-xl font-medium hover:bg-blue-600 transition-colors"
        >
          🗺️ 지도 탭으로 이동
        </button>
      </div>
    )
  }

  // Build drawing data
  const boundary = result.safeZone.originalPolygon
  const safeZone = result.safeZone.safeZonePolygon
  const placements = result.layout.placements

  const allPts: Pt[] = [...boundary, ...(safeZone ?? []), ...placements.flatMap(p => [...p.corners])]
  const vb = buildVBox(allPts, DRAW_W, DRAW_H)
  const scale = selectScale(vb.rangeX)

  // Scale bar
  const barM = niceBarM(vb.rangeX)
  const barPx = (barM / vb.rangeX) * DRAW_W

  // Title block data
  const address = mapResult?.address ?? '주소 정보 없음'
  const addrLine1 = address.length > 16 ? address.slice(0, 16) : address
  const addrLine2 = address.length > 16 ? (address.length > 32 ? address.slice(16, 30) + '…' : address.slice(16)) : null
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })

  const TB_HEADER_H = 52
  const TB_ROW_H = (SVG_H - TB_HEADER_H) / 8

  const tbRows = [
    { label: '주 소', val1: addrLine1, val2: addrLine2 },
    { label: '패널 수', val1: `${result.layout.totalCount.toLocaleString()} 장`, val2: null },
    { label: '설비 용량', val1: `${result.layout.totalKwp.toFixed(2)} kWp`, val2: null },
    { label: '경사각 (최적)', val1: `${result.optimalTilt}°`, val2: null },
    { label: '방위각', val1: `${result.azimuthDeg}° (정남 기준)`, val2: null },
    { label: '배열 간격', val1: `${result.rowSpacing.toFixed(2)} m`, val2: null },
    { label: '축 척', val1: `1 : ${scale.toLocaleString()}`, val2: null },
    { label: '작성일', val1: today, val2: null },
  ]

  const FONT = 'Malgun Gothic, Apple SD Gothic Neo, NanumGothic, sans-serif'

  // PDF export
  const handleExport = async () => {
    if (!svgRef.current || exporting) return
    setExporting(true)
    try {
      const xml = new XMLSerializer().serializeToString(svgRef.current)
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      await new Promise<void>((resolve, reject) => {
        const img = new Image()
        img.onload = async () => {
          try {
            const UPSCALE = 3
            const canvas = document.createElement('canvas')
            canvas.width = SVG_W * UPSCALE
            canvas.height = SVG_H * UPSCALE
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
            URL.revokeObjectURL(url)

            const { jsPDF } = await import('jspdf')
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
            pdf.addImage(canvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, 420, 297)
            const fname = `배치도_${address.replace(/\s+/g, '_').replace(/[^\w가-힣]/g, '').slice(0, 30)}.pdf`
            pdf.save(fname)
            resolve()
          } catch (e) { reject(e) }
        }
        img.onerror = reject
        img.src = url
      })
    } catch {
      alert('PDF 저장 중 오류가 발생했습니다.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Multi-zone notice */}
      {multiZoneCount > 1 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-700">
          ⚠️ 다구역 분석({multiZoneCount}개 구역) 결과입니다. 도면에는 구역 1만 표시됩니다.
        </div>
      )}

      {/* Header controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-gray-800">📐 태양광 패널 배치도</h2>
          <p className="text-xs text-gray-500 mt-0.5">참조용 도면 — 실제 설치 전 공인 측량 및 구조 설계 필요</p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex-shrink-0"
        >
          {exporting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              PDF 생성 중…
            </>
          ) : '📄 PDF로 저장 (A3)'}
        </button>
      </div>

      {/* SVG drawing */}
      <div className="border border-gray-300 rounded-xl overflow-hidden shadow-sm bg-white">
        <div className="overflow-x-auto">
          <svg
            ref={svgRef}
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
          >
            <defs>
              <clipPath id="dc">
                <rect x={0} y={0} width={DRAW_W} height={DRAW_H} />
              </clipPath>
            </defs>

            {/* Backgrounds */}
            <rect width={SVG_W} height={SVG_H} fill="#e8edf5" />
            <rect x={0} y={0} width={DRAW_W} height={DRAW_H} fill="#ffffff" />

            {/* Drawing content */}
            <g clipPath="url(#dc)">
              {/* Safe zone (dashed blue) */}
              {safeZone && safeZone.length >= 3 && (
                <polygon
                  points={toPts(safeZone, vb)}
                  fill="#eff6ff"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  strokeDasharray="7 3"
                  opacity="0.85"
                />
              )}

              {/* Boundary (solid dark) */}
              <polygon
                points={toPts(boundary, vb)}
                fill="none"
                stroke="#1e293b"
                strokeWidth="2.5"
              />

              {/* Panels */}
              {placements.map(p => (
                <polygon
                  key={p.id}
                  points={toPts([...p.corners], vb)}
                  fill="#fde68a"
                  stroke="#b45309"
                  strokeWidth="0.35"
                />
              ))}

              {/* N-arrow (top-left) */}
              <g transform="translate(38, 52)">
                <circle cx="0" cy="0" r="16" fill="white" stroke="#1e293b" strokeWidth="1.5" />
                <line x1="0" y1="11" x2="0" y2="-7" stroke="#1e293b" strokeWidth="2" strokeLinecap="round" />
                <polygon points="0,-13 -4,-4 4,-4" fill="#1e293b" />
                <text x="0" y="26" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#1e293b" fontFamily={FONT}>N</text>
              </g>

              {/* Scale bar (bottom-left) */}
              <g transform={`translate(20, ${DRAW_H - 28})`}>
                <rect x={0} y={0} width={barPx} height={8} fill="none" stroke="#374151" strokeWidth="1.2" />
                <rect x={0} y={0} width={barPx / 2} height={8} fill="#374151" />
                <text x={0} y={20} fontSize="9" fill="#374151" fontFamily={FONT}>0</text>
                <text x={barPx / 2} y={20} textAnchor="middle" fontSize="9" fill="#374151" fontFamily={FONT}>{barM / 2}m</text>
                <text x={barPx} y={20} textAnchor="end" fontSize="9" fill="#374151" fontFamily={FONT}>{barM}m</text>
              </g>
            </g>

            {/* Drawing area border */}
            <rect x={0} y={0} width={DRAW_W} height={DRAW_H} fill="none" stroke="#374151" strokeWidth="1.5" />

            {/* ── Title block ────────────────────────────────── */}
            <rect x={DRAW_W} y={0} width={TB_W} height={SVG_H} fill="#f9fafb" />
            <rect x={DRAW_W} y={0} width={TB_W} height={SVG_H} fill="none" stroke="#374151" strokeWidth="1.5" />

            {/* Header */}
            <rect x={DRAW_W} y={0} width={TB_W} height={TB_HEADER_H} fill="#1e3a8a" />
            <text x={DRAW_W + TB_W / 2} y={21} textAnchor="middle" fontSize="12" fontWeight="bold" fill="white" fontFamily={FONT}>
              태양광 패널 배치도
            </text>
            <text x={DRAW_W + TB_W / 2} y={38} textAnchor="middle" fontSize="8.5" fill="#bfdbfe" fontFamily={FONT}>
              Solar Panel Layout Drawing
            </text>
            <line x1={DRAW_W} y1={TB_HEADER_H} x2={SVG_W} y2={TB_HEADER_H} stroke="#374151" strokeWidth="1" />

            {/* Data rows */}
            {tbRows.map((row, i) => {
              const ry = TB_HEADER_H + i * TB_ROW_H
              const isLast = i === tbRows.length - 1
              return (
                <g key={i}>
                  {!isLast && <line x1={DRAW_W} y1={ry + TB_ROW_H} x2={SVG_W} y2={ry + TB_ROW_H} stroke="#d1d5db" strokeWidth="0.7" />}
                  {/* Label band */}
                  <rect x={DRAW_W} y={ry} width={TB_W} height={17} fill="#dbeafe" />
                  <text x={DRAW_W + 8} y={ry + 12} fontSize="8.5" fill="#1e40af" fontFamily={FONT}>{row.label}</text>
                  {/* Value */}
                  <text x={DRAW_W + 8} y={ry + 17 + (TB_ROW_H - 17) * 0.55} fontSize="11" fontWeight="bold" fill="#111827" fontFamily={FONT}>
                    {row.val1}
                  </text>
                  {row.val2 && (
                    <text x={DRAW_W + 8} y={ry + 17 + (TB_ROW_H - 17) * 0.82} fontSize="10" fill="#374151" fontFamily={FONT}>
                      {row.val2}
                    </text>
                  )}
                </g>
              )
            })}

            {/* Legend (inside title block, bottom area) */}
            <g transform={`translate(${DRAW_W + 8}, ${SVG_H - 68})`}>
              <text fontSize="8" fill="#6b7280" fontFamily={FONT} y={0}>— 범 례 —</text>
              <rect x={0} y={6} width={16} height={9} fill="none" stroke="#1e293b" strokeWidth="2" />
              <text x={20} y={14} fontSize="8" fill="#374151" fontFamily={FONT}>부지 경계</text>
              <rect x={0} y={21} width={16} height={9} fill="#eff6ff" stroke="#3b82f6" strokeWidth="1.2" strokeDasharray="4 2" />
              <text x={20} y={29} fontSize="8" fill="#374151" fontFamily={FONT}>설치 가능 구역</text>
              <rect x={0} y={36} width={16} height={9} fill="#fde68a" stroke="#b45309" strokeWidth="0.8" />
              <text x={20} y={44} fontSize="8" fill="#374151" fontFamily={FONT}>태양광 패널</text>
            </g>
          </svg>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-4 py-2">
        ⚠️ 본 도면은 시각적 참조용이며, 실제 설치를 위해서는 공인 측량사의 정밀 측량 및 구조기술사의 설계가 필요합니다.
      </p>
    </div>
  )
}
