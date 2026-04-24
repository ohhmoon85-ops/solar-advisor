'use client'

// VWorld는 Vercel/Cloudflare 서버 IP를 모두 차단함
// → 브라우저(한국 사용자 IP)에서 직접 호출하는 방식으로 전환
const VW_KEY = process.env.NEXT_PUBLIC_VWORLD_API_KEY ?? ''
const VW = 'https://api.vworld.kr'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useSolarStore } from '@/store/useStore'
import { MODULES, GENERATION_HOURS } from '@/lib/constants'
import { getSolarElevation } from '@/lib/shadowCalculator'
import { runFullAnalysis, type FullAnalysisResult, type PlotType } from '@/lib/layoutEngine'
import { convertGeoRingToLocalPolygon } from '@/lib/cadastre'
import { PRESET_PANELS } from '@/lib/panelConfig'
import { type MultiZoneResult, type ZoneConfig, runMultiZoneAnalysis, autoSplitPolygon, isMultiZoneResult } from '@/lib/multiZoneLayout'

// SVG 캔버스는 클라이언트 전용
const SolarLayoutCanvas = dynamic(
  () => import('@/components/SolarLayoutCanvas'),
  { ssr: false }
)

const LayoutEditor = dynamic(
  () => import('@/components/LayoutEditor'),
  { ssr: false }
)

const STRUCTURE_TYPES = ['철골구조', 'RC(철근콘크리트)', '경량철골', '샌드위치 패널'] as const
type StructureType = typeof STRUCTURE_TYPES[number]


const INSTALL_TYPES = ['건물지붕형', '일반토지형'] as const

const LOAD_LIMITS: Record<StructureType, number | null> = {
  '철골구조': null,
  'RC(철근콘크리트)': 30,
  '경량철골': 20,
  '샌드위치 패널': 15,
}

const CANVAS_W = 800
const CANVAS_H = 500

// 지번별 색상 (최대 5개 필지)
const PARCEL_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444'] as const

// 설치 유형별 경계 마진 (미터)
const BOUNDARY_MARGIN: Record<string, number> = {
  '건물지붕형': 0.5,
  '일반토지형': 2.0,
}

interface Point { x: number; y: number }
interface PanelRect { x: number; y: number; w: number; h: number }
interface SatTile { img: HTMLImageElement; cx: number; cy: number; px: number }

// 복수 필지 데이터
interface ParcelInfo {
  ring: number[][]
  canvasPoints: Point[]
  areaSqm: number
  label: string
  lon: number
  lat: number
  color: string
}

// ── VWorld 헬퍼 ────────────────────────────────────────────────────

/** 타일 z/x/y → WGS84 bbox (WMS 1.3.0: minLat,minLon,maxLat,maxLon) */
function tileToWgs84Bbox(z: number, tx: number, ty: number): string {
  const n = Math.pow(2, z)
  const west = (tx / n) * 360 - 180
  const east = ((tx + 1) / n) * 360 - 180
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI
  return `${latS},${west},${latN},${east}`
}

/** VWorld JSONP 호출 (CORS 미지원 우회) */
function vwJsonp<T = unknown>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = '_vw_' + Math.random().toString(36).slice(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any)[cb] = (data: T) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any)[cb]
      script.remove()
      resolve(data)
    }
    const script = document.createElement('script')
    script.src = url + (url.includes('?') ? '&' : '?') + `callback=${cb}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    script.onerror = () => { delete (window as any)[cb]; script.remove(); reject(new Error('JSONP failed')) }
    document.head.appendChild(script)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTimeout(() => { delete (window as any)[cb]; script.remove(); reject(new Error('JSONP timeout')) }, 10000)
  })
}

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

// ── 점 ↔ 선분 최단거리 ────────────────────────────────────────────
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.sqrt((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2)
}

/** 점에서 폴리곤 경계까지 최단 거리 (픽셀) */
function minDistToPolygonEdge(px: number, py: number, poly: Point[]): number {
  let minD = Infinity
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    minD = Math.min(minD, distToSegment(px, py, poly[i].x, poly[i].y, poly[j].x, poly[j].y))
  }
  return minD
}

// ── 두 선분 교차 여부 (끝점 접촉 제외) ──────────────────────────────
function segmentsIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): boolean {
  const d1x = x2 - x1, d1y = y2 - y1
  const d2x = x4 - x3, d2y = y4 - y3
  const cross = d1x * d2y - d1y * d2x
  if (Math.abs(cross) < 1e-10) return false
  const dx = x3 - x1, dy = y3 - y1
  const t = (dx * d2y - dy * d2x) / cross
  const u = (dx * d1y - dy * d1x) / cross
  return t > 1e-10 && t < 1 - 1e-10 && u > 1e-10 && u < 1 - 1e-10
}

/** 패널 사각형의 4변이 폴리곤 경계를 가로지르는지 확인 */
function panelCrossesBoundary(x: number, y: number, w: number, h: number, poly: Point[]): boolean {
  // 패널 4변
  const panelEdges: [number, number, number, number][] = [
    [x, y, x + w, y],         // top
    [x + w, y, x + w, y + h], // right
    [x + w, y + h, x, y + h], // bottom
    [x, y + h, x, y],         // left
  ]
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const px1 = poly[i].x, py1 = poly[i].y, px2 = poly[j].x, py2 = poly[j].y
    for (const [ex1, ey1, ex2, ey2] of panelEdges) {
      if (segmentsIntersect(ex1, ey1, ex2, ey2, px1, py1, px2, py2)) return true
    }
  }
  return false
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
  const {
    setMapResult, setActiveTab, setKierPvHours, setKierGhi, setLocationCoords,
    setLastFullAnalysisJson,
    pendingRestore, setPendingRestore,
  } = useSolarStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobUrlsRef = useRef<string[]>([]) // cleanup용

  // ── 입력 ──
  const [addresses, setAddresses] = useState<string[]>(['', '', '', '', ''])
  const [installType, setInstallType] = useState<string>('건물지붕형')
  const [moduleIndex, setModuleIndex] = useState(0)
  const [tiltAngle, setTiltAngle] = useState(33)
  const [spacingValue, setSpacingValue] = useState(1.2)
  const [panelOrientation, setPanelOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [rowStack, setRowStack] = useState<1 | 2 | 3>(1)
  const [slopePercent, setSlopePercent] = useState(0)
  const [slopeAuto, setSlopeAuto] = useState(false)  // 자동측정 여부
  const [slopeFetching, setSlopeFetching] = useState(false)
  const [structureType, setStructureType] = useState<StructureType>('철골구조')
  const [bipvEnabled, setBipvEnabled] = useState(false)

  // ── 드로잉 ──
  const [isComplete, setIsComplete] = useState(false)
  const [area, setArea] = useState(0)
  const [pixelScale, setPixelScale] = useState(0.1) // m/px

  // ── 위성/지적도 오버레이 ──
  const [satTiles, setSatTiles] = useState<SatTile[]>([])
  const [cadImgTiles, setCadImgTiles] = useState<{src:string;cx:number;cy:number;px:number}[]>([])
  const [satLoading, setSatLoading] = useState(false)
  const [satZoom, setSatZoom] = useState(0)
  const [mapMode, setMapMode] = useState<'satellite' | 'cadastral'>('satellite')

  // ── 복수 필지 ──
  const [parcels, setParcels] = useState<ParcelInfo[]>([])

  // ── API 상태 ──
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [parcelLabel, setParcelLabel] = useState('')
  const [apiSource, setApiSource] = useState<'none' | 'api'>('none')
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
  // SVG 정밀 배치 분석 상태
  const [svgAnalysisResult, setSvgAnalysisResult] = useState<FullAnalysisResult | MultiZoneResult | null>(null)
  const [svgAnalyzing, setSvgAnalyzing] = useState(false)
  const [svgPanelType, setSvgPanelType] = useState<string>('GS710wp')
  const [svgPlotType, setSvgPlotType] = useState<PlotType>('land')
  const [showSvgCanvas, setShowSvgCanvas] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editingCount, setEditingCount] = useState<number | null>(null)
  // v5.2 SVG 배치 입력 (간소화)
  const [svgAzimuthDeg, setSvgAzimuthDeg] = useState(180)
  const [svgZoneMode, setSvgZoneMode] = useState<'single' | 'multi'>('single')
  const [svgPanelOrientation, setSvgPanelOrientation] = useState<'portrait' | 'landscape'>('portrait')

  // 이론 이격 거리 — 현장 위도 기반 (hardcode 37.5665° → 동적 위도)
  const tiltRad = (tiltAngle * Math.PI) / 180
  const effectiveLatitude = apiCoords?.lat ?? 37.5665
  const winterElevDeg = getSolarElevation(effectiveLatitude, -23.45)
  const winterAltRad = (winterElevDeg * Math.PI) / 180
  const theoreticalSpacing =
    Math.round(MODULES[moduleIndex].h * Math.cos(tiltRad) * (1 / Math.tan(winterAltRad)) * 100) / 100

  // BIPV 계산
  const bipvCoverageRatio = 0.60
  const bipvSelfConsumptionRatio = 0.50

  // 컴포넌트 언마운트 시 Blob URL 해제
  useEffect(() => {
    return () => { blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u)) }
  }, [])

  // ── 시뮬레이션 이력 불러오기 (SimulationRecord) ──
  useEffect(() => {
    if (!pendingRestore) return
    const rec = pendingRestore
    // 주소 복원
    const addrParts = rec.address.split(',').map(s => s.trim()).slice(0, 5)
    const restored = [...addrParts, '', '', '', '', ''].slice(0, 5)
    setAddresses(restored)
    // fullAnalysisSnapshot 복원
    if (rec.fullAnalysisSnapshot) {
      try {
        const parsed = JSON.parse(rec.fullAnalysisSnapshot)
        setSvgAnalysisResult(parsed)
        setLastFullAnalysisJson(rec.fullAnalysisSnapshot)
        setShowSvgCanvas(true)
        setIsEditing(false)
      } catch { /* 무시 */ }
    }
    setPendingRestore(null)
  }, [pendingRestore, setPendingRestore, setLastFullAnalysisJson])

  // ── 타일 로드 공통 함수 ──
  const loadTiles = useCallback(async (
    cLon: number, cLat: number, z: number, scale: number, mode: 'satellite' | 'cadastral'
  ) => {
    setSatLoading(true)
    setSatTiles([])
    setCadImgTiles([])
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []

    const { tx: ctX, ty: ctY } = lonLatToTile(cLon, cLat, z)
    const tileMeter = tilePixelScaleM(cLat, z) * 256
    const tilePx = tileMeter / scale
    const R = 2

    if (mode === 'cadastral') {
      // 지적도: VWorld WMS → CORS 없이 <img>로 로드 (인접 필지 포함)
      const tiles: {src:string;cx:number;cy:number;px:number}[] = []
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const tx = ctX + dx, ty = ctY + dy
          const origin = tileOriginLonLat(tx, ty, z)
          const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
          const bbox = tileToWgs84Bbox(z, tx, ty)
          const src = `${VW}/req/wms?service=WMS&request=GetMap&version=1.3.0&layers=lt_c_landinfobasemap&width=256&height=256&format=image/png&transparent=true&crs=EPSG:4326&bbox=${bbox}&key=${VW_KEY}`
          tiles.push({ src, cx, cy, px: tilePx })
        }
      }
      setCadImgTiles(tiles)
      setSatLoading(false)
      return
    }

    // 위성사진: ArcGIS CORS 허용 → canvas drawImage
    const jobs: Promise<SatTile | null>[] = []
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = ctX + dx, ty = ctY + dy
        jobs.push((async () => {
          try {
            const origin = tileOriginLonLat(tx, ty, z)
            const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
            const tileUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`
            return await new Promise<SatTile | null>(resolve => {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              img.onload = () => resolve({ img, cx, cy, px: tilePx })
              img.onerror = () => resolve(null)
              img.src = tileUrl
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

    // ❶ 배경: 위성사진 / 기본 그리드
    if (satTiles.length > 0) {
      satTiles.forEach(t => ctx.drawImage(t.img, t.cx, t.cy, t.px, t.px))
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 0.5
      for (let x = 0; x < CANVAS_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y < CANVAS_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_H, y); ctx.stroke()
      }
    } else if (cadImgTiles.length === 0) {
      // 기본 그리드 배경 (지적도 WMS img 없을 때만)
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5
      for (let x = 0; x < CANVAS_W; x += 20) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y < CANVAS_H; y += 20) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke()
      }
    }

    const hasParcelData = parcels.length > 0

    if (!hasParcelData) {
      ctx.fillStyle = satTiles.length > 0 ? 'rgba(255,255,255,0.85)' : '#94a3b8'
      ctx.font = '14px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText('지번을 검색하여 부지를 불러와 주세요', CANVAS_W / 2, CANVAS_H / 2)
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(`축척 Z${satZoom}`, 8, CANVAS_H - 8)
      return
    }

    // ❷ 복수 필지 경계 — API에서 가져온 경우
    if (hasParcelData) {
      parcels.forEach((parcel, pi) => {
        const pts = parcel.canvasPoints
        if (pts.length < 2) return
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
        ctx.closePath()
        // 각 필지별 색상으로 채우기
        const hexColor = parcel.color
        ctx.fillStyle = hexColor + '22' // 투명도 ~13%
        ctx.fill()
        ctx.strokeStyle = hexColor
        ctx.lineWidth = 2.5
        ctx.stroke()
        // 필지 번호 레이블
        const lcx = pts.reduce((s, p) => s + p.x, 0) / pts.length
        const lcy = pts.reduce((s, p) => s + p.y, 0) / pts.length
        ctx.fillStyle = hexColor
        ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'
        ctx.fillText(`필지${pi + 1}`, lcx, lcy - 14)
        ctx.font = '9px sans-serif'
        ctx.fillText(parcel.label || '', lcx, lcy - 2)
      })
    }

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

    // ❺ 중심 레이블
    if (isComplete && area > 0 && parcels.length > 0) {
      const firstPts = parcels[0].canvasPoints
      const cx = firstPts.reduce((s, p) => s + p.x, 0) / firstPts.length
      const cy = firstPts.reduce((s, p) => s + p.y, 0) / firstPts.length
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

    // ❻ 축척 텍스트 (왼쪽 하단)
    const scaleLabel = satZoom > 0
      ? `축척 Z${satZoom}: 1px = ${pixelScale.toFixed(3)}m  (지도=CAD 일치)`
      : `축척 Z${satZoom}`
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'
    if (satTiles.length > 0) {
      const sw = ctx.measureText(scaleLabel).width
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(4, CANVAS_H - 20, sw + 8, 16)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
    } else {
      ctx.fillStyle = '#94a3b8'
    }
    ctx.fillText(scaleLabel, 8, CANVAS_H - 8)

    // ❻-b 시각적 축척바 (오른쪽 하단) — 지도·CAD 축척 일치 검증용
    {
      const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500]
      const targetBarPx = 80
      const barM = candidates.find(m => m / pixelScale >= targetBarPx) ?? 500
      const rawBarPx = barM / pixelScale
      const dispPx = Math.min(rawBarPx, CANVAS_W * 0.28)
      const barX = CANVAS_W - dispPx - 16
      const barY = CANVAS_H - 10
      const onMap = satTiles.length > 0
      const barFg = onMap ? 'rgba(255,255,255,0.97)' : '#334155'
      const barBg = onMap ? 'rgba(0,0,0,0.50)' : 'rgba(241,245,249,0.92)'
      ctx.fillStyle = barBg
      ctx.fillRect(barX - 5, barY - 16, dispPx + 10, 20)
      ctx.strokeStyle = barFg; ctx.lineWidth = 2.5
      // 가로 메인 선
      ctx.beginPath(); ctx.moveTo(barX, barY); ctx.lineTo(barX + dispPx, barY); ctx.stroke()
      // 양 끝 눈금
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(barX, barY - 5); ctx.lineTo(barX, barY + 3); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(barX + dispPx, barY - 5); ctx.lineTo(barX + dispPx, barY + 3); ctx.stroke()
      // 라벨
      ctx.fillStyle = barFg
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(`${barM}m`, barX + dispPx / 2, barY - 5)
    }

    // ❼ VWorld 배지
    if (apiSource === 'api') {
      const badgeLabel = parcels.length > 1
        ? `VWorld ${parcels.length}개 필지 경계`
        : 'VWorld 필지 자동 경계'
      ctx.fillStyle = 'rgba(16,185,129,0.85)'
      const bw = ctx.measureText(badgeLabel).width + 20
      ctx.fillRect(CANVAS_W - bw - 4, 8, bw + 4, 20)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(badgeLabel, CANVAS_W - (bw + 4) / 2, 21)
    }
  }, [isComplete, area, panelRects, spacingValue, panelCount,
      pixelScale, apiSource, satTiles, cadImgTiles, satZoom,
      parcels, mapMode])

  useEffect(() => { drawCanvas() }, [drawCanvas])

  // ── 패널 배치 계산 (필지·설정 변경 시 자동 재계산) ──────────────
  const recalculatePanels = useCallback((currentParcels: ParcelInfo[], scale: number) => {
    if (currentParcels.length === 0) return
    let totalPanelRects: PanelRect[] = []
    let totalCount = 0
    for (const parcel of currentParcels) {
      const module = MODULES[moduleIndex]
      const isBuilding = installType === '건물지붕형'
      const slopeFactor = Math.cos(Math.atan(slopePercent / 100))
      const ltr = (tiltAngle * Math.PI) / 180
      const panelW = panelOrientation === 'landscape' ? module.h : module.w
      const panelH = panelOrientation === 'landscape' ? module.w : module.h
      const panelPxW = panelW / scale
      const panelPxH = (panelH * Math.cos(ltr) * rowStack) / scale
      const rowPitch = panelPxH + spacingValue / scale
      const marginM = BOUNDARY_MARGIN[installType] ?? 2.0
      const marginPx = marginM / scale
      const pts = parcel.canvasPoints
      if (pts.length < 3) continue
      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))
      const rects: PanelRect[] = []
      for (let y = minY + marginPx; y + panelPxH <= maxY - marginPx; y += rowPitch) {
        for (let x = minX + marginPx; x + panelPxW <= maxX - marginPx; x += panelPxW + 2) {
          if (panelCrossesBoundary(x, y, panelPxW, panelPxH, pts)) continue
          const checkPts = [
            { x, y }, { x: x + panelPxW, y },
            { x, y: y + panelPxH }, { x: x + panelPxW, y: y + panelPxH },
            { x: x + panelPxW / 2, y }, { x: x + panelPxW / 2, y: y + panelPxH },
            { x, y: y + panelPxH / 2 }, { x: x + panelPxW, y: y + panelPxH / 2 },
          ]
          if (checkPts.every(c =>
                isPointInPolygon(c.x, c.y, pts) &&
                minDistToPolygonEdge(c.x, c.y, pts) >= marginPx))
            rects.push({ x, y, w: panelPxW, h: panelPxH })
        }
      }
      totalPanelRects = [...totalPanelRects, ...rects]
      const perimeterPx = pts.reduce((sum, p, i) => {
        const j = (i + 1) % pts.length
        return sum + Math.sqrt((pts[j].x - p.x) ** 2 + (pts[j].y - p.y) ** 2)
      }, 0)
      const effectiveArea = Math.max(0, parcel.areaSqm - perimeterPx * scale * marginM)
      const footprintPerPanel = panelW * (panelH * Math.cos(ltr) * rowStack + spacingValue)
      const coverageRatio = isBuilding ? 0.70 : 0.85
      const cnt = parcel.areaSqm > 10
        ? Math.floor(effectiveArea * slopeFactor * coverageRatio / footprintPerPanel)
        : rects.length
      totalCount += cnt
    }
    setPanelRects(totalPanelRects)
    setPanelCount(totalCount)
    const cap = (totalCount * MODULES[moduleIndex].watt) / 1000
    setCapacityKwp(Math.round(cap * 100) / 100)
    setAnnualKwh(Math.round(cap * GENERATION_HOURS * 365))
  }, [installType, moduleIndex, tiltAngle, spacingValue, panelOrientation, rowStack, slopePercent])

  // 설정 변경 시 자동 재계산 (검색 후 유형·모듈 등을 바꾸면 즉시 반영)
  useEffect(() => {
    if (parcels.length > 0 && pixelScale > 0) {
      recalculatePanels(parcels, pixelScale)
    }
  }, [recalculatePanels, parcels, pixelScale])

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
      if (ghiData?.fallback || pvData?.fallback) return
      const ghi = parseFloat(ghiData?.annualTotal ?? 0)
      const pvPot = parseFloat(pvData?.annualTotal ?? 0)
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

  // mapMode 변경 시 타일 재로드
  useEffect(() => {
    if (satZoom === 0 || !apiCoords) return
    const allCoords = parcels.length > 0
      ? parcels.flatMap(p => p.ring)
      : null
    if (!allCoords) return
    const cLon = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length
    const cLat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length
    loadTiles(cLon, cLat, satZoom, pixelScale, mapMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode])

  // ── VWorld DEM 경사도 자동 측정 ──
  const fetchSlope = useCallback(async (lon: number, lat: number) => {
    setSlopeFetching(true)
    try {
      const dLat = 20 / 111319.9
      const dLon = 20 / (111319.9 * Math.cos(lat * Math.PI / 180))
      const pts = [[lon,lat],[lon,lat+dLat],[lon,lat-dLat],[lon+dLon,lat],[lon-dLon,lat]]
      const getElev = async (lo: number, la: number) => {
        try {
          const r = await fetch(`${VW}/req/dem?service=dem&request=getElevation&version=2.0&crs=epsg:4326&key=${VW_KEY}&format=json&point=${lo},${la}`)
          if (!r.ok) return null
          const d = await r.json()
          const h = d?.response?.result?.height ?? d?.response?.result?.elevation
          return h != null ? parseFloat(h) : null
        } catch { return null }
      }
      const [hC,hN,hS,hE,hW] = await Promise.all(pts.map(([lo,la]) => getElev(lo,la)))
      if (hC==null||hN==null||hS==null||hE==null||hW==null) return
      const slopePct = Math.round(Math.sqrt(((hN-hS)/40)**2 + ((hE-hW)/40)**2) * 100)
      setSlopePercent(Math.min(slopePct, 50))
      setSlopeAuto(true)
    } catch { /* 무시 */ } finally { setSlopeFetching(false) }
  }, [])

  // ── 주소 → 좌표 변환 (VWorld → Kakao → Naver → Nominatim 순) ──
  const geocodeAddress = async (q: string): Promise<{ lon: number; lat: number; source?: string } | { error: string } | null> => {
    const errors: string[] = []

    // 1차: VWorld 검색 API — JSONP (CORS 미지원 우회)
    try {
      const vwSData = await vwJsonp<{ response?: { status?: string; result?: { items?: { point?: { x: string; y: string } }[] } } }>(
        `${VW}/req/search?service=search&request=search&version=2.0&crs=epsg:4326&size=1&page=1&format=json&key=${VW_KEY}&query=${encodeURIComponent(q)}&type=address&category=PARCEL`
      )
      if (vwSData?.response?.status === 'OK') {
        const item = vwSData?.response?.result?.items?.[0]
        const point = item?.point
        if (point) {
          const lon = parseFloat(point.x)
          const lat = parseFloat(point.y)
          if (!isNaN(lon) && !isNaN(lat)) return { lon, lat, source: 'vworld-search' }
        }
      }
      errors.push('VWorld검색: ' + (vwSData?.response?.status ?? 'no result'))
    } catch (e) { errors.push('VWorld검색: ' + String(e)) }

    // 2차: Kakao Local API
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

    // 3차: Naver Geocoding API (1/2차 실패 시 폴백)
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

    // 4차: VWorld 주소→좌표 — JSONP (CORS 미지원 우회)
    try {
      const vwData = await vwJsonp<{ response?: { result?: { point?: { x: string; y: string } }; error?: string } }>(
        `${VW}/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326&refine=true&simple=false&format=json&key=${VW_KEY}&address=${encodeURIComponent(q)}&type=parcel`
      )
      const point = vwData?.response?.result?.point
      if (point) return { lon: parseFloat(point.x), lat: parseFloat(point.y), source: 'vworld' }
      errors.push('VWorld: ' + (vwData?.response?.error ?? '결과없음'))
    } catch (e) { errors.push('VWorld: ' + String(e)) }

    // 5차: OpenStreetMap Nominatim (무료, API키 불필요)
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

  // ── 단일 지번 필지 경계 조회 ──
  const fetchParcelRing = async (lon: number, lat: number): Promise<{
    ring: number[][], label: string
  } | null> => {
    try {
      // VWorld 필지 경계 — JSONP (CORS 미지원 우회)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parcelData = await vwJsonp<any>(
        `${VW}/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VW_KEY}&format=json&geometry=true&attribute=true&crs=epsg:4326&page=1&size=1&geomFilter=POINT(${lon}%20${lat})`
      )
      const features = parcelData?.response?.result?.featureCollection?.features
      if (!features?.length) return null
      const geometry = features[0].geometry
      let rawCoords: number[][] = []
      if (geometry.type === 'Polygon') rawCoords = geometry.coordinates[0]
      else if (geometry.type === 'MultiPolygon') rawCoords = geometry.coordinates[0][0]
      if (rawCoords.length < 3) return null
      const closed = rawCoords[0][0] === rawCoords[rawCoords.length - 1][0] &&
        rawCoords[0][1] === rawCoords[rawCoords.length - 1][1]
      const ring = closed ? rawCoords.slice(0, -1) : rawCoords
      const attrs = features[0].properties ?? {}
      const label = [attrs.EMD_NM, attrs.RI_NM, attrs.JIBUN].filter(Boolean).join(' ')
      return { ring, label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}` }
    } catch { return null }
  }

  // ── 다중 지번 검색 핸들러 ──
  const handleAddressSearch = async () => {
    const queries = addresses.map(a => a.trim()).filter(Boolean)
    if (queries.length === 0) return
    setSearchLoading(true)
    setSearchError('')
    setParcelLabel('')
    setKierResult(null)
    setParcels([])
    setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false)

    try {
      // 모든 지번 병렬 조회
      const coordResults = await Promise.all(queries.map(q => geocodeAddress(q)))
      const parcelResults: ParcelInfo[] = []

      for (let i = 0; i < coordResults.length; i++) {
        const coords = coordResults[i]
        if (!coords || 'error' in coords) continue
        const { lon, lat } = coords
        const parcelData = await fetchParcelRing(lon, lat)
        if (!parcelData) continue
        parcelResults.push({
          ring: parcelData.ring,
          canvasPoints: [], // 나중에 공통 좌표계로 변환
          areaSqm: geoRingAreaSqm(parcelData.ring),
          label: parcelData.label,
          lon, lat,
          color: PARCEL_COLORS[i % PARCEL_COLORS.length],
        })
      }

      if (parcelResults.length === 0) {
        // 경계 없음 — 첫 번째 좌표로 위성 로드
        const coords = coordResults.find(c => c && !('error' in c)) as { lon: number; lat: number } | undefined
        if (coords) {
          const defaultZ = 18
          const defaultScale = tilePixelScaleM(coords.lat, defaultZ)
          setPixelScale(defaultScale); setSatZoom(defaultZ)
          setApiSource('api')
          setLocationCoords(coords)
          setApiCoords(coords)
          loadTiles(coords.lon, coords.lat, defaultZ, defaultScale, mapMode)
          fetchKierData(coords.lat, coords.lon, tiltAngle)
          fetchSlope(coords.lon, coords.lat)
        }
        setSearchError('필지 경계를 불러올 수 없습니다.')
        return
      }

      // ── 공통 지도 좌표계 계산 (전체 필지가 화면에 들어오도록) ──
      const allCoords = parcelResults.flatMap(p => p.ring)
      const cLon = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length
      const cLat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length
      const { z, scale } = computeZoomAndScale(allCoords, cLon, cLat)

      // 각 필지를 공통 좌표계로 변환
      const converted = parcelResults.map(p => ({
        ...p,
        canvasPoints: p.ring.map(c => geoToCanvas(c[0], c[1], cLon, cLat, scale)),
      }))
      setParcels(converted)

      // 전체 합산 면적 및 패널 계산
      const totalArea = converted.reduce((s, p) => s + p.areaSqm, 0)
      setArea(totalArea)
      setPixelScale(scale)
      setSatZoom(z)
      setIsComplete(true)
      setApiSource('api')

      // 첫 번째 필지 기준으로 KIER·경사도·방위각
      const first = converted[0]
      setAutoAzimuth(calcAutoAzimuth(first.canvasPoints))
      setLocationCoords({ lat: first.lat, lon: first.lon })
      setApiCoords({ lat: first.lat, lon: first.lon })
      setParcelLabel(converted.map(p => p.label).join(' · '))

      // 패널 계산은 recalculatePanels useEffect가 parcels/pixelScale 변경 시 자동 처리

      loadTiles(cLon, cLat, z, scale, mapMode)
      fetchKierData(first.lat, first.lon, tiltAngle)
      fetchSlope(first.lon, first.lat)

    } catch (e) {
      setSearchError('검색 중 오류가 발생했습니다: ' + String(e))
    } finally {
      setSearchLoading(false)
    }
  }

  const handleReset = () => {
    setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false)
    setApiSource('none'); setParcelLabel(''); setSearchError('')
    setPixelScale(0.1); setSatTiles([]); setSatZoom(0)
    setKierResult(null); setApiCoords(null); setAutoAzimuth(null)
    setKierPvHours(null); setKierGhi(null); setLocationCoords(null)
    // 복수 필지 초기화
    setParcels([])
  }

  const handleSendToRevenue = (source: 'quick' | 'precision' = 'quick') => {
    const addressLabel = addresses.filter(Boolean).join(', ')
    if (source === 'precision' && svgAnalysisResult && !isMultiZoneResult(svgAnalysisResult)) {
      const genHours = kierResult?.pvHours ?? GENERATION_HOURS
      const svgCount = svgAnalysisResult.layout.totalCount
      const svgKwp = svgAnalysisResult.layout.totalKwp
      const svgAnnualKwh = Math.round(svgKwp * genHours * 365)
      setMapResult({ panelCount: svgCount, capacityKwp: svgKwp, annualKwh: svgAnnualKwh, area, address: addressLabel, tiltAngle, moduleIndex })
    } else {
      setMapResult({ panelCount, capacityKwp, annualKwh, area, address: addressLabel, tiltAngle, moduleIndex })
    }
    setActiveTab('revenue')
  }

  const handleSavePNG = () => {
    const canvas = canvasRef.current; if (!canvas) return
    const link = document.createElement('a')
    link.download = `solar-layout-${addresses.filter(Boolean)[0] || 'site'}.png`
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

    const addressLabel = addresses.filter(Boolean).join(', ')
    const rows: [string, string][] = [
      ['지번', `${addressLabel || '-'}${parcelLabel ? ' (' + parcelLabel + ')' : ''}`],
      ['출처', apiSource === 'api' ? 'VWorld 필지 자동 경계' : '직접 측정'],
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
      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px">
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
      pdf.save(`solar-layout-${addresses.filter(Boolean)[0] || 'site'}.pdf`)
    } finally {
      document.body.removeChild(div)
    }
  }

  const step1Done = addresses.some(a => a.trim().length > 0)
  const step2Done = installType !== ''
  const step5Done = panelCount > 0

  const stepCircle = (done: boolean, num: string | number, active?: boolean) =>
    `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
      done ? 'bg-green-500 text-white' : active ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'}`

  const stepCard = (done: boolean, active?: boolean) =>
    `bg-white rounded-xl border-2 p-4 transition-colors ${
      done ? 'border-green-300' : active ? 'border-blue-400' : 'border-gray-200'}`

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* ── 왼쪽: 컨트롤 ── */}
      <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 space-y-3">

        {/* STEP 1 */}
        <div className={stepCard(step1Done)}>
          <div className="flex items-center gap-2 mb-3">
            <div className={stepCircle(step1Done, '1')}>{step1Done ? '✓' : '1'}</div>
            <h3 className="font-semibold text-gray-800 text-sm">지번 입력 (최대 5개)</h3>
          </div>

          {/* 지적도 / 위성사진 토글 */}
          <div className="flex gap-1 mb-3 bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setMapMode('cadastral')}
              className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mapMode === 'cadastral'
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              🗺 지적도
            </button>
            <button
              onClick={() => setMapMode('satellite')}
              className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mapMode === 'satellite'
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              🛰 위성사진
            </button>
          </div>

          {/* 5개 지번 입력 필드 */}
          <div className="space-y-1.5">
            {addresses.map((addr, i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <span
                  className="flex-shrink-0 w-5 h-5 rounded-full text-white text-xs flex items-center justify-center font-bold"
                  style={{ backgroundColor: PARCEL_COLORS[i] }}
                >
                  {i + 1}
                </span>
                <input
                  type="text"
                  value={addr}
                  onChange={e => {
                    const next = [...addresses]
                    next[i] = e.target.value
                    setAddresses(next)
                    setSearchError('')
                  }}
                  onKeyDown={e => e.key === 'Enter' && handleAddressSearch()}
                  placeholder={i === 0 ? '지번 또는 도로명 주소' : `지번 ${i + 1} (선택)`}
                  className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
          </div>

          <button
            onClick={handleAddressSearch}
            disabled={searchLoading || !addresses.some(a => a.trim())}
            className="mt-2.5 w-full py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
          >
            {searchLoading
              ? <>
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  조회 중…
                </>
              : `🔍 ${addresses.filter(a => a.trim()).length}개 지번 검색`
            }
          </button>

          {searchError && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600 whitespace-pre-line">{searchError}</div>
          )}
          {parcelLabel && !searchError && parcels.length > 0 && (
            <div className="mt-2 space-y-1">
              {parcels.map((p, i) => (
                <div key={i} className="bg-green-50 border border-green-200 rounded-lg px-2 py-1.5 text-xs text-green-700 flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                  <span className="truncate">{p.label} — {p.areaSqm.toFixed(0)}m²</span>
                </div>
              ))}
            </div>
          )}
          {satLoading && (
            <div className="mt-1 text-xs text-indigo-500 flex items-center gap-1.5">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              {mapMode === 'cadastral' ? '지적도' : '위성사진'} 타일 로딩 중 (Z{satZoom})...
            </div>
          )}
          {satTiles.length > 0 && !satLoading && (
            <div className="mt-1 text-xs text-indigo-600">
              {mapMode === 'cadastral' ? '🗺 지적도' : '🛰 위성사진'} 오버레이 완료 (Z{satZoom} · 1px={pixelScale.toFixed(3)}m)
            </div>
          )}

          {/* 초기화 버튼 */}
          {isComplete && (
            <button onClick={handleReset}
              className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50">
              초기화
            </button>
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
            {/* 설치 방향 (Item 3) */}
            <div>
              <label className="text-xs text-gray-500 font-medium">설치 방향</label>
              <div className="flex gap-1.5 mt-1">
                <button onClick={() => setPanelOrientation('portrait')}
                  className={`flex-1 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    panelOrientation === 'portrait' ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'}`}>
                  세로형
                </button>
                <button onClick={() => setPanelOrientation('landscape')}
                  className={`flex-1 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    panelOrientation === 'landscape' ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'}`}>
                  가로형
                </button>
              </div>
            </div>

            {/* 배열 방법 + 이격거리 직접 입력 (Item 4) */}
            <div>
              <label className="text-xs text-gray-500 font-medium">배열 방법 (단수)</label>
              <div className="flex gap-1.5 mt-1">
                {([1, 2, 3] as const).map(n => (
                  <button key={n} onClick={() => setRowStack(n)}
                    className={`flex-1 py-1 rounded-lg text-xs font-bold border transition-colors ${
                      rowStack === n ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-gray-600 border-gray-300 hover:border-violet-300'}`}>
                    {n}단
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-500 font-medium">이격 거리 (m)</label>
                <span className="text-xs text-gray-400">이론값: {theoreticalSpacing}m</span>
              </div>
              <input
                type="number"
                min={0.5}
                max={5}
                step={0.1}
                value={spacingValue}
                onChange={e => setSpacingValue(Number(e.target.value))}
                className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
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

        {/* STEP 4 — 결과 */}
        {step5Done && (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border-2 border-blue-300 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-blue-500 text-white">4</div>
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
                {apiSource === 'api' ? `  ·  VWorld ${parcels.length}개 필지` : ''}
                {satTiles.length > 0 ? `  ·  ${mapMode === 'cadastral' ? '지적도' : '위성'}` : ''}
                {`  ·  경계마진 ${BOUNDARY_MARGIN[installType] ?? 2}m`}
              </div>
            </div>
            {/* 수익성 연동 — 정밀분석 결과가 있으면 두 가지 선택 제공 */}
            {svgAnalysisResult && !isMultiZoneResult(svgAnalysisResult) && svgAnalysisResult.layout.totalCount > 0 ? (
              <div className="mt-3 space-y-2">
                <div className="text-xs text-gray-500 text-center">수익성 시뮬레이터에 적용할 수량을 선택하세요</div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => handleSendToRevenue('quick')}
                    className="bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-xs font-semibold transition-colors border border-gray-300">
                    <div className="text-[10px] text-gray-400 mb-0.5">간이분석</div>
                    {panelCount.toLocaleString()}장 · {capacityKwp}kWp
                  </button>
                  <button onClick={() => handleSendToRevenue('precision')}
                    className="bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg text-xs font-semibold transition-colors">
                    <div className="text-[10px] text-blue-200 mb-0.5">정밀분석 ★권장</div>
                    {(editingCount !== null ? editingCount : svgAnalysisResult.layout.totalCount).toLocaleString()}장 · {isEditing && editingCount !== null ? ((editingCount * (svgAnalysisResult.layout.totalKwp / Math.max(1, svgAnalysisResult.layout.totalCount))).toFixed(2)) : svgAnalysisResult.layout.totalKwp}kWp
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => handleSendToRevenue('quick')}
                className="mt-3 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold transition-colors">
                수익성 시뮬레이터로 연동 →
              </button>
            )}
          </div>
        )}

        {/* 기준값 */}
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-3">
          <div className="text-xs font-semibold text-amber-800 mb-1">📌 실제 현장 기준값</div>
          <div className="space-y-0.5 text-xs text-amber-700">
            <div>GS710wp · 경사각 15° · 이격 1.2m</div>
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

          <div className="relative w-full overflow-hidden">
            {/* VWorld 지적도 WMS 타일 — CORS 우회: <img>로 canvas 뒤에 배치 (인접 필지 경계 표시) */}
            {cadImgTiles.map((t, i) => (
              <img key={i} src={t.src} alt=""
                style={{
                  position: 'absolute',
                  left: `${t.cx / CANVAS_W * 100}%`,
                  top: `${t.cy / CANVAS_H * 100}%`,
                  width: `${t.px / CANVAS_W * 100}%`,
                  height: `${t.px / CANVAS_H * 100}%`,
                  zIndex: 0,
                  pointerEvents: 'none',
                }}
              />
            ))}
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H}
              className="relative w-full h-auto border border-gray-200 rounded-lg cursor-default"
              style={{
                zIndex: 1,
                maxHeight: '500px',
                background: cadImgTiles.length > 0 ? 'transparent' : '#f8fafc',
              }}
            />
          </div>

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

        {/* ── SVG 정밀 배치 분석 (API 모드) ── */}
        {isComplete && parcels.length > 0 && (
          <div className="mt-4 bg-white rounded-xl border border-indigo-200 p-4">
            <div className="mb-3">
              <h3 className="font-semibold text-gray-800 text-sm flex items-center gap-1.5">
                🔬 SVG 정밀 배치 분석 <span className="text-xs font-normal text-indigo-500">v5.2</span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                VWorld 필지 경계 · 위도 {effectiveLatitude.toFixed(4)}° · 방위각/경사지/다구역 지원
              </p>
            </div>

            {/* ── 설정 그리드 ── */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              {/* 패널 선택 */}
              <div>
                <label className="text-xs text-gray-500 font-medium">패널 프리셋</label>
                <select
                  value={svgPanelType}
                  onChange={e => setSvgPanelType(e.target.value)}
                  className="mt-1 w-full text-xs border border-gray-300 rounded px-2 py-1.5">
                  {Object.entries(PRESET_PANELS).map(([key, spec]) => (
                    <option key={key} value={key}>{spec.label}</option>
                  ))}
                </select>
              </div>

              {/* 부지 용도 (Item 6: land/roof 2가지로 고정) */}
              <div>
                <label className="text-xs text-gray-500 font-medium">부지 용도</label>
                <select
                  value={svgPlotType}
                  onChange={e => setSvgPlotType(e.target.value as PlotType)}
                  className="mt-1 w-full text-xs border border-gray-300 rounded px-2 py-1.5">
                  <option value="land">토지 (마진 2m)</option>
                  <option value="roof">지붕 (마진 0.5m)</option>
                </select>
              </div>

              {/* 패널 방향 (세로형/가로형) */}
              <div className="col-span-2">
                <label className="text-xs text-gray-500 font-medium block mb-1">패널 방향</label>
                <div className="flex gap-1.5">
                  {(['portrait', 'landscape'] as const).map(ori => (
                    <button key={ori} onClick={() => setSvgPanelOrientation(ori)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        svgPanelOrientation === ori
                          ? 'bg-indigo-500 text-white border-indigo-500'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-300'}`}>
                      {ori === 'portrait' ? '세로형 (기본)' : '가로형'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 방위각 슬라이더 */}
              <div className="col-span-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-gray-500 font-medium">방위각</label>
                  <span className="text-xs font-bold text-indigo-600">
                    {svgAzimuthDeg}°
                    {svgAzimuthDeg === 180 ? ' (정남향)' : svgAzimuthDeg < 180 ? ' (남동향)' : ' (남서향)'}
                  </span>
                </div>
                <input
                  type="range" min={145} max={215} value={svgAzimuthDeg}
                  onChange={e => setSvgAzimuthDeg(Number(e.target.value))}
                  className="mt-1 w-full" />
                <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                  <span>145° (남동)</span><span>180° (정남)</span><span>215° (남서)</span>
                </div>
                {Math.abs(svgAzimuthDeg - 180) > 25 && (
                  <div className="mt-1 text-xs text-amber-600 bg-amber-50 rounded px-2 py-1">
                    ⚠ 편차 {Math.abs(svgAzimuthDeg - 180)}° — 발전량 약 {(100 - Math.cos((svgAzimuthDeg - 180) * Math.PI / 180) * 100).toFixed(1)}% 감소 (실증 Case 3 기준)
                  </div>
                )}
              </div>

              {/* 구역 모드 */}
              <div className="col-span-2">
                <label className="text-xs text-gray-500 font-medium block mb-1">배치 모드</label>
                <div className="flex gap-2">
                  {(['single', 'multi'] as const).map(mode => (
                    <label key={mode} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" value={mode}
                        checked={svgZoneMode === mode}
                        onChange={() => setSvgZoneMode(mode)}
                        className="accent-indigo-500" />
                      <span className="text-xs text-gray-700">
                        {mode === 'single' ? '단일 구역' : '다구역 자동 분할'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* 실행 버튼 */}
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  if (!apiCoords || parcels.length === 0) return
                  setSvgAnalyzing(true)
                  try {
                    const panelSpec = PRESET_PANELS[svgPanelType] ?? PRESET_PANELS.GS710wp
                    const lat = effectiveLatitude

                    // 모든 필지 → 로컬 좌표계 변환 (Item 13: 복수 필지 버그 수정)
                    const allPolygons = parcels
                      .map(p => convertGeoRingToLocalPolygon(p.ring, apiCoords.lat, apiCoords.lon))
                      .filter(p => p.length >= 3)

                    if (allPolygons.length === 0) return

                    const commonOpts = {
                      azimuthDeg: svgAzimuthDeg,
                      slopeAngleDeg: 0,
                      slopeAzimuthDeg: 180,
                      isJimokChangePlanned: false,
                      panelOrientation: svgPanelOrientation,
                    }

                    if (allPolygons.length > 1) {
                      // 복수 필지: 각 필지를 별도 구역으로 분석
                      const zones: ZoneConfig[] = allPolygons.map((poly, i) => ({
                        label: `필지${i + 1}`,
                        polygon: poly,
                        plotType: svgPlotType,
                        panelSpec,
                        panelType: svgPanelType,
                        ...commonOpts,
                      }))
                      const mzResult = runMultiZoneAnalysis(zones, lat)
                      setSvgAnalysisResult(mzResult)
                      setLastFullAnalysisJson(JSON.stringify(mzResult))
                      setIsEditing(false)
                    } else {
                      const polygon = allPolygons[0]
                      if (svgZoneMode === 'multi') {
                        const mzResult = runMultiZoneAnalysis(autoSplitPolygon(polygon, panelSpec, svgPlotType, svgPanelType, commonOpts), lat)
                        setSvgAnalysisResult(mzResult)
                        setLastFullAnalysisJson(JSON.stringify(mzResult))
                        setIsEditing(false)
                      } else {
                        const faResult = runFullAnalysis({
                          cadastrePolygon: polygon,
                          plotType: svgPlotType,
                          panelSpec,
                          panelType: svgPanelType,
                          latitude: lat,
                          ...commonOpts,
                        })
                        setSvgAnalysisResult(faResult)
                        setLastFullAnalysisJson(JSON.stringify(faResult))
                        setIsEditing(true)
                      }
                    }
                    setShowSvgCanvas(true)
                  } catch (err) {
                    console.error('SVG 분석 오류:', err)
                  } finally {
                    setSvgAnalyzing(false)
                  }
                }}
                disabled={svgAnalyzing}
                className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors">
                {svgAnalyzing ? '분석 중...' : '정밀 분석 실행'}
              </button>
              {svgAnalysisResult && (
                <button
                  onClick={() => setShowSvgCanvas(v => !v)}
                  className="px-3 py-2 border border-indigo-300 text-indigo-600 text-xs rounded-lg hover:bg-indigo-50">
                  {showSvgCanvas ? '숨기기' : '결과 보기'}
                </button>
              )}
            </div>

            {/* 결과 표시 */}
            {showSvgCanvas && svgAnalysisResult && (
              <div className="mt-3">
                {/* 편집 토글 버튼 (단일 구역만) */}
                {!isMultiZoneResult(svgAnalysisResult) && (
                  <div className="flex justify-end mb-2">
                    <button
                      onClick={() => setIsEditing(v => !v)}
                      className={[
                        'px-3 py-1.5 rounded text-xs font-semibold transition-colors',
                        isEditing
                          ? 'bg-amber-500 text-slate-900 hover:bg-amber-400'
                          : 'bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-500',
                      ].join(' ')}
                    >
                      {isEditing ? '✏ 편집 중' : '✏ 배치 편집'}
                    </button>
                  </div>
                )}

                {/* 편집 모드 */}
                {isEditing && !isMultiZoneResult(svgAnalysisResult) ? (
                  <LayoutEditor
                    result={svgAnalysisResult as FullAnalysisResult}
                    width={920}
                    height={520}
                    onCountChange={(count) => setEditingCount(count)}
                    onComplete={(placements, totalKwp) => {
                      setIsEditing(false)
                      setEditingCount(null)
                      // 편집 완료: 패널 수/용량 반영 (분석 결과에 통합)
                      setSvgAnalysisResult(prev => {
                        if (!prev || isMultiZoneResult(prev)) return prev
                        return {
                          ...prev,
                          layout: {
                            ...prev.layout,
                            placements,
                            totalCount: placements.length,
                            totalKwp,
                            coverageRatio: prev.layout.coverageRatio,
                            theoreticalMax: prev.layout.theoreticalMax,
                            utilizationRate: placements.length / (prev.layout.theoreticalMax || 1),
                          },
                        }
                      })
                    }}
                    onCancel={() => { setIsEditing(false); setEditingCount(null) }}
                  />
                ) : (
                  <div>
                    <SolarLayoutCanvas
                      result={svgAnalysisResult}
                      width={700}
                      height={480}
                      showLabels
                    />
                    {/* 단일 구역 — 검증 결과 */}
                    {!isMultiZoneResult(svgAnalysisResult) && svgAnalysisResult.validation && (
                      <div className={`mt-2 text-xs rounded px-3 py-2 ${
                        svgAnalysisResult.validation.isValid
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}>
                        {svgAnalysisResult.validation.isValid ? '✓ ' : '⚠ '}
                        {svgAnalysisResult.validation.message}
                      </div>
                    )}
                    {/* 다구역 — 요약 */}
                    {isMultiZoneResult(svgAnalysisResult) && (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        {(svgAnalysisResult as MultiZoneResult).zones.map(z => (
                          <div key={z.zoneLabel} className="bg-indigo-50 rounded p-2 text-xs">
                            <div className="font-semibold text-indigo-700">{z.zoneLabel}</div>
                            <div className="text-gray-600">{z.layout.totalCount}장 · {z.layout.totalKwp}kWp</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* SafeZone 오류 */}
                    {!isMultiZoneResult(svgAnalysisResult) && svgAnalysisResult.safeZone.error && (
                      <p className="text-xs text-red-500 mt-2">
                        ⚠ {svgAnalysisResult.safeZone.error}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
