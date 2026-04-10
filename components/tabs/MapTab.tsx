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

const CANVAS_W = 800
const CANVAS_H = 500

interface Point { x: number; y: number }
interface PanelRect { x: number; y: number; w: number; h: number }

// ──────────────────────────────────────────────────────────────────
// Geographic helper functions (pure, outside component)
// ──────────────────────────────────────────────────────────────────

/** Meters per degree of longitude/latitude at a given latitude */
function mpdLon(lat: number) { return 111319.9 * Math.cos((lat * Math.PI) / 180) }
const mpdLat = 111319.9

/** Convert geographic coordinate to canvas pixel */
function geoToCanvas(
  lon: number, lat: number,
  centerLon: number, centerLat: number,
  scale: number // m/px
): Point {
  return {
    x: CANVAS_W / 2 + ((lon - centerLon) * mpdLon(centerLat)) / scale,
    y: CANVAS_H / 2 - ((lat - centerLat) * mpdLat) / scale,
  }
}

/** Find optimal display scale (m/px) to fit polygon in ~76% of canvas */
function computeDisplayScale(
  coords: number[][],
  centerLon: number,
  centerLat: number
): number {
  const dxArr = coords.map(c => Math.abs((c[0] - centerLon) * mpdLon(centerLat)))
  const dyArr = coords.map(c => Math.abs((c[1] - centerLat) * mpdLat))
  const maxDx = Math.max(...dxArr)
  const maxDy = Math.max(...dyArr)
  const sx = maxDx > 0 ? maxDx / (CANVAS_W * 0.38) : 0.1
  const sy = maxDy > 0 ? maxDy / (CANVAS_H * 0.38) : 0.1
  return Math.max(sx, sy, 0.01) // at least 0.01 m/px
}

/** Area in m² from geographic ring using Shoelace + local projection */
function geoRingAreaSqm(coords: number[][]): number {
  const cLon = coords.reduce((s, c) => s + c[0], 0) / coords.length
  const cLat = coords.reduce((s, c) => s + c[1], 0) / coords.length
  const pts = coords.map(c => ({
    x: (c[0] - cLon) * mpdLon(cLat),
    y: (c[1] - cLat) * mpdLat,
  }))
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a / 2)
}

// ──────────────────────────────────────────────────────────────────
// Ray-casting point-in-polygon
// ──────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────
export default function MapTab() {
  const { setMapResult, setActiveTab, setKierPvHours, setKierGhi, setLocationCoords } = useSolarStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // ── Input state ──
  const [address, setAddress] = useState('')
  const [installType, setInstallType] = useState<string>('건물지붕형')
  const [moduleIndex, setModuleIndex] = useState(0)
  const [tiltAngle, setTiltAngle] = useState(33)
  const [spacingValue, setSpacingValue] = useState(1.2)
  const [slopePercent, setSlopePercent] = useState(0)
  const [structureType, setStructureType] = useState<StructureType>('철골구조')
  const [bipvEnabled, setBipvEnabled] = useState(false)

  // ── Drawing state ──
  const [drawMode, setDrawMode] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const [isComplete, setIsComplete] = useState(false)
  const [area, setArea] = useState(0)

  // ── Scale: m per pixel (changes when API returns parcel data) ──
  const [pixelScale, setPixelScale] = useState(0.1)

  // ── API state ──
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [parcelLabel, setParcelLabel] = useState('')
  const [apiSource, setApiSource] = useState<'none' | 'api' | 'manual'>('none')

  // 마지막 검색 좌표 (tiltAngle 변경 시 KIER 재조회용)
  const [apiCoords, setApiCoords] = useState<{ lat: number; lon: number } | null>(null)

  // KIER 실측 일사량 결과
  const [kierLoading, setKierLoading] = useState(false)
  const [kierResult, setKierResult] = useState<{
    ghi: number        // 수평면 전일사량 kWh/m²/년
    pvPot: number      // 경사면 발전량 kWh/kW/년
    pvHours: number    // pvPot / 365 = 일일 발전시간
  } | null>(null)

  // ── Result state ──
  const [panelRects, setPanelRects] = useState<PanelRect[]>([])
  const [panelCount, setPanelCount] = useState(0)
  const [capacityKwp, setCapacityKwp] = useState(0)
  const [annualKwh, setAnnualKwh] = useState(0)
  const [structureWarning, setStructureWarning] = useState(false)

  // Theoretical shadow spacing (reference only)
  const tiltRad = (tiltAngle * Math.PI) / 180
  const winterAltRad = ((90 - 37.5665 - 23.45) * Math.PI) / 180
  const theoreticalSpacing =
    Math.round(MODULES[moduleIndex].h * Math.cos(tiltRad) * (1 / Math.tan(winterAltRad)) * 100) / 100

  // ── Area from polygon in pixel coords ──
  const calcPolygonArea = useCallback(
    (pts: Point[], scale: number): number => {
      if (pts.length < 3) return 0
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
      }
      return Math.abs(a / 2) * scale * scale
    },
    []
  )

  // ── Panel placement (point-in-polygon grid) ──
  const calcPanelsFromPolygon = useCallback(
    (pts: Point[], areaSqm: number, scale: number) => {
      if (pts.length < 3) return

      const module = MODULES[moduleIndex]
      const isBuilding = installType === '건물지붕형'
      const coverFactor = isBuilding ? 0.70 : 0.85
      const slopeFactor = Math.cos(Math.atan(slopePercent / 100))

      const localTiltRad = (tiltAngle * Math.PI) / 180
      const panelPxW = module.w / scale
      const panelPxH = (module.h * Math.cos(localTiltRad)) / scale
      const spacingPx = spacingValue / scale
      const rowPitch = panelPxH + spacingPx

      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))

      const margin = 4
      const rects: PanelRect[] = []

      for (let y = minY + margin; y + panelPxH <= maxY - margin; y += rowPitch) {
        for (let x = minX + margin; x + panelPxW <= maxX - margin; x += panelPxW + 2) {
          if (isPointInPolygon(x + panelPxW / 2, y + panelPxH / 2, pts)) {
            rects.push({ x, y, w: panelPxW, h: panelPxH })
          }
        }
      }

      // Structural load limit
      let finalRects = rects
      let warning = false
      if (isBuilding) {
        const limit = LOAD_LIMITS[structureType]
        if (limit !== null) {
          const maxPanels = Math.floor((areaSqm * slopeFactor * limit) / 25)
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

  // ── Canvas draw ──
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

    // Grid
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 0.5
    for (let x = 0; x < CANVAS_W; x += 20) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
    }
    for (let y = 0; y < CANVAS_H; y += 20) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke()
    }

    if (points.length === 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('주소를 검색하거나 직접 부지 경계를 그려주세요', CANVAS_W / 2, CANVAS_H / 2 - 12)
      ctx.fillText('(더블클릭으로 완료)', CANVAS_W / 2, CANVAS_H / 2 + 12)
      ctx.fillStyle = '#cbd5e1'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`축척: 1px = ${pixelScale.toFixed(2)}m`, 8, CANVAS_H - 8)
      return
    }

    // Polygon
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    if (isComplete) ctx.closePath()
    ctx.fillStyle =
      apiSource === 'api'
        ? 'rgba(16, 185, 129, 0.08)'
        : 'rgba(59, 130, 246, 0.08)'
    ctx.fill()
    ctx.strokeStyle = apiSource === 'api' ? '#10b981' : '#3b82f6'
    ctx.lineWidth = 2
    ctx.stroke()

    // Panels
    panelRects.forEach((rect, i) => {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.65)'
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = '#1d4ed8'
      ctx.lineWidth = 0.5
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      if (panelRects.length <= 60) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.font = `bold ${rect.w < 12 ? 6 : 8}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(String(i + 1), rect.x + rect.w / 2, rect.y + rect.h / 2 + 3)
      }
    })

    // Row spacing indicator
    if (panelRects.length > 0) {
      const r0 = panelRects[0]
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(r0.x, r0.y + r0.h)
      ctx.lineTo(r0.x + r0.w * 2.5, r0.y + r0.h)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ef4444'
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`이격 ${spacingValue}m`, r0.x + r0.w * 2.5 + 3, r0.y + r0.h + 4)
    }

    // Vertex dots
    points.forEach((p, i) => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, i === 0 ? 5 : 4, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#ef4444' : (apiSource === 'api' ? '#10b981' : '#3b82f6')
      ctx.fill()
    })

    // Centroid label
    if (isComplete && area > 0) {
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length
      const cy = points.reduce((s, p) => s + p.y, 0) / points.length
      const label = `${area.toFixed(1)}m²  ·  ${panelCount}장`
      ctx.font = 'bold 12px sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fillRect(cx - tw / 2 - 6, cy - 12, tw + 12, 22)
      ctx.strokeStyle = '#cbd5e1'
      ctx.lineWidth = 1
      ctx.strokeRect(cx - tw / 2 - 6, cy - 12, tw + 12, 22)
      ctx.fillStyle = '#1e293b'
      ctx.textAlign = 'center'
      ctx.fillText(label, cx, cy + 4)
    }

    // Scale indicator
    ctx.fillStyle = '#94a3b8'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    const scaleLabel =
      pixelScale < 0.5
        ? `축척: 1px = ${pixelScale.toFixed(2)}m  (800px ≈ ${Math.round(800 * pixelScale)}m)`
        : `축척: 1px = ${pixelScale.toFixed(1)}m  (800px ≈ ${Math.round(800 * pixelScale)}m)`
    ctx.fillText(scaleLabel, 8, CANVAS_H - 8)

    // API source badge
    if (apiSource === 'api') {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.9)'
      ctx.fillRect(CANVAS_W - 120, 8, 112, 20)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('🛰 VWorld 필지 자동 경계', CANVAS_W - 64, 21)
    }
  }, [points, isComplete, area, panelRects, spacingValue, panelCount, pixelScale, apiSource])

  useEffect(() => { drawCanvas() }, [drawCanvas])

  // tiltAngle 변경 시 KIER PV 재조회 (위치가 있을 때만)
  useEffect(() => {
    if (apiSource !== 'api' || !apiCoords) return
    fetchKierData(apiCoords.lat, apiCoords.lon, tiltAngle)
  // fetchKierData는 안정적인 callback이므로 deps에 포함
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiltAngle])

  // Recalculate panels when polygon or params change
  useEffect(() => {
    if (!isComplete || points.length < 3) return
    const a = area > 0 ? area : calcPolygonArea(points, pixelScale)
    if (area === 0) setArea(a)
    calcPanelsFromPolygon(points, a, pixelScale)
  }, [
    isComplete, points, pixelScale,
    calcPolygonArea, calcPanelsFromPolygon,
    // Re-run when params change even if polygon hasn't changed:
    moduleIndex, tiltAngle, spacingValue, slopePercent, installType, structureType,
  ])

  // ── VWorld API address search ──
  const handleAddressSearch = async () => {
    const q = address.trim()
    if (!q) return
    setSearchLoading(true)
    setSearchError('')
    setParcelLabel('')

    try {
      // Step 1: address → lon/lat
      const coordRes = await fetch(`/api/vworld?type=coord&address=${encodeURIComponent(q)}`)
      const coordData = await coordRes.json()

      if (coordRes.status === 503) {
        setSearchError(
          'VWorld API 키가 설정되지 않았습니다.\n.env.local 파일에 VWORLD_API_KEY를 입력하세요.\n(아래 수동 그리기로 대신 사용 가능)'
        )
        return
      }

      const point = coordData?.response?.result?.point
      if (!point) {
        setSearchError('주소를 찾을 수 없습니다. 지번 주소로 다시 입력해보세요.')
        return
      }
      const lon = parseFloat(point.x)
      const lat = parseFloat(point.y)

      // Step 2: lon/lat → parcel boundary polygon
      const parcelRes = await fetch(`/api/vworld?type=parcel&lon=${lon}&lat=${lat}`)
      const parcelData = await parcelRes.json()

      const features =
        parcelData?.response?.result?.featureCollection?.features
      if (!features || features.length === 0) {
        setSearchError('해당 위치의 필지 경계를 찾을 수 없습니다.')
        return
      }

      const geometry = features[0].geometry
      let rawCoords: number[][] = []
      if (geometry.type === 'Polygon') {
        rawCoords = geometry.coordinates[0]
      } else if (geometry.type === 'MultiPolygon') {
        rawCoords = geometry.coordinates[0][0]
      }

      if (rawCoords.length < 3) {
        setSearchError('유효하지 않은 필지 경계입니다.')
        return
      }

      // Remove duplicate closing point
      const ring =
        rawCoords[0][0] === rawCoords[rawCoords.length - 1][0] &&
        rawCoords[0][1] === rawCoords[rawCoords.length - 1][1]
          ? rawCoords.slice(0, -1)
          : rawCoords

      // Center of polygon
      const centerLon = ring.reduce((s, c) => s + c[0], 0) / ring.length
      const centerLat = ring.reduce((s, c) => s + c[1], 0) / ring.length

      // Optimal display scale (m/px)
      const scale = computeDisplayScale(ring, centerLon, centerLat)

      // Convert to canvas pixels
      const canvasPoints = ring.map(c =>
        geoToCanvas(c[0], c[1], centerLon, centerLat, scale)
      )

      // Area from geographic coordinates (accurate)
      const areaSqm = geoRingAreaSqm(ring)

      // Parcel label from attributes
      const attrs = features[0].properties ?? {}
      const label = [attrs.EMD_NM, attrs.RI_NM, attrs.JIBUN]
        .filter(Boolean)
        .join(' ')
      setParcelLabel(label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`)

      // Update all state (React 18 batches these)
      setPixelScale(scale)
      setPoints(canvasPoints)
      setArea(areaSqm)
      setIsComplete(true)
      setDrawMode(false)
      setApiSource('api')
      setLocationCoords({ lat, lon })
      setApiCoords({ lat, lon })

      // Trigger panel calculation immediately
      calcPanelsFromPolygon(canvasPoints, areaSqm, scale)

      // KIER 일사량 데이터 조회 (백그라운드)
      fetchKierData(lat, lon, tiltAngle)
    } catch {
      setSearchError('API 요청 중 오류가 발생했습니다.')
    } finally {
      setSearchLoading(false)
    }
  }

  // ── KIER 일사량 API 호출 ──
  const fetchKierData = useCallback(async (lat: number, lon: number, tilt: number) => {
    setKierLoading(true)
    try {
      const [ghiRes, pvRes] = await Promise.all([
        fetch(`/api/kier?service=ghi&lat=${lat}&lon=${lon}`),
        fetch(`/api/kier?service=pv&lat=${lat}&lon=${lon}&tilt=${tilt}&azimuth=0`),
      ])

      if (!ghiRes.ok || !pvRes.ok) return

      const [ghiData, pvData] = await Promise.all([ghiRes.json(), pvRes.json()])

      // KIER API 응답 파싱 (data.go.kr 표준 형식)
      const ghiItem = ghiData?.response?.body?.items?.item
      const pvItem  = pvData?.response?.body?.items?.item

      const ghi   = parseFloat(ghiItem?.ghi   ?? ghiItem?.annGhi  ?? 0)
      const pvPot = parseFloat(pvItem?.pvPot   ?? pvItem?.annPvPot ?? 0)

      if (ghi > 0 && pvPot > 0) {
        const pvHours = Math.round((pvPot / 365) * 100) / 100
        setKierResult({ ghi, pvPot, pvHours })
        setKierPvHours(pvHours)
        setKierGhi(ghi)
      }
    } catch {
      // KIER API 실패 시 기본값 유지
    } finally {
      setKierLoading(false)
    }
  }, [setKierPvHours, setKierGhi])

  // ── Manual canvas drawing ──
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawMode) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (CANVAS_W / rect.width)
    const y = (e.clientY - rect.top) * (CANVAS_H / rect.height)
    setPoints(prev => [...prev, { x, y }])
    setApiSource('manual')
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
    setApiSource('manual')
    setParcelLabel('')
    setSearchError('')
    setPixelScale(0.1) // reset to default scale
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
    setApiSource('none')
    setParcelLabel('')
    setSearchError('')
    setPixelScale(0.1)
    setKierResult(null)
    setApiCoords(null)
    setKierPvHours(null)
    setKierGhi(null)
    setLocationCoords(null)
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
      `지번: ${address || '-'}${parcelLabel ? '  (' + parcelLabel + ')' : ''}`,
      `부지면적: ${area.toFixed(2)} m²  (${apiSource === 'api' ? 'VWorld 자동' : '수동 측정'})`,
      `설치유형: ${installType}`,
      `모듈: ${MODULES[moduleIndex].name} (${MODULES[moduleIndex].watt}W)`,
      `경사각: ${tiltAngle}°  경사도: ${slopePercent}%  이격거리: ${spacingValue}m`,
      `패널수: ${panelCount}장`,
      `설비용량: ${capacityKwp} kWp`,
      `연간발전량: ${annualKwh.toLocaleString()} kWh`,
    ]
    lines.forEach((l, i) => pdf.text(l, 20, 28 + i * 7))
    const imgW = 170
    const imgH = (CANVAS_H / CANVAS_W) * imgW
    pdf.addImage(imgData, 'PNG', 20, 28 + lines.length * 7 + 4, imgW, imgH)
    pdf.save(`solar-layout-${address || 'site'}.pdf`)
  }

  // Step UI helpers
  const step1Done = address.trim().length > 0
  const step2Done = installType !== ''
  const step4Done = isComplete && area > 0
  const step5Done = panelCount > 0

  const stepCircle = (done: boolean, num: string | number, active?: boolean) =>
    `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
      done ? 'bg-green-500 text-white' : active ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'
    }`

  const stepCard = (done: boolean, active?: boolean) =>
    `bg-white rounded-xl border-2 p-4 transition-colors ${
      done ? 'border-green-300' : active ? 'border-blue-400' : 'border-gray-200'
    }`

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* ── Left: 5-step controls ── */}
      <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 space-y-3">

        {/* STEP 1 — 지번 검색 */}
        <div className={stepCard(step1Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(step1Done, '1')}>{step1Done ? '✓' : '1'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">지번 / 주소 입력</h3>
          </div>

          <div className="flex gap-1.5">
            <input
              type="text"
              value={address}
              onChange={e => { setAddress(e.target.value); setSearchError('') }}
              onKeyDown={e => e.key === 'Enter' && handleAddressSearch()}
              placeholder="경기도 화성시 우정읍 000-0"
              className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleAddressSearch}
              disabled={searchLoading || !address.trim()}
              className="flex-shrink-0 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors"
            >
              {searchLoading ? (
                <span className="inline-block animate-spin">⟳</span>
              ) : '검색'}
            </button>
          </div>

          {/* Loading */}
          {searchLoading && (
            <div className="mt-2 flex items-center gap-2 text-xs text-blue-600">
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              VWorld에서 필지 경계 조회 중...
            </div>
          )}

          {/* Error */}
          {searchError && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600 whitespace-pre-line">
              {searchError}
            </div>
          )}

          {/* Success — parcel info */}
          {parcelLabel && !searchError && (
            <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-2 text-xs text-green-700 flex items-center gap-1.5">
              <span>🛰</span>
              <span>{parcelLabel} — {area.toFixed(0)}m²</span>
            </div>
          )}
        </div>

        {/* STEP 2 — 설치 유형 */}
        <div className={stepCard(step2Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(step2Done, '2')}>{step2Done ? '✓' : '2'}</div>
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
                {STRUCTURE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {structureWarning && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-2 flex items-center gap-1.5">
                  <span className="text-yellow-600 text-xs">⚠</span>
                  <span className="text-xs text-yellow-700 font-medium">구조안전확인서 필요</span>
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={bipvEnabled} onChange={e => setBipvEnabled(e.target.checked)} className="accent-blue-500" />
                <span className="text-xs text-gray-700">BIPV 적용 (REC 가중치 1.5)</span>
              </label>
            </div>
          )}
        </div>

        {/* STEP 3 — 모듈/각도 */}
        <div className={stepCard(true)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(true, '✓')}>✓</div>
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
              <div className="flex justify-between">
                <label className="text-xs text-gray-500 font-medium">경사각</label>
                <span className="text-sm font-bold text-blue-600">{tiltAngle}°</span>
              </div>
              <input type="range" min={0} max={60} value={tiltAngle}
                onChange={e => setTiltAngle(Number(e.target.value))} className="mt-1 w-full" />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>0°</span><span>서울최적 33°</span><span>60°</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 font-medium">이격 거리</label>
              <div className="flex gap-1.5 mt-1">
                {SPACING_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setSpacingValue(opt.value)}
                    className={`flex-1 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      spacingValue === opt.value
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                    }`}
                  >{opt.label}</button>
                ))}
              </div>
              <div className="mt-1 text-xs text-gray-400">
                이론값 (동지기준): <span className="font-medium text-gray-600">{theoreticalSpacing}m</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between">
                <label className="text-xs text-gray-500 font-medium">경사도 (지형)</label>
                <span className="text-sm font-bold text-orange-600">{slopePercent}%</span>
              </div>
              <input type="range" min={0} max={50} value={slopePercent}
                onChange={e => setSlopePercent(Number(e.target.value))} className="mt-1 w-full" />
              {slopePercent > 0
                ? <div className="mt-1 text-xs text-orange-600">
                    면적 보정: ×{(Math.cos(Math.atan(slopePercent / 100)) * 100).toFixed(1)}%
                  </div>
                : <div className="mt-1 text-xs text-gray-400">평지 (보정 없음)</div>
              }
            </div>
          </div>
        </div>

        {/* STEP 4 — 수동 그리기 (API 없을 때) */}
        <div className={stepCard(step4Done, drawMode)}>
          <div className="flex items-center gap-2 mb-2">
            <div className={stepCircle(step4Done, '4', drawMode)}>{step4Done ? '✓' : '4'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">수동 부지 그리기</h3>
          </div>
          <p className="text-xs text-gray-400 mb-2">API 키 없을 때 직접 캔버스에 그릴 수 있습니다</p>
          <div className="flex gap-2">
            <button onClick={handleStartDraw}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                drawMode
                  ? 'bg-red-50 border-red-400 text-red-600'
                  : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
              }`}
            >
              {drawMode ? '✕ 취소' : '✏ 직접 그리기'}
            </button>
            {(points.length > 0 || isComplete) && (
              <button onClick={handleReset}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50">
                초기화
              </button>
            )}
          </div>
          {drawMode && (
            <div className="mt-2 bg-blue-50 rounded-lg p-2 text-xs text-blue-700">
              클릭으로 꼭짓점 추가 · <strong>더블클릭</strong>으로 완료
              {points.length > 0 && <span className="ml-1 text-blue-500">({points.length}점)</span>}
            </div>
          )}
        </div>

        {/* STEP 5 — 결과 */}
        {step5Done && (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border-2 border-blue-300 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-blue-500 text-white">5</div>
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
              <div className="text-xs text-gray-400 border-t border-blue-200 pt-2">
                커버율 {installType === '건물지붕형' ? '70%' : '85%'}
                {slopePercent > 0 ? ` × cos(arctan(${slopePercent}%))` : ''}
                {apiSource === 'api' ? '  ·  VWorld 경계' : '  ·  수동 측정'}
              </div>
            </div>
            <button onClick={handleSendToRevenue}
              className="mt-3 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold transition-colors">
              수익성 시뮬레이터로 연동 →
            </button>
          </div>
        )}

        {/* KIER 실측 일사량 카드 */}
        {(kierLoading || kierResult) && (
          <div className={`rounded-xl border-2 p-4 ${kierResult ? 'bg-emerald-50 border-emerald-300' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">☀️</span>
              <h3 className="font-semibold text-sm text-gray-800">KIER 실측 일사량</h3>
              {kierLoading && (
                <svg className="animate-spin h-3.5 w-3.5 text-emerald-500 ml-auto" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              )}
            </div>
            {kierResult && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">수평면 전일사량 (GHI)</span>
                  <span className="font-semibold text-gray-700">{kierResult.ghi.toFixed(0)} kWh/m²/년</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">경사면 발전량 ({tiltAngle}°)</span>
                  <span className="font-semibold text-gray-700">{kierResult.pvPot.toFixed(0)} kWh/kW/년</span>
                </div>
                <div className="flex justify-between text-xs border-t border-emerald-200 pt-1.5 mt-1.5">
                  <span className="text-gray-600 font-medium">실측 발전시간</span>
                  <span className="font-bold text-emerald-700">{kierResult.pvHours}h/일</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">기준값 대비</span>
                  <span className={`font-semibold ${kierResult.pvHours >= 3.5 ? 'text-emerald-600' : 'text-orange-500'}`}>
                    {kierResult.pvHours >= 3.5 ? '+' : ''}{((kierResult.pvHours - 3.5) / 3.5 * 100).toFixed(1)}%
                    {' '}(기준 3.5h)
                  </span>
                </div>
                <div className="mt-2 bg-emerald-100 rounded-lg px-2 py-1 text-xs text-emerald-700 text-center font-medium">
                  수익성 시뮬레이터에 실측값 자동 적용됩니다
                </div>
              </div>
            )}
            {kierLoading && !kierResult && (
              <div className="text-xs text-gray-400">한국에너지기술연구원 데이터 조회 중...</div>
            )}
          </div>
        )}

        {/* Reference benchmark */}
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-3">
          <div className="text-xs font-semibold text-amber-800 mb-1">📌 실제 현장 기준값</div>
          <div className="space-y-0.5 text-xs text-amber-700">
            <div>TOPCon GS710W · 경사각 15° · 이격 1.2m</div>
            <div className="font-bold">524.85 m² → 38장 · 26.98 kWp</div>
          </div>
        </div>
      </div>

      {/* ── Right: Canvas ── */}
      <div className="flex-1 min-w-0">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                <span>🗺️</span> 패널 배치도 자동 생성 엔진
              </h3>
              {apiSource === 'api' && parcelLabel && (
                <p className="text-xs text-green-600 mt-0.5">🛰 VWorld 필지 자동 경계 · {parcelLabel}</p>
              )}
              {apiSource === 'manual' && (
                <p className="text-xs text-gray-400 mt-0.5">✏ 수동 그리기 모드 · 축척 1px = {pixelScale}m</p>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={handleSavePNG} disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
                PNG 저장
              </button>
              <button onClick={handleSavePDF} disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed">
                PDF 출력
              </button>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
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
                <div className="font-bold text-orange-700 text-sm">{(annualKwh / 1000).toFixed(1)} MWh</div>
              </div>
            </div>
          )}
        </div>

        {/* VWorld map info */}
        <div className="mt-4 bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
            <span>🛰️</span> VWorld API 연동 안내
          </h3>
          <div className="bg-gradient-to-br from-green-50 to-blue-50 rounded-lg p-4 border border-dashed border-gray-300">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-gray-600">
              <div>
                <div className="font-semibold text-gray-700 mb-1">API 키 발급 방법</div>
                <ol className="space-y-1 list-decimal list-inside text-gray-500">
                  <li>vworld.kr 회원가입</li>
                  <li>개발자 센터 → API 키 신청</li>
                  <li>.env.local에 VWORLD_API_KEY 입력</li>
                  <li>지번 입력 후 검색 버튼 클릭</li>
                </ol>
              </div>
              <div>
                <div className="font-semibold text-gray-700 mb-1">자동 제공 데이터</div>
                <ul className="space-y-1 text-gray-500">
                  <li>✓ 실제 필지 경계 좌표 (LP_PA_CBND)</li>
                  <li>✓ 정확한 부지 면적 (m²)</li>
                  <li>✓ 지번 주소 확인</li>
                  <li>✓ 자동 축척 조정</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
