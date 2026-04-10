'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSolarStore } from '@/store/useStore'
import { MODULES, GENERATION_HOURS } from '@/lib/constants'

const STRUCTURE_TYPES = ['철골구조', 'RC(철근콘크리트)', '경량철골', '샌드위치 패널'] as const
type StructureType = typeof STRUCTURE_TYPES[number]

const SPACING_OPTIONS = [
  { label: '1단 1.2m', value: 1.2 },
  { label: '2단 2.3m', value: 2.3 },
]

const INSTALL_TYPES = ['건물지붕형', '일반토지형', '영농형농지', '임야형'] as const

const LOAD_LIMITS: Record<StructureType, number | null> = {
  '철골구조': null,
  'RC(철근콘크리트)': 30,
  '경량철골': 20,
  '샌드위치 패널': 15,
}

// 1px = SCALE meters on canvas
const SCALE = 0.1
const SEOUL_LAT = 37.5665
const WINTER_SUN_ALT_DEG = 90 - SEOUL_LAT - 23.45 // ~29.09°

interface Point { x: number; y: number }
interface PanelRect { x: number; y: number; w: number; h: number }

/** Ray-casting point-in-polygon algorithm */
function isPointInPolygon(px: number, py: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect =
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export default function MapTab() {
  const { setMapResult, setActiveTab } = useSolarStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [address, setAddress] = useState('')
  const [installType, setInstallType] = useState<string>('건물지붕형')
  const [moduleIndex, setModuleIndex] = useState(0)
  const [tiltAngle, setTiltAngle] = useState(33)
  const [spacingValue, setSpacingValue] = useState(1.2)
  const [slopePercent, setSlopePercent] = useState(0)
  const [structureType, setStructureType] = useState<StructureType>('철골구조')
  const [bipvEnabled, setBipvEnabled] = useState(false)

  const [drawMode, setDrawMode] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const [isComplete, setIsComplete] = useState(false)
  const [area, setArea] = useState(0)

  const [panelRects, setPanelRects] = useState<PanelRect[]>([])
  const [panelCount, setPanelCount] = useState(0)
  const [capacityKwp, setCapacityKwp] = useState(0)
  const [annualKwh, setAnnualKwh] = useState(0)
  const [structureWarning, setStructureWarning] = useState(false)

  // Theoretical shadow spacing (동지 기준 이론값)
  const tiltRad = (tiltAngle * Math.PI) / 180
  const winterAltRad = (WINTER_SUN_ALT_DEG * Math.PI) / 180
  const theoreticalSpacing =
    Math.round(
      MODULES[moduleIndex].h * Math.cos(tiltRad) * (1 / Math.tan(winterAltRad)) * 100
    ) / 100

  const calcPolygonArea = useCallback((pts: Point[]): number => {
    if (pts.length < 3) return 0
    let a = 0
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length
      a += pts[i].x * pts[j].y
      a -= pts[j].x * pts[i].y
    }
    return Math.abs(a / 2) * SCALE * SCALE
  }, [])

  /** Place panels on a grid inside the polygon using point-in-polygon test */
  const calcPanelsFromPolygon = useCallback(
    (pts: Point[], areaSqm: number) => {
      if (pts.length < 3) return

      const module = MODULES[moduleIndex]
      const isBuilding = installType === '건물지붕형'
      const coverFactor = isBuilding ? 0.70 : 0.85

      // Slope terrain correction: effective area = area * cos(arctan(slope/100))
      const slopeRad = Math.atan(slopePercent / 100)
      const slopeFactor = Math.cos(slopeRad)
      const _effectiveArea = areaSqm * coverFactor * slopeFactor // used for load limit reference

      const localTiltRad = (tiltAngle * Math.PI) / 180

      // Panel pixel dimensions
      const panelPxW = module.w / SCALE
      const panelPxH = (module.h * Math.cos(localTiltRad)) / SCALE

      // Row pitch = projected panel height + selected spacing gap
      const spacingPx = spacingValue / SCALE
      const rowPitch = panelPxH + spacingPx

      // Polygon bounding box
      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))

      const margin = 4 // px inset from bounding box edges
      const rects: PanelRect[] = []

      for (let y = minY + margin; y + panelPxH <= maxY - margin; y += rowPitch) {
        for (let x = minX + margin; x + panelPxW <= maxX - margin; x += panelPxW + 2) {
          // Check panel center is inside polygon
          const cx = x + panelPxW / 2
          const cy = y + panelPxH / 2
          if (isPointInPolygon(cx, cy, pts)) {
            rects.push({ x, y, w: panelPxW, h: panelPxH })
          }
        }
      }

      // Apply structural load limit (building type)
      let finalRects = rects
      let warning = false
      if (isBuilding) {
        const limit = LOAD_LIMITS[structureType]
        if (limit !== null) {
          const maxPanels = Math.floor((areaSqm * limit) / 25) // 25 kg per panel
          if (rects.length > maxPanels) finalRects = rects.slice(0, maxPanels)
          warning = structureType === '샌드위치 패널'
        }
      }
      setStructureWarning(warning)

      const count = finalRects.length
      const capacity = (count * module.watt) / 1000
      const annual = capacity * GENERATION_HOURS * 365

      setPanelRects(finalRects)
      setPanelCount(count)
      setCapacityKwp(Math.round(capacity * 100) / 100)
      setAnnualKwh(Math.round(annual))
    },
    [moduleIndex, installType, tiltAngle, spacingValue, slopePercent, structureType]
  )

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 0.5
    for (let x = 0; x < W; x += 20) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    }
    for (let y = 0; y < H; y += 20) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }

    // Empty state
    if (points.length === 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('캔버스를 클릭하여 부지 경계를 그려주세요', W / 2, H / 2 - 12)
      ctx.fillText('더블클릭으로 완료', W / 2, H / 2 + 12)
      ctx.fillStyle = '#cbd5e1'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('축척: 1px = 0.1m  (800px = 80m)', 8, H - 8)
      return
    }

    // Polygon fill & stroke
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    if (isComplete) ctx.closePath()
    ctx.fillStyle = 'rgba(59, 130, 246, 0.07)'
    ctx.fill()
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.stroke()

    // Panel rectangles (only those that passed point-in-polygon)
    panelRects.forEach((rect, i) => {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.65)'
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = '#1d4ed8'
      ctx.lineWidth = 0.5
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      // Panel number label for small sets
      if (panelRects.length <= 60) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.font = `bold ${rect.w < 12 ? 6 : 8}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(String(i + 1), rect.x + rect.w / 2, rect.y + rect.h / 2 + 3)
      }
    })

    // Row spacing indicator (dashed red line after first panel row)
    if (panelRects.length > 0) {
      const r0 = panelRects[0]
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(r0.x, r0.y + r0.h)
      ctx.lineTo(r0.x + r0.w * 2, r0.y + r0.h)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ef4444'
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`이격 ${spacingValue}m`, r0.x + r0.w * 2 + 3, r0.y + r0.h + 4)
    }

    // Vertex dots
    points.forEach((p, i) => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, i === 0 ? 5 : 4, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#ef4444' : '#3b82f6'
      ctx.fill()
    })

    // Centroid label
    if (isComplete && area > 0) {
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length
      const cy = points.reduce((s, p) => s + p.y, 0) / points.length
      const label = `부지 ${area.toFixed(1)}m²  ·  ${panelCount}장`
      ctx.font = 'bold 12px sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      ctx.fillRect(cx - tw / 2 - 6, cy - 11, tw + 12, 21)
      ctx.strokeStyle = '#cbd5e1'
      ctx.lineWidth = 1
      ctx.strokeRect(cx - tw / 2 - 6, cy - 11, tw + 12, 21)
      ctx.fillStyle = '#1e293b'
      ctx.textAlign = 'center'
      ctx.fillText(label, cx, cy + 4)
    }

    // Scale indicator
    ctx.fillStyle = '#94a3b8'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('축척: 1px = 0.1m  (800px = 80m)', 8, H - 8)
  }, [points, isComplete, area, panelRects, spacingValue, panelCount])

  // Redraw on any relevant change
  useEffect(() => { drawCanvas() }, [drawCanvas])

  // Recalculate panels when polygon is complete or params change
  useEffect(() => {
    if (isComplete && points.length >= 3) {
      const a = calcPolygonArea(points)
      setArea(a)
      calcPanelsFromPolygon(points, a)
    }
  }, [
    isComplete, points,
    calcPolygonArea, calcPanelsFromPolygon,
  ])

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawMode) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY
    setPoints(prev => [...prev, { x, y }])
  }

  const handleCanvasDblClick = () => {
    if (points.length >= 3) {
      setIsComplete(true)
      setDrawMode(false)
    }
  }

  const handleStartDraw = () => {
    setPoints([])
    setArea(0)
    setPanelRects([])
    setPanelCount(0)
    setCapacityKwp(0)
    setAnnualKwh(0)
    setIsComplete(false)
    setDrawMode(true)
  }

  const handleReset = () => {
    setPoints([])
    setArea(0)
    setPanelRects([])
    setPanelCount(0)
    setCapacityKwp(0)
    setAnnualKwh(0)
    setIsComplete(false)
    setDrawMode(false)
  }

  const handleSendToRevenue = () => {
    setMapResult({ panelCount, capacityKwp, annualKwh, area, address, tiltAngle, moduleIndex })
    setActiveTab('revenue')
  }

  const handleSavePNG = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `solar-layout-${address || 'site'}.png`
    link.href = canvas.toDataURL()
    link.click()
  }

  const handleSavePDF = async () => {
    const { jsPDF } = await import('jspdf')
    const canvas = canvasRef.current
    if (!canvas) return
    const pdf = new jsPDF('p', 'mm', 'a4')
    const imgData = canvas.toDataURL('image/png')
    pdf.setFontSize(16)
    pdf.text('태양광 패널 배치도', 20, 18)
    pdf.setFontSize(10)
    const lines = [
      `지번: ${address || '-'}`,
      `부지면적: ${area.toFixed(2)} m²`,
      `설치유형: ${installType}`,
      `모듈: ${MODULES[moduleIndex].name} (${MODULES[moduleIndex].watt}W)`,
      `경사각: ${tiltAngle}°  경사도: ${slopePercent}%  이격거리: ${spacingValue}m`,
      `패널수: ${panelCount}장`,
      `설비용량: ${capacityKwp} kWp`,
      `연간발전량: ${annualKwh.toLocaleString()} kWh`,
    ]
    lines.forEach((l, i) => pdf.text(l, 20, 28 + i * 7))
    const imgW = 170
    const imgH = (canvas.height / canvas.width) * imgW
    pdf.addImage(imgData, 'PNG', 20, 28 + lines.length * 7 + 4, imgW, imgH)
    pdf.save(`solar-layout-${address || 'site'}.pdf`)
  }

  const step1Done = address.trim().length > 0
  const step2Done = installType !== ''
  const step4Done = isComplete && area > 0
  const step5Done = panelCount > 0

  const stepStyle = (done: boolean, active?: boolean) =>
    `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
      done ? 'bg-green-500 text-white' : active ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'
    }`

  const cardStyle = (done: boolean, active?: boolean) =>
    `bg-white rounded-xl border-2 p-4 transition-colors ${
      done ? 'border-green-300' : active ? 'border-blue-400' : 'border-gray-200'
    }`

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* Left: 5-step analysis panel */}
      <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 space-y-3">

        {/* STEP 1 */}
        <div className={cardStyle(step1Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepStyle(step1Done)}>{step1Done ? '✓' : '1'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">지번 / 주소 입력</h3>
          </div>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="경기도 화성시 우정읍 000-0"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* STEP 2 */}
        <div className={cardStyle(step2Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepStyle(step2Done)}>{step2Done ? '✓' : '2'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">설치 유형 선택</h3>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {INSTALL_TYPES.map(t => (
              <button
                key={t}
                onClick={() => setInstallType(t)}
                className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  installType === t
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {installType === '건물지붕형' && (
            <div className="mt-3 space-y-2">
              <select
                value={structureType}
                onChange={e => setStructureType(e.target.value as StructureType)}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {STRUCTURE_TYPES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {structureWarning && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-2 flex items-center gap-1.5">
                  <span className="text-yellow-600 text-xs">⚠</span>
                  <span className="text-xs text-yellow-700 font-medium">구조안전확인서 필요</span>
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bipvEnabled}
                  onChange={e => setBipvEnabled(e.target.checked)}
                  className="accent-blue-500"
                />
                <span className="text-xs text-gray-700">BIPV 적용 (REC 가중치 1.5)</span>
              </label>
            </div>
          )}
        </div>

        {/* STEP 3 */}
        <div className={cardStyle(true)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepStyle(true)}>✓</div>
            <h3 className="font-semibold text-gray-800 text-sm">모듈 · 각도 설정</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 font-medium">모듈 선택</label>
              <select
                value={moduleIndex}
                onChange={e => setModuleIndex(Number(e.target.value))}
                className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {MODULES.map((m, i) => (
                  <option key={i} value={i}>{m.name} ({m.watt}W)</option>
                ))}
              </select>
              <div className="mt-1 text-xs text-gray-400">
                {MODULES[moduleIndex].w}m × {MODULES[moduleIndex].h}m
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-500 font-medium">경사각 (설치각도)</label>
                <span className="text-sm font-bold text-blue-600">{tiltAngle}°</span>
              </div>
              <input
                type="range" min={0} max={60} value={tiltAngle}
                onChange={e => setTiltAngle(Number(e.target.value))}
                className="mt-1 w-full"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>0°</span><span>서울최적 33°</span><span>60°</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 font-medium">이격 거리</label>
              <div className="flex gap-1.5 mt-1">
                {SPACING_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSpacingValue(opt.value)}
                    className={`flex-1 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      spacingValue === opt.value
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-xs text-gray-400">
                이론값 (동지 기준): <span className="font-medium text-gray-600">{theoreticalSpacing}m</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-500 font-medium">경사도 (지형 기울기)</label>
                <span className="text-sm font-bold text-orange-600">{slopePercent}%</span>
              </div>
              <input
                type="range" min={0} max={50} value={slopePercent}
                onChange={e => setSlopePercent(Number(e.target.value))}
                className="mt-1 w-full"
              />
              {slopePercent > 0 ? (
                <div className="mt-1 text-xs text-orange-600">
                  면적 보정계수: ×{(Math.cos(Math.atan(slopePercent / 100)) * 100).toFixed(1)}%
                </div>
              ) : (
                <div className="mt-1 text-xs text-gray-400">평지 (0% = 보정 없음)</div>
              )}
            </div>
          </div>
        </div>

        {/* STEP 4 */}
        <div className={cardStyle(step4Done, drawMode)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepStyle(step4Done, drawMode)}>{step4Done ? '✓' : '4'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">부지 경계 그리기</h3>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStartDraw}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                drawMode
                  ? 'bg-red-50 border-red-400 text-red-600'
                  : 'bg-blue-500 text-white border-blue-500 hover:bg-blue-600'
              }`}
            >
              {drawMode ? '✕ 취소' : '✏ 그리기 시작'}
            </button>
            {(points.length > 0 || isComplete) && (
              <button
                onClick={handleReset}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                초기화
              </button>
            )}
          </div>
          {drawMode && (
            <div className="mt-2 bg-blue-50 rounded-lg p-2 text-xs text-blue-700">
              클릭으로 꼭짓점 추가 · <strong>더블클릭</strong>으로 완료
              {points.length > 0 && (
                <span className="ml-1 text-blue-500">({points.length}점 찍힘)</span>
              )}
            </div>
          )}
        </div>

        {/* STEP 5: Results */}
        {step5Done && (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border-2 border-blue-300 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-blue-500 text-white">
                5
              </div>
              <h3 className="font-semibold text-blue-800 text-sm">분석 결과</h3>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-gray-600">부지 면적</span>
                <span className="font-bold text-gray-700 text-sm">{area.toFixed(1)} m²</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-600">패널 수량</span>
                <span className="font-bold text-blue-700 text-sm">{panelCount.toLocaleString()}장</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-600">설비 용량</span>
                <span className="font-bold text-blue-700 text-sm">{capacityKwp} kWp</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-600">연간 발전량</span>
                <span className="font-bold text-blue-700 text-sm">{annualKwh.toLocaleString()} kWh</span>
              </div>
              <div className="border-t border-blue-200 pt-2 text-xs text-gray-500">
                커버율 {installType === '건물지붕형' ? '70%' : '85%'}
                {slopePercent > 0
                  ? ` × cos(arctan(${slopePercent}%)) = ×${(Math.cos(Math.atan(slopePercent / 100)) * (installType === '건물지붕형' ? 70 : 85)).toFixed(1)}%`
                  : ''}
              </div>
            </div>
            <button
              onClick={handleSendToRevenue}
              className="mt-3 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              수익성 시뮬레이터로 연동 →
            </button>
          </div>
        )}

        {/* Reference benchmark box */}
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-3">
          <div className="text-xs font-semibold text-amber-800 mb-1">📌 실제 현장 기준값</div>
          <div className="space-y-0.5 text-xs text-amber-700">
            <div>TOPCon GS710W · 경사각 15° · 이격 1.2m</div>
            <div className="font-bold">524.85 m² → 38장 · 26.98 kWp</div>
          </div>
        </div>
      </div>

      {/* Right: Canvas */}
      <div className="flex-1 min-w-0">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <span>🗺️</span> 패널 배치도 자동 생성 엔진
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={handleSavePNG}
                disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                PNG 저장
              </button>
              <button
                onClick={handleSavePDF}
                disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-white border-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                PDF 출력
              </button>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={800}
            height={500}
            onClick={handleCanvasClick}
            onDoubleClick={handleCanvasDblClick}
            className={`w-full h-auto border border-gray-200 rounded-lg bg-gray-50 ${
              drawMode ? 'cursor-crosshair' : 'cursor-default'
            }`}
            style={{ maxHeight: '500px' }}
          />

          {isComplete && area > 0 && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-gray-50 rounded-lg p-2 text-center">
                <div className="text-xs text-gray-500">부지면적</div>
                <div className="font-bold text-gray-800 text-sm">{area.toFixed(1)} m²</div>
              </div>
              <div className="bg-blue-50 rounded-lg p-2 text-center">
                <div className="text-xs text-gray-500">패널수</div>
                <div className="font-bold text-blue-700 text-sm">{panelCount}장</div>
              </div>
              <div className="bg-green-50 rounded-lg p-2 text-center">
                <div className="text-xs text-gray-500">설비용량</div>
                <div className="font-bold text-green-700 text-sm">{capacityKwp} kWp</div>
              </div>
              <div className="bg-orange-50 rounded-lg p-2 text-center">
                <div className="text-xs text-gray-500">연간발전량</div>
                <div className="font-bold text-orange-700 text-sm">
                  {(annualKwh / 1000).toFixed(1)} MWh
                </div>
              </div>
            </div>
          )}
        </div>

        {/* VWorld map placeholder */}
        <div className="mt-4 bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
            <span>🛰️</span> 위성지도 (VWorld API)
          </h3>
          <div className="bg-gradient-to-br from-green-100 to-blue-100 rounded-lg h-40 flex items-center justify-center border border-dashed border-gray-300">
            <div className="text-center text-gray-500">
              <div className="text-3xl mb-2">🗺️</div>
              <div className="text-sm font-medium">VWorld API 키 설정 후 위성지도 표시</div>
              <div className="text-xs mt-1">.env.local에 VWORLD_API_KEY 설정 필요</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
