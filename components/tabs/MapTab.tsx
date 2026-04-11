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

const INSTALL_TYPES = ['건물지붕형', '일반토지형', '영농형농지', '임야형', '수상형'] as const

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
interface SatTile { img: HTMLImageElement; cx: number; cy: number; px: number }

// ── 지리좌표 헬퍼 (순수함수) ─────────────────────────────────────
function mpdLon(lat: number) { return 111319.9 * Math.cos((lat * Math.PI) / 180) }
const MPD_LAT = 111319.9

function geoToCanvas(lon: number, lat: number, cLon: number, cLat: number, scale: number): Point {
  return {
    x: CANVAS_W / 2 + ((lon - cLon) * mpdLon(cLat)) / scale,
    y: CANVAS_H / 2 - ((lat - cLat) * MPD_LAT) / scale,
  }
}

function geoRingAreaSqm(coords: number[][]): number {
  const cLon = coords.reduce((s, c) => s + c[0], 0) / coords.length
  const cLat = coords.reduce((s, c) => s + c[1], 0) / coords.length
  let a = 0
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length
    const xi = (coords[i][0] - cLon) * mpdLon(cLat)
    const yi = (coords[i][1] - cLat) * MPD_LAT
    const xj = (coords[j][0] - cLon) * mpdLon(cLat)
    const yj = (coords[j][1] - cLat) * MPD_LAT
    a += xi * yj - xj * yi
  }
  return Math.abs(a / 2)
}

// ── 타일 좌표계 (지도 축척 = CAD 축척 일치) ─────────────────────
function lonLatToTile(lon: number, lat: number, z: number) {
  const n = Math.pow(2, z)
  const tx = Math.floor((lon + 180) / 360 * n)
  const lr = lat * Math.PI / 180
  const ty = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n)
  return { tx, ty }
}

function tileOriginLonLat(tx: number, ty: number, z: number) {
  const n = Math.pow(2, z)
  const lon = tx / n * 360 - 180
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI
  return { lon, lat }
}

/** 타일 1픽셀 = 몇 m (위도·줌 의존) */
function tilePixelScaleM(lat: number, z: number): number {
  return 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, z))
}

/**
 * 기획서 요구사항: 지도 축척 = CAD 축척 정확 일치
 * 타일 네이티브 픽셀 스케일을 Canvas 디스플레이 스케일로 사용
 */
function computeZoomAndScale(ring: number[][], cLon: number, cLat: number): { z: number; scale: number } {
  const dxArr = ring.map(c => Math.abs((c[0] - cLon) * mpdLon(cLat)))
  const dyArr = ring.map(c => Math.abs((c[1] - cLat) * MPD_LAT))
  const maxExtent = Math.max(...dxArr, ...dyArr, 5) // 최소 5m

  // 폴리곤이 캔버스의 ~62%를 채우도록 타겟 픽셀 수 설정
  const targetPx = Math.min(CANVAS_W, CANVAS_H) * 0.62
  const targetScale = maxExtent / targetPx

  // 타일 픽셀 스케일과 일치하는 줌 레벨 역산
  const rawZ = Math.log2(40075016.686 * Math.cos(cLat * Math.PI / 180) / (256 * targetScale))
  const z = Math.max(15, Math.min(20, Math.round(rawZ)))
  const scale = tilePixelScaleM(cLat, z) // 실제 m/px — 지도·CAD 축척 일치
  return { z, scale }
}

// ── Ray-casting point-in-polygon ───────────────────────────────────
function isPointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

/** 건물 외곽선에서 남향 방위각 자동 계산 */
function calcAutoAzimuth(pts: Point[]): number {
  let maxLen = 0, azDeg = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const dx = pts[j].x - pts[i].x
    const dy = pts[i].y - pts[j].y // Canvas Y 반전
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > maxLen) {
      maxLen = len
      let a = Math.atan2(dx, dy) * 180 / Math.PI
      if (a < 0) a += 360
      azDeg = a
    }
  }
  const alt = (azDeg + 180) % 360
  const d1 = Math.min(Math.abs(azDeg - 180), 360 - Math.abs(azDeg - 180))
  const d2 = Math.min(Math.abs(alt - 180), 360 - Math.abs(alt - 180))
  const southFacing = d1 <= d2 ? azDeg : alt
  const offset = ((southFacing - 180 + 180) % 360) - 180
  return Math.round(offset)
}

// ── Component ──────────────────────────────────────────────────────
export default function MapTab() {
  const { setMapResult, setActiveTab, setKierPvHours, setKierGhi, setLocationCoords } = useSolarStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobUrlsRef = useRef<string[]>([]) // cleanup용

  // ── 입력 ──
  const [address, setAddress] = useState('')
  const [installType, setInstallType] = useState<string>('건물지붕형')
  const [moduleIndex, setModuleIndex] = useState(0)
  const [tiltAngle, setTiltAngle] = useState(33)
  const [spacingValue, setSpacingValue] = useState(1.2)
  const [slopePercent, setSlopePercent] = useState(0)
  const [slopeAuto, setSlopeAuto] = useState(false)  // 자동측정 여부
  const [slopeFetching, setSlopeFetching] = useState(false)
  const [structureType, setStructureType] = useState<StructureType>('철골구조')
  const [bipvEnabled, setBipvEnabled] = useState(false)

  // ── 드로잉 ──
  const [drawMode, setDrawMode] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const [isComplete, setIsComplete] = useState(false)
  const [area, setArea] = useState(0)
  const [pixelScale, setPixelScale] = useState(0.1) // m/px

  // ── 위성 오버레이 ──
  const [satTiles, setSatTiles] = useState<SatTile[]>([])
  const [satLoading, setSatLoading] = useState(false)
  const [satZoom, setSatZoom] = useState(0)

  // ── API 상태 ──
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [parcelLabel, setParcelLabel] = useState('')
  const [apiSource, setApiSource] = useState<'none' | 'api' | 'manual'>('none')
  const [apiCoords, setApiCoords] = useState<{ lat: number; lon: number } | null>(null)
  const [autoAzimuth, setAutoAzimuth] = useState<number | null>(null)

  // ── KIER ──
  const [kierLoading, setKierLoading] = useState(false)
  const [kierResult, setKierResult] = useState<{
    ghi: number; pvPot: number; pvHours: number
  } | null>(null)

  // ── 결과 ──
  const [panelRects, setPanelRects] = useState<PanelRect[]>([])
  const [panelCount, setPanelCount] = useState(0)
  const [capacityKwp, setCapacityKwp] = useState(0)
  const [annualKwh, setAnnualKwh] = useState(0)
  const [structureWarning, setStructureWarning] = useState(false)

  // 이론 이격 거리
  const tiltRad = (tiltAngle * Math.PI) / 180
  const winterAltRad = ((90 - 37.5665 - 23.45) * Math.PI) / 180
  const theoreticalSpacing =
    Math.round(MODULES[moduleIndex].h * Math.cos(tiltRad) * (1 / Math.tan(winterAltRad)) * 100) / 100

  // BIPV 계산
  const bipvCoverageRatio = 0.60
  const bipvSelfConsumptionRatio = 0.50

  // 컴포넌트 언마운트 시 Blob URL 해제
  useEffect(() => {
    return () => { blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u)) }
  }, [])

  // ── 패널 배치 (Point-in-Polygon 그리드) ──
  const calcPanelsFromPolygon = useCallback(
    (pts: Point[], areaSqm: number, scale: number) => {
      if (pts.length < 3) return
      const module = MODULES[moduleIndex]
      const isBuilding = installType === '건물지붕형'
      const slopeFactor = Math.cos(Math.atan(slopePercent / 100))
      const ltr = (tiltAngle * Math.PI) / 180
      const panelPxW = module.w / scale
      const panelPxH = (module.h * Math.cos(ltr)) / scale
      const rowPitch = panelPxH + spacingValue / scale
      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))
      const rects: PanelRect[] = []
      for (let y = minY + 4; y + panelPxH <= maxY - 4; y += rowPitch) {
        for (let x = minX + 4; x + panelPxW <= maxX - 4; x += panelPxW + 2) {
          if (isPointInPolygon(x + panelPxW / 2, y + panelPxH / 2, pts))
            rects.push({ x, y, w: panelPxW, h: panelPxH })
        }
      }
      let finalRects = rects
      let warn = false
      if (isBuilding) {
        const limit = LOAD_LIMITS[structureType]
        if (limit !== null) {
          const maxP = Math.floor((areaSqm * slopeFactor * limit) / 25)
          if (rects.length > maxP) finalRects = rects.slice(0, maxP)
          warn = structureType === '샌드위치 패널'
        }
      }
      setStructureWarning(warn)
      const count = finalRects.length
      const cap = (count * module.watt) / 1000
      const ann = cap * GENERATION_HOURS * 365
      setPanelRects(finalRects)
      setPanelCount(count)
      setCapacityKwp(Math.round(cap * 100) / 100)
      setAnnualKwh(Math.round(ann))
    },
    [moduleIndex, installType, tiltAngle, spacingValue, slopePercent, structureType]
  )

  // ── 위성 타일 로드 ──
  const loadSatelliteTiles = useCallback(async (
    cLon: number, cLat: number, z: number, scale: number
  ) => {
    setSatLoading(true)
    setSatTiles([])
    // 기존 Blob URL 해제
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []

    const { tx: ctX, ty: ctY } = lonLatToTile(cLon, cLat, z)
    // 타일 1개의 크기 (m) → Canvas 픽셀
    const tileMeter = tilePixelScaleM(cLat, z) * 256
    const tilePx = tileMeter / scale

    // 중심 주변 5×5 타일 범위
    const R = 2
    const jobs: Promise<SatTile | null>[] = []
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = ctX + dx, ty = ctY + dy
        jobs.push((async () => {
          try {
            const origin = tileOriginLonLat(tx, ty, z)
            const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
            const res = await fetch(`/api/vworld?type=tile&z=${z}&x=${tx}&y=${ty}`)
            if (!res.ok) return null
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            blobUrlsRef.current.push(url)
            return await new Promise<SatTile | null>(resolve => {
              const img = new Image()
              img.onload = () => resolve({ img, cx, cy, px: tilePx })
              img.onerror = () => resolve(null)
              img.src = url
            })
          } catch { return null }
        })())
      }
    }
    const results = (await Promise.all(jobs)).filter(Boolean) as SatTile[]
    setSatTiles(results)
    setSatLoading(false)
  }, [])

  // ── Canvas 렌더링 ──
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

    // ❶ 위성사진 배경
    if (satTiles.length > 0) {
      satTiles.forEach(t => ctx.drawImage(t.img, t.cx, t.cy, t.px, t.px))
      // 경량 그리드 오버레이
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 0.5
      for (let x = 0; x < CANVAS_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y < CANVAS_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke()
      }
    } else {
      // 기본 그리드 배경
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5
      for (let x = 0; x < CANVAS_W; x += 20) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y < CANVAS_H; y += 20) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke()
      }
    }

    if (points.length === 0) {
      ctx.fillStyle = satTiles.length > 0 ? 'rgba(255,255,255,0.85)' : '#94a3b8'
      ctx.font = '14px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText('주소를 검색하거나 직접 부지 경계를 그려주세요', CANVAS_W / 2, CANVAS_H / 2 - 12)
      ctx.fillText('(더블클릭으로 완료)', CANVAS_W / 2, CANVAS_H / 2 + 12)
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(`축척: 1px = ${pixelScale.toFixed(3)}m`, 8, CANVAS_H - 8)
      return
    }

    // ❷ 필지 경계 폴리곤
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
    if (isComplete) ctx.closePath()
    ctx.fillStyle = satTiles.length > 0
      ? 'rgba(59,130,246,0.15)'
      : (apiSource === 'api' ? 'rgba(16,185,129,0.08)' : 'rgba(59,130,246,0.08)')
    ctx.fill()
    ctx.strokeStyle = apiSource === 'api' ? '#10b981' : '#3b82f6'
    ctx.lineWidth = satTiles.length > 0 ? 2.5 : 2
    ctx.stroke()

    // ❸ 패널 그리드
    panelRects.forEach((rect, i) => {
      ctx.fillStyle = 'rgba(59,130,246,0.70)'
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 0.5
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      if (panelRects.length <= 60) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.font = `bold ${rect.w < 12 ? 6 : 8}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(String(i + 1), rect.x + rect.w / 2, rect.y + rect.h / 2 + 3)
      }
    })

    // ❹ 이격 거리 표시선
    if (panelRects.length > 0) {
      const r0 = panelRects[0]
      ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ctx.beginPath(); ctx.moveTo(r0.x, r0.y + r0.h); ctx.lineTo(r0.x + r0.w * 2.5, r0.y + r0.h); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ef4444'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(`이격 ${spacingValue}m`, r0.x + r0.w * 2.5 + 3, r0.y + r0.h + 4)
    }

    // ❺ 꼭짓점
    points.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 5 : 4, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#ef4444' : (apiSource === 'api' ? '#10b981' : '#3b82f6')
      ctx.fill()
    })

    // ❻ 중심 레이블
    if (isComplete && area > 0) {
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length
      const cy = points.reduce((s, p) => s + p.y, 0) / points.length
      const label = `${area.toFixed(1)}m²  ·  ${panelCount}장`
      ctx.font = 'bold 12px sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.fillRect(cx - tw / 2 - 6, cy - 12, tw + 12, 22)
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1
      ctx.strokeRect(cx - tw / 2 - 6, cy - 12, tw + 12, 22)
      ctx.fillStyle = '#1e293b'; ctx.textAlign = 'center'
      ctx.fillText(label, cx, cy + 4)
    }

    // ❼ 축척 표시 (지도 축척 = CAD 축척 일치 확인용)
    const scaleLabel = satZoom > 0
      ? `축척 Z${satZoom}: 1px = ${pixelScale.toFixed(3)}m  (지도=CAD 일치)`
      : `축척: 1px = ${pixelScale.toFixed(3)}m`
    ctx.fillStyle = satTiles.length > 0 ? 'rgba(255,255,255,0.9)' : '#94a3b8'
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'
    if (satTiles.length > 0) {
      const sw = ctx.measureText(scaleLabel).width
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(4, CANVAS_H - 20, sw + 8, 16)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
    }
    ctx.fillText(scaleLabel, 8, CANVAS_H - 8)

    // ❽ VWorld 배지
    if (apiSource === 'api') {
      ctx.fillStyle = satTiles.length > 0 ? 'rgba(16,185,129,0.85)' : 'rgba(16,185,129,0.9)'
      ctx.fillRect(CANVAS_W - 148, 8, 140, 20)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText('🛰 VWorld 필지 자동 경계', CANVAS_W - 78, 21)
    }
  }, [points, isComplete, area, panelRects, spacingValue, panelCount,
      pixelScale, apiSource, satTiles, satZoom])

  useEffect(() => { drawCanvas() }, [drawCanvas])

  // 파라미터 변경 시 패널 재계산
  useEffect(() => {
    if (!isComplete || points.length < 3) return
    calcPanelsFromPolygon(points, area, pixelScale)
  }, [isComplete, points, area, pixelScale,
      moduleIndex, tiltAngle, spacingValue, slopePercent, installType, structureType,
      calcPanelsFromPolygon])

  // KIER 실측 발전시간 도착 시 연간발전량(annualKwh) 갱신 (STEP 5 결과카드)
  useEffect(() => {
    if (capacityKwp === 0) return
    const genHours = kierResult?.pvHours ?? GENERATION_HOURS
    setAnnualKwh(Math.round(capacityKwp * genHours * 365))
  }, [capacityKwp, kierResult])

  // ── KIER API ──
  const fetchKierData = useCallback(async (lat: number, lon: number, tilt: number) => {
    setKierLoading(true)
    try {
      const [ghiRes, pvRes] = await Promise.all([
        fetch(`/api/kier?service=ghi&lat=${lat}&lon=${lon}`),
        fetch(`/api/kier?service=pv&lat=${lat}&lon=${lon}&tilt=${tilt}&azimuth=0`),
      ])
      if (!ghiRes.ok || !pvRes.ok) return
      const [ghiData, pvData] = await Promise.all([ghiRes.json(), pvRes.json()])
      const ghiItem = ghiData?.response?.body?.items?.item
      const pvItem = pvData?.response?.body?.items?.item
      const ghi = parseFloat(ghiItem?.ghi ?? ghiItem?.annGhi ?? 0)
      const pvPot = parseFloat(pvItem?.pvPot ?? pvItem?.annPvPot ?? 0)
      if (ghi > 0 && pvPot > 0) {
        const pvHours = Math.round((pvPot / 365) * 100) / 100
        setKierResult({ ghi, pvPot, pvHours })
        setKierPvHours(pvHours)
        setKierGhi(ghi)
      }
    } catch { /* silent fail */ } finally {
      setKierLoading(false)
    }
  }, [setKierPvHours, setKierGhi])

  // tiltAngle 변경 시 KIER 재조회
  useEffect(() => {
    if (apiSource !== 'api' || !apiCoords) return
    fetchKierData(apiCoords.lat, apiCoords.lon, tiltAngle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiltAngle])

  // ── VWorld DEM 경사도 자동 측정 ──
  const fetchSlope = useCallback(async (lon: number, lat: number) => {
    setSlopeFetching(true)
    try {
      const res = await fetch(`/api/vworld?type=elevation&lon=${lon}&lat=${lat}`)
      if (!res.ok) return
      const data = await res.json()
      if (data?.fallback || data?.error) return
      if (typeof data.slope === 'number') {
        setSlopePercent(Math.min(data.slope, 50))
        setSlopeAuto(true)
      }
    } catch { /* 무시 — 수동 조작 유지 */ } finally {
      setSlopeFetching(false)
    }
  }, [])

  // ── 주소 → 좌표 변환 (Kakao → Naver → VWorld 순) ──
  const geocodeAddress = async (q: string): Promise<{ lon: number; lat: number; source?: string } | { error: string } | null> => {
    const errors: string[] = []

    // 1차: Kakao Local API
    try {
      const kakaoRes = await fetch(`/api/kakao?query=${encodeURIComponent(q)}`)
      const kakaoData = await kakaoRes.json()
      if (kakaoRes.ok && !kakaoData.fallback && kakaoData.documents?.length > 0) {
        const doc = kakaoData.documents[0]
        const lon = parseFloat(doc.x ?? doc.address?.x ?? doc.road_address?.x)
        const lat = parseFloat(doc.y ?? doc.address?.y ?? doc.road_address?.y)
        if (!isNaN(lon) && !isNaN(lat)) return { lon, lat, source: 'kakao' }
      }
      errors.push('Kakao: ' + (kakaoData?.error ?? `HTTP ${kakaoRes.status}`))
    } catch (e) { errors.push('Kakao: ' + String(e)) }

    // 2차: Naver Geocoding API
    try {
      const naverRes = await fetch(`/api/naver?query=${encodeURIComponent(q)}`)
      const naverData = await naverRes.json()
      if (naverRes.ok && !naverData.fallback && naverData.addresses?.length > 0) {
        const addr = naverData.addresses[0]
        const lon = parseFloat(addr.x)
        const lat = parseFloat(addr.y)
        if (!isNaN(lon) && !isNaN(lat)) return { lon, lat, source: 'naver' }
      }
      errors.push('Naver: ' + (naverData?.error ?? `HTTP ${naverRes.status}`))
    } catch (e) { errors.push('Naver: ' + String(e)) }

    // 3차: VWorld
    try {
      const vwRes = await fetch(`/api/vworld?type=coord&address=${encodeURIComponent(q)}`)
      const vwData = await vwRes.json()
      if (vwRes.ok && !vwData?.error) {
        const point = vwData?.response?.result?.point
        if (point) return { lon: parseFloat(point.x), lat: parseFloat(point.y), source: 'vworld' }
      }
      errors.push('VWorld: ' + (vwData?.error ?? `HTTP ${vwRes.status}`))
    } catch (e) { errors.push('VWorld: ' + String(e)) }

    // 4차: OpenStreetMap Nominatim (무료, API키 불필요)
    try {
      const nomRes = await fetch(`/api/nominatim?query=${encodeURIComponent(q)}`)
      const nomData = await nomRes.json()
      if (nomRes.ok && Array.isArray(nomData) && nomData.length > 0) {
        const lon = parseFloat(nomData[0].lon)
        const lat = parseFloat(nomData[0].lat)
        if (!isNaN(lon) && !isNaN(lat)) return { lon, lat, source: 'nominatim' }
      }
      errors.push('Nominatim: ' + (nomData?.error ?? (Array.isArray(nomData) && nomData.length === 0 ? '결과없음' : `HTTP ${nomRes.status}`)))
    } catch (e) { errors.push('Nominatim: ' + String(e)) }

    return { error: errors.join(' / ') }
  }

  // ── 주소 검색 핸들러 ──
  const handleAddressSearch = async () => {
    const q = address.trim()
    if (!q) return
    setSearchLoading(true)
    setSearchError('')
    setParcelLabel('')
    setKierResult(null)

    try {
      const coords = await geocodeAddress(q)
      if (!coords || 'error' in coords) {
        const detail = coords && 'error' in coords ? '\n' + coords.error : ''
        setSearchError('주소를 찾을 수 없습니다.' + detail)
        return
      }
      const { lon, lat } = coords

      // 필지 경계 시도 (VWorld — 실패 시 핀만 표시)
      let ring: number[][] | null = null
      try {
        const parcelRes = await fetch(`/api/vworld?type=parcel&lon=${lon}&lat=${lat}`)
        const parcelData = await parcelRes.json()
        const features = parcelData?.response?.result?.featureCollection?.features
        if (features?.length) {
          const geometry = features[0].geometry
          let rawCoords: number[][] = []
          if (geometry.type === 'Polygon') rawCoords = geometry.coordinates[0]
          else if (geometry.type === 'MultiPolygon') rawCoords = geometry.coordinates[0][0]
          if (rawCoords.length >= 3) {
            const closed = rawCoords[0][0] === rawCoords[rawCoords.length - 1][0] &&
              rawCoords[0][1] === rawCoords[rawCoords.length - 1][1]
            ring = closed ? rawCoords.slice(0, -1) : rawCoords

            const attrs = features[0].properties ?? {}
            const label = [attrs.EMD_NM, attrs.RI_NM, attrs.JIBUN].filter(Boolean).join(' ')
            setParcelLabel(label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`)
          }
        }
      } catch { /* 필지 경계 없이 계속 */ }

      if (ring) {
        // 필지 경계 있음 — 완전한 흐름
        const cLon = ring.reduce((s, c) => s + c[0], 0) / ring.length
        const cLat = ring.reduce((s, c) => s + c[1], 0) / ring.length
        const { z, scale } = computeZoomAndScale(ring, cLon, cLat)
        const canvasPoints = ring.map(c => geoToCanvas(c[0], c[1], cLon, cLat, scale))
        const areaSqm = geoRingAreaSqm(ring)
        setAutoAzimuth(calcAutoAzimuth(canvasPoints))
        setPixelScale(scale)
        setSatZoom(z)
        setPoints(canvasPoints)
        setArea(areaSqm)
        setIsComplete(true)
        setDrawMode(false)
        setApiSource('api')
        setLocationCoords({ lat, lon })
        setApiCoords({ lat, lon })
        calcPanelsFromPolygon(canvasPoints, areaSqm, scale)
        loadSatelliteTiles(cLon, cLat, z, scale)
        fetchKierData(lat, lon, tiltAngle)
        fetchSlope(lon, lat)
      } else {
        // 필지 경계 없음 — 좌표 핀만 표시, 수동 드로우 안내
        const defaultZ = 18
        const defaultScale = tilePixelScaleM(lat, defaultZ)
        const center: Point = { x: CANVAS_W / 2, y: CANVAS_H / 2 }
        setParcelLabel(`${lat.toFixed(5)}, ${lon.toFixed(5)}`)
        setPixelScale(defaultScale)
        setSatZoom(defaultZ)
        setPoints([center])
        setIsComplete(false)
        setDrawMode(false)
        setApiSource('api')
        setLocationCoords({ lat, lon })
        setApiCoords({ lat, lon })
        setSearchError('위치를 찾았지만 필지 경계를 불러올 수 없습니다.\n"직접 그리기"로 부지를 표시해 주세요.')
        loadSatelliteTiles(lon, lat, defaultZ, defaultScale)
        fetchKierData(lat, lon, tiltAngle)
        fetchSlope(lon, lat)
      }

    } catch { setSearchError('검색 중 오류가 발생했습니다.')
    } finally { setSearchLoading(false) }
  }

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
    if (points.length >= 3) { setIsComplete(true); setDrawMode(false) }
  }

  const handleStartDraw = () => {
    setPoints([]); setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false)
    setDrawMode(true); setApiSource('manual'); setParcelLabel('')
    setSearchError(''); setPixelScale(0.1); setSatTiles([]); setSatZoom(0)
    setKierResult(null); setApiCoords(null); setAutoAzimuth(null)
  }

  const handleReset = () => {
    setPoints([]); setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false); setDrawMode(false)
    setApiSource('none'); setParcelLabel(''); setSearchError('')
    setPixelScale(0.1); setSatTiles([]); setSatZoom(0)
    setKierResult(null); setApiCoords(null); setAutoAzimuth(null)
    setKierPvHours(null); setKierGhi(null); setLocationCoords(null)
  }

  const handleSendToRevenue = () => {
    setMapResult({ panelCount, capacityKwp, annualKwh, area, address, tiltAngle, moduleIndex })
    setActiveTab('revenue')
  }

  const handleSavePNG = () => {
    const canvas = canvasRef.current; if (!canvas) return
    const link = document.createElement('a')
    link.download = `solar-layout-${address || 'site'}.png`
    link.href = canvas.toDataURL(); link.click()
  }

  const handleSavePDF = async () => {
    const srcCanvas = canvasRef.current
    if (!srcCanvas) return
    const { jsPDF } = await import('jspdf')
    const { default: html2canvas } = await import('html2canvas')

    // 오프스크린 DIV 생성 (한글 텍스트 html2canvas 캡처 → PDF 한글 깨짐 방지)
    const div = document.createElement('div')
    div.style.cssText = [
      'position:fixed;left:-9999px;top:0;',
      'background:white;padding:20px;',
      'width:794px;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;',
      'color:#1a1a1a;line-height:1.4;',
    ].join('')

    const rows: [string, string][] = [
      ['지번', `${address || '-'}${parcelLabel ? ' (' + parcelLabel + ')' : ''}`],
      ['출처', apiSource === 'api' ? 'VWorld 필지 자동 경계' : '수동 측정'],
      ['부지면적', `${area.toFixed(2)} m²`],
      ['설치유형', installType],
      ['모듈', `${MODULES[moduleIndex].name} (${MODULES[moduleIndex].watt}W)`],
      ['경사각', `${tiltAngle}°`],
      ['이격거리', `${spacingValue}m`],
      ['경사도', `${slopePercent}% (면적보정 ×${(Math.cos(Math.atan(slopePercent / 100)) * 100).toFixed(1)}%)`],
      ['패널 수량', `${panelCount}장`],
      ['설비 용량', `${capacityKwp} kWp`],
      ['연간 발전량', `${annualKwh.toLocaleString()} kWh`],
      ...(kierResult ? [['KIER 실측 발전시간', `${kierResult.pvHours}h/일  ·  GHI ${kierResult.ghi.toFixed(0)} kWh/m²/년`] as [string, string]] : []),
    ]

    const boldKeys = new Set(['패널 수량', '설비 용량', '연간 발전량'])
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;border-bottom:2px solid #3b82f6;padding-bottom:10px">
        <span style="font-size:22px">☀</span>
        <div>
          <div style="font-size:18px;font-weight:bold;color:#1e293b">태양광 패널 배치도</div>
          <div style="font-size:11px;color:#64748b">SolarAdvisor v5.2 — 자동 생성</div>
        </div>
      </div>
      <table style="border-collapse:collapse;width:100%;margin-bottom:14px;font-size:12px">
        ${rows.map(([k, v], i) => `
          <tr style="background:${i % 2 === 0 ? '#f8fafc' : 'white'}">
            <td style="padding:5px 10px;color:#64748b;width:140px;border:1px solid #e2e8f0">${k}</td>
            <td style="padding:5px 10px;font-weight:${boldKeys.has(k) ? 'bold' : 'normal'};color:${boldKeys.has(k) ? '#2563eb' : '#1e293b'};border:1px solid #e2e8f0">${v}</td>
          </tr>
        `).join('')}
      </table>
      <img src="${srcCanvas.toDataURL('image/png')}" style="width:100%;border:1px solid #e2e8f0;border-radius:6px" />
      <div style="margin-top:10px;font-size:10px;color:#94a3b8;text-align:center">
        생성: ${new Date().toLocaleDateString('ko-KR')} — SolarAdvisor v5.2 (SMP 110원/kWh · REC 건물 105,000원/MWh · 발전시간 3.5h)
      </div>
    `
    document.body.appendChild(div)

    try {
      const captured = await html2canvas(div, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
      })
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const margin = 8
      const printW = pageW - margin * 2
      const printH = (captured.height / captured.width) * printW

      let yRemain = printH
      let srcY = 0
      while (yRemain > 0) {
        const sliceH = Math.min(pageH - margin * 2, yRemain)
        const slice = document.createElement('canvas')
        slice.width = captured.width
        slice.height = Math.round((sliceH / printW) * captured.width)
        const ctx = slice.getContext('2d')!
        ctx.drawImage(captured, 0, srcY, captured.width, slice.height, 0, 0, captured.width, slice.height)
        pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin, margin, printW, sliceH)
        yRemain -= sliceH
        srcY += slice.height
        if (yRemain > 0) pdf.addPage()
      }
      pdf.save(`solar-layout-${address || 'site'}.pdf`)
    } finally {
      document.body.removeChild(div)
    }
  }

  const step1Done = address.trim().length > 0
  const step2Done = installType !== ''
  const step4Done = isComplete && area > 0
  const step5Done = panelCount > 0

  const stepCircle = (done: boolean, num: string | number, active?: boolean) =>
    `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
      done ? 'bg-green-500 text-white' : active ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'}`

  const stepCard = (done: boolean, active?: boolean) =>
    `bg-white rounded-xl border-2 p-4 transition-colors ${
      done ? 'border-green-300' : active ? 'border-blue-400' : 'border-gray-200'}`

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* ── 왼쪽: 5단계 컨트롤 ── */}
      <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 space-y-3">

        {/* STEP 1 */}
        <div className={stepCard(step1Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(step1Done, '1')}>{step1Done ? '✓' : '1'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">지번 / 주소 입력</h3>
          </div>
          <div className="flex gap-1.5">
            <input type="text" value={address}
              onChange={e => { setAddress(e.target.value); setSearchError('') }}
              onKeyDown={e => e.key === 'Enter' && handleAddressSearch()}
              placeholder="경기도 화성시 우정읍 000-0"
              className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button onClick={handleAddressSearch} disabled={searchLoading || !address.trim()}
              className="flex-shrink-0 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors">
              {searchLoading
                ? <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                : '검색'}
            </button>
          </div>
          {searchLoading && (
            <div className="mt-2 text-xs text-blue-600 flex items-center gap-1.5">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              VWorld 필지 경계 + 위성사진 조회 중...
            </div>
          )}
          {searchError && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600 whitespace-pre-line">{searchError}</div>
          )}
          {parcelLabel && !searchError && (
            <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-2 text-xs text-green-700 flex items-center gap-1.5">
              <span>🛰</span><span>{parcelLabel} — {area.toFixed(0)}m²</span>
            </div>
          )}
          {satLoading && (
            <div className="mt-1 text-xs text-indigo-500 flex items-center gap-1.5">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              위성사진 타일 로딩 중 (Z{satZoom})...
            </div>
          )}
          {satTiles.length > 0 && !satLoading && (
            <div className="mt-1 text-xs text-indigo-600">🛰 위성사진 오버레이 완료 (Z{satZoom} · 1px={pixelScale.toFixed(3)}m)</div>
          )}
        </div>

        {/* STEP 2 */}
        <div className={stepCard(step2Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(step2Done, '2')}>{step2Done ? '✓' : '2'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">설치 유형 선택</h3>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {INSTALL_TYPES.map(t => (
              <button key={t} onClick={() => setInstallType(t)}
                className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  installType === t ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'}`}>
                {t}
              </button>
            ))}
          </div>
          {installType === '건물지붕형' && (
            <div className="mt-3 space-y-2">
              {/* STEP 2 건물: 방위각 자동 설정 */}
              {autoAzimuth !== null && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs">
                  <div className="font-semibold text-blue-700">★ 방위각 자동 설정</div>
                  <div className="text-blue-600 mt-0.5">
                    건물 외곽선 기준 남향 편차: <strong>{autoAzimuth >= 0 ? '+' : ''}{autoAzimuth}°</strong>
                    {Math.abs(autoAzimuth) <= 15
                      ? ' (남향 ✓ 최적)'
                      : Math.abs(autoAzimuth) <= 30
                      ? ' (남서/남동향)'
                      : ' (편차 큼 — 수동 보정 권장)'}
                  </div>
                </div>
              )}
              <select value={structureType} onChange={e => setStructureType(e.target.value as StructureType)}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                {STRUCTURE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {/* STEP 3: 구조안전진단 자동 판단 */}
              {structureType !== '철골구조' && (
                <div className={`rounded-lg p-2 text-xs ${
                  structureType === '샌드위치 패널'
                    ? 'bg-red-50 border border-red-300'
                    : 'bg-yellow-50 border border-yellow-300'}`}>
                  <div className={`font-semibold ${structureType === '샌드위치 패널' ? 'text-red-700' : 'text-yellow-700'}`}>
                    {structureType === '샌드위치 패널' ? '⚠ 구조안전진단 필수' : '⚠ 구조안전확인서 필요'}
                  </div>
                  <div className={`mt-0.5 ${structureType === '샌드위치 패널' ? 'text-red-600' : 'text-yellow-600'}`}>
                    허용하중: {LOAD_LIMITS[structureType]}kg/m²  ·  인허가 서류 준비 필요
                  </div>
                </div>
              )}
              {/* STEP 5: BIPV 판별 및 특례 안내 */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={bipvEnabled} onChange={e => setBipvEnabled(e.target.checked)} className="accent-blue-500"/>
                <span className="text-xs text-gray-700">BIPV 적용 (건물 일체형)</span>
              </label>
              {bipvEnabled && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 text-xs space-y-1">
                  <div className="font-semibold text-purple-700">★ BIPV 특례 자동 활성화</div>
                  <div className="text-purple-600">REC 가중치 <strong>1.5</strong> 자동 적용</div>
                  <div className="text-purple-600">
                    예상 커버률 <strong>~{Math.round(bipvCoverageRatio * 100)}%</strong>
                    {panelCount > 0 && ` (${panelCount}장)`}
                  </div>
                  <div className="text-purple-600">
                    자가소비 <strong>~{Math.round(bipvSelfConsumptionRatio * 100)}%</strong> — 전기료 절감 효과
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* STEP 3 */}
        <div className={stepCard(true)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(true, '✓')}>✓</div>
            <h3 className="font-semibold text-gray-800 text-sm">모듈 · 각도 설정</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 font-medium">모듈 선택</label>
              <select value={moduleIndex} onChange={e => setModuleIndex(Number(e.target.value))}
                className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                {MODULES.map((m, i) => <option key={i} value={i}>{m.name} ({m.watt}W)</option>)}
              </select>
              <div className="mt-1 text-xs text-gray-400">{MODULES[moduleIndex].w}m × {MODULES[moduleIndex].h}m</div>
            </div>
            <div>
              <div className="flex justify-between">
                <label className="text-xs text-gray-500 font-medium">경사각</label>
                <span className="text-sm font-bold text-blue-600">{tiltAngle}°</span>
              </div>
              <input type="range" min={0} max={60} value={tiltAngle}
                onChange={e => setTiltAngle(Number(e.target.value))} className="mt-1 w-full"/>
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
                      spacingValue === opt.value ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-xs text-gray-400">
                이론값 (동지기준): <span className="font-medium text-gray-600">{theoreticalSpacing}m</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-500 font-medium">경사도 (지형)</label>
                <div className="flex items-center gap-1.5">
                  {slopeFetching && <span className="text-xs text-blue-400">측정 중…</span>}
                  {slopeAuto && !slopeFetching && <span className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-1.5 py-0.5 rounded">자동측정</span>}
                  <span className="text-sm font-bold text-orange-600">{slopePercent}%</span>
                </div>
              </div>
              <input type="range" min={0} max={50} value={slopePercent}
                onChange={e => { setSlopePercent(Number(e.target.value)); setSlopeAuto(false) }} className="mt-1 w-full"/>
              {slopePercent > 0
                ? <div className="mt-1 text-xs text-orange-600">면적 보정: ×{(Math.cos(Math.atan(slopePercent / 100)) * 100).toFixed(1)}%</div>
                : <div className="mt-1 text-xs text-gray-400">평지 (보정 없음)</div>}
            </div>
          </div>
        </div>

        {/* STEP 4 — 수동 그리기 */}
        <div className={stepCard(step4Done, drawMode)}>
          <div className="flex items-center gap-2 mb-2">
            <div className={stepCircle(step4Done, '4', drawMode)}>{step4Done ? '✓' : '4'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">수동 부지 그리기</h3>
          </div>
          <p className="text-xs text-gray-400 mb-2">API 키 없을 때 캔버스에 직접 그릴 수 있습니다</p>
          <div className="flex gap-2">
            <button onClick={handleStartDraw}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                drawMode ? 'bg-red-50 border-red-400 text-red-600' : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'}`}>
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

        {/* KIER 실측 일사량 */}
        {(kierLoading || kierResult) && (
          <div className={`rounded-xl border-2 p-4 ${kierResult ? 'bg-emerald-50 border-emerald-300' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">☀️</span>
              <h3 className="font-semibold text-sm text-gray-800">KIER 실측 일사량</h3>
              {kierLoading && <svg className="animate-spin h-3.5 w-3.5 text-emerald-500 ml-auto" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>}
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
                <div className="flex justify-between text-xs border-t border-emerald-200 pt-1.5">
                  <span className="text-gray-600 font-medium">실측 발전시간</span>
                  <span className="font-bold text-emerald-700">{kierResult.pvHours}h/일</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">기준값 대비</span>
                  <span className={`font-semibold ${kierResult.pvHours >= 3.5 ? 'text-emerald-600' : 'text-orange-500'}`}>
                    {kierResult.pvHours >= 3.5 ? '+' : ''}{((kierResult.pvHours - 3.5) / 3.5 * 100).toFixed(1)}% (기준 3.5h)
                  </span>
                </div>
                <div className="mt-1 bg-emerald-100 rounded px-2 py-1 text-xs text-emerald-700 text-center font-medium">
                  수익성 시뮬레이터에 실측값 자동 적용
                </div>
              </div>
            )}
            {kierLoading && !kierResult && <div className="text-xs text-gray-400">KIER 데이터 조회 중...</div>}
          </div>
        )}

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
                {satTiles.length > 0 ? '  ·  위성 합성' : ''}
              </div>
            </div>
            <button onClick={handleSendToRevenue}
              className="mt-3 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold transition-colors">
              수익성 시뮬레이터로 연동 →
            </button>
          </div>
        )}

        {/* 기준값 */}
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-3">
          <div className="text-xs font-semibold text-amber-800 mb-1">📌 실제 현장 기준값</div>
          <div className="space-y-0.5 text-xs text-amber-700">
            <div>TOPCon GS710W · 경사각 15° · 이격 1.2m</div>
            <div className="font-bold">524.85 m² → 38장 · 26.98 kWp</div>
          </div>
        </div>
      </div>

      {/* ── 오른쪽: Canvas ── */}
      <div className="flex-1 min-w-0">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                <span>🗺️</span> 패널 배치도 자동 생성 엔진
              </h3>
              {apiSource === 'api' && parcelLabel && (
                <p className="text-xs text-green-600 mt-0.5">
                  🛰 VWorld 필지 경계 · {parcelLabel}
                  {satTiles.length > 0 && ` · 위성사진 Z${satZoom}`}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={handleSavePNG} disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                PNG 저장
              </button>
              <button onClick={handleSavePDF} disabled={!isComplete}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40">
                PDF 출력
              </button>
            </div>
          </div>

          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H}
            onClick={handleCanvasClick} onDoubleClick={handleCanvasDblClick}
            className={`w-full h-auto border border-gray-200 rounded-lg bg-gray-50 ${drawMode ? 'cursor-crosshair' : 'cursor-default'}`}
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
      </div>
    </div>
  )
}
