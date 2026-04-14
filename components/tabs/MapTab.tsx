'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useSolarStore } from '@/store/useStore'
import { MODULES, GENERATION_HOURS } from '@/lib/constants'
import { getSolarElevation } from '@/lib/shadowCalculator'
import { runFullAnalysis, type FullAnalysisResult, type PlotType } from '@/lib/layoutEngine'
import { convertGeoRingToLocalPolygon } from '@/lib/cadastre'
import PANEL_TYPES, { PRESET_PANELS } from '@/lib/panelConfig'
import { type MultiZoneResult, runMultiZoneAnalysis, autoSplitPolygon, isMultiZoneResult } from '@/lib/multiZoneLayout'

// SVG 캔버스는 클라이언트 전용
const SolarLayoutCanvas = dynamic(
  () => import('@/components/SolarLayoutCanvas'),
  { ssr: false }
)

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

// 지번별 색상 (최대 5개 필지)
const PARCEL_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444'] as const

// 설치 유형별 경계 마진 (미터)
const BOUNDARY_MARGIN: Record<string, number> = {
  '건물지붕형': 0.5,
  '일반토지형': 2.0,
  '영농형농지': 2.0,
  '임야형': 2.0,
  '수상형': 2.0,
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

// ── Ramer-Douglas-Peucker 폴리곤 단순화 ───────────────────────────
function rdpSimplify(pts: Point[], epsilon: number): Point[] {
  if (pts.length <= 2) return pts
  const first = pts[0], last = pts[pts.length - 1]
  const dx = last.x - first.x, dy = last.y - first.y
  const len = Math.sqrt(dx * dx + dy * dy)
  let maxDist = 0, maxIdx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len > 0
      ? Math.abs(dy * pts[i].x - dx * pts[i].y + last.x * first.y - last.y * first.x) / len
      : Math.sqrt((pts[i].x - first.x) ** 2 + (pts[i].y - first.y) ** 2)
    if (d > maxDist) { maxDist = d; maxIdx = i }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(pts.slice(0, maxIdx + 1), epsilon)
    const right = rdpSimplify(pts.slice(maxIdx), epsilon)
    return [...left.slice(0, -1), ...right]
  }
  return [first, last]
}

// ── vworld 스크린샷 주황 경계선 감지 → 복수 폴리곤 (외곽 + 제외구역) ─
function detectAllOrangeBoundaries(
  imageData: ImageData
): { rawPts: Point[]; cx: number; cy: number; pixelCount: number }[] {
  const { data, width, height } = imageData

  // ① 주황 픽셀 마킹
  const isOrange = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      if (a > 100 && r > 170 && r > g * 1.35 && b < 110 && g < 175)
        isOrange[y * width + x] = 1
    }
  }

  // ② 팽창(dilation) 2px — 같은 경계의 픽셀을 하나의 컴포넌트로 묶음
  const dilated = new Uint8Array(width * height)
  const DR = 2
  for (let y = DR; y < height - DR; y++) {
    for (let x = DR; x < width - DR; x++) {
      if (!isOrange[y * width + x]) continue
      for (let dy = -DR; dy <= DR; dy++)
        for (let dx = -DR; dx <= DR; dx++)
          dilated[(y + dy) * width + (x + dx)] = 1
    }
  }

  // ③ BFS로 연결 컴포넌트 추출 (4-연결)
  const visited = new Uint8Array(width * height)
  const components: number[][] = []
  for (let i = 0; i < width * height; i++) {
    if (!dilated[i] || visited[i]) continue
    const comp: number[] = []
    const stack = [i]
    visited[i] = 1
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (const nb of [cur - 1, cur + 1, cur - width, cur + width]) {
        if (nb >= 0 && nb < width * height && dilated[nb] && !visited[nb]) {
          visited[nb] = 1; stack.push(nb)
        }
      }
    }
    if (comp.length > 30) components.push(comp)
  }
  if (components.length === 0) return []

  // ④ 각 컴포넌트에서 원본 주황 픽셀만 추려 각도 스윕 → RDP 폴리곤
  const results = components.map(comp => {
    const orangeInComp = comp.filter(idx => isOrange[idx])
    if (orangeInComp.length < 20) return null
    const pts = orangeInComp.map(idx => ({ x: idx % width, y: Math.floor(idx / width) }))
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const STEPS = 360
    const maxR = Math.sqrt(width * width + height * height)
    const sweep: Point[] = []
    for (let i = 0; i < STEPS; i++) {
      const angle = (i / STEPS) * 2 * Math.PI
      const cosA = Math.cos(angle), sinA = Math.sin(angle)
      let last: Point | null = null
      for (let r = 2; r < maxR; r += 0.8) {
        const px = Math.round(cx + cosA * r), py = Math.round(cy + sinA * r)
        if (px < 0 || px >= width || py < 0 || py >= height) break
        if (isOrange[py * width + px]) last = { x: px, y: py }
      }
      if (last) sweep.push(last)
    }
    if (sweep.length < 10) return null
    const rawPts = rdpSimplify([...sweep, sweep[0]], 3.5).slice(0, -1)
    return { rawPts, cx, cy, pixelCount: orangeInComp.length }
  }).filter(Boolean) as { rawPts: Point[]; cx: number; cy: number; pixelCount: number }[]

  // 픽셀 수 내림차순 정렬 (첫 번째 = 외곽 경계, 나머지 = 제외구역)
  results.sort((a, b) => b.pixelCount - a.pixelCount)
  return results
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
  const { setMapResult, setActiveTab, setKierPvHours, setKierGhi, setLocationCoords } = useSolarStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobUrlsRef = useRef<string[]>([]) // cleanup용

  // ── 입력 ──
  const [addresses, setAddresses] = useState<string[]>(['', '', '', '', ''])
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
  const [mousePos, setMousePos] = useState<Point | null>(null)   // 미리보기 선용

  // ── 위성/지적도 오버레이 ──
  const [satTiles, setSatTiles] = useState<SatTile[]>([])
  const [satLoading, setSatLoading] = useState(false)
  const [satZoom, setSatZoom] = useState(0)
  const [mapMode, setMapMode] = useState<'satellite' | 'cadastral'>('satellite')
  // vworld 스크린샷 해상도 보정 계수 (기본 1.0, 사용자 조정)
  const [screenshotScaleCorr, setScreenshotScaleCorr] = useState(1.0)

  // ── 복수 필지 ──
  const [parcels, setParcels] = useState<ParcelInfo[]>([])

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

  // ── vworld 스크린샷 드롭 ──
  const [screenshotImg, setScreenshotImg] = useState<HTMLImageElement | null>(null)
  const [screenshotZoom, setScreenshotZoom] = useState(18)
  const [screenshotAnalyzing, setScreenshotAnalyzing] = useState(false)
  const [screenshotError, setScreenshotError] = useState('')
  const [screenshotCentroid, setScreenshotCentroid] = useState<Point | null>(null)
  const [screenshotRawPts, setScreenshotRawPts] = useState<Point[] | null>(null)
  const [screenshotRawHoles, setScreenshotRawHoles] = useState<{ rawPts: Point[]; cx: number; cy: number }[]>([])
  const [holePolygons, setHolePolygons] = useState<Point[][]>([])

  // SVG 정밀 배치 분석 상태
  const [svgAnalysisResult, setSvgAnalysisResult] = useState<FullAnalysisResult | MultiZoneResult | null>(null)
  const [svgAnalyzing, setSvgAnalyzing] = useState(false)
  const [svgPanelType, setSvgPanelType] = useState<string>('TYPE_A')
  const [svgPlotType, setSvgPlotType] = useState<PlotType>('land')
  const [showSvgCanvas, setShowSvgCanvas] = useState(false)
  // v5.2 추가 입력
  const [svgAzimuthDeg, setSvgAzimuthDeg] = useState(180)
  const [svgHasSlope, setSvgHasSlope] = useState(false)
  const [svgSlopeAngle, setSvgSlopeAngle] = useState(5)
  const [svgSlopeAzimuth, setSvgSlopeAzimuth] = useState(180)
  const [svgHasRiver, setSvgHasRiver] = useState(false)
  const [svgHasRoad, setSvgHasRoad] = useState(false)
  const [svgJimokChangePlanned, setSvgJimokChangePlanned] = useState(false)
  const [svgZoneMode, setSvgZoneMode] = useState<'single' | 'multi'>('single')

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


  // ── 패널 배치 (Point-in-Polygon 그리드, 경계 마진 적용) ──
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

      // 설치 유형별 경계 마진 (미터 → 픽셀)
      const marginM = BOUNDARY_MARGIN[installType] ?? 2.0
      const marginPx = marginM / scale

      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))
      const rects: PanelRect[] = []
      for (let y = minY + marginPx; y + panelPxH <= maxY - marginPx; y += rowPitch) {
        for (let x = minX + marginPx; x + panelPxW <= maxX - marginPx; x += panelPxW + 2) {
          const cx = x + panelPxW / 2, cy = y + panelPxH / 2
          // ① 패널 4변이 폴리곤 경계를 가로지르면 즉시 제외 (오목 폴리곤 대응)
          if (panelCrossesBoundary(x, y, panelPxW, panelPxH, pts)) continue
          // ② 패널 4 꼭짓점 + 4변 중점 모두 폴리곤 안쪽 & marginPx 이상 이격
          const checkPts = [
            { x, y }, { x: x + panelPxW, y },
            { x, y: y + panelPxH }, { x: x + panelPxW, y: y + panelPxH },
            { x: x + panelPxW / 2, y }, { x: x + panelPxW / 2, y: y + panelPxH },
            { x, y: y + panelPxH / 2 }, { x: x + panelPxW, y: y + panelPxH / 2 },
          ]
          if (checkPts.every(c =>
                isPointInPolygon(c.x, c.y, pts) &&
                minDistToPolygonEdge(c.x, c.y, pts) >= marginPx) &&
              !holePolygons.some(hole => isPointInPolygon(cx, cy, hole)))
            rects.push({ x, y, w: panelPxW, h: panelPxH })
        }
      }
      let finalRects = rects
      let warn = false

      // ── 면적 기반 패널 수 계산 ──
      // 경계 마진을 고려한 유효 면적 보정 (둘레 × 마진)
      const perimeterPx = pts.reduce((sum, p, i) => {
        const j = (i + 1) % pts.length
        return sum + Math.sqrt((pts[j].x - p.x) ** 2 + (pts[j].y - p.y) ** 2)
      }, 0)
      const perimeterM = perimeterPx * scale
      const effectiveAreaSqm = Math.max(0, areaSqm - perimeterM * marginM)
      const footprintPerPanel = module.w * (module.h * Math.cos(ltr) + spacingValue)
      const coverageRatio = isBuilding ? 0.70 : 0.85
      let count: number
      if (areaSqm > 10) {
        count = Math.floor(effectiveAreaSqm * slopeFactor * coverageRatio / footprintPerPanel)
      } else {
        count = finalRects.length
      }

      if (isBuilding) {
        const limit = LOAD_LIMITS[structureType]
        if (limit !== null) {
          const maxP = Math.floor((areaSqm * slopeFactor * limit) / 25)
          if (count > maxP) count = maxP
          if (finalRects.length > maxP) finalRects = rects.slice(0, maxP)
          warn = structureType === '샌드위치 패널'
        }
      }
      setStructureWarning(warn)
      const cap = (count * module.watt) / 1000
      const ann = cap * GENERATION_HOURS * 365
      setPanelRects(finalRects)
      setPanelCount(count)
      setCapacityKwp(Math.round(cap * 100) / 100)
      setAnnualKwh(Math.round(ann))
    },
    [moduleIndex, installType, tiltAngle, spacingValue, slopePercent, structureType, holePolygons]
  )

  // ── 타일 로드 공통 함수 ──
  const loadTiles = useCallback(async (
    cLon: number, cLat: number, z: number, scale: number, mode: 'satellite' | 'cadastral'
  ) => {
    setSatLoading(true)
    setSatTiles([])
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []

    const { tx: ctX, ty: ctY } = lonLatToTile(cLon, cLat, z)
    const tileMeter = tilePixelScaleM(cLat, z) * 256
    const tilePx = tileMeter / scale

    const R = 2
    const jobs: Promise<SatTile | null>[] = []
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = ctX + dx, ty = ctY + dy
        jobs.push((async () => {
          try {
            const origin = tileOriginLonLat(tx, ty, z)
            const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
            let tileUrl: string
            if (mode === 'cadastral') {
              // VWorld LP (연속지적도) — 서버 프록시 경유 (API키 필요)
              tileUrl = `/api/vworld?type=cadtile&z=${z}&x=${tx}&y=${ty}`
            } else {
              // ArcGIS World Imagery — CORS 허용, 직접 로드
              tileUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`
            }
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

  // ── 위성 타일 로드 (하위 호환) ──
  const loadSatelliteTiles = useCallback(async (
    cLon: number, cLat: number, z: number, scale: number
  ) => {
    return loadTiles(cLon, cLat, z, scale, 'satellite')
  }, [loadTiles])

  // ── Canvas 렌더링 ──
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

    // ❶ 배경: 위성사진 / vworld 스크린샷 / 기본 그리드
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
    } else if (screenshotImg && screenshotCentroid) {
      // vworld 스크린샷 배경 — 이미지 중심(경계 centroid)을 Canvas 중앙에 정렬
      const lat37Rad = 37 * Math.PI / 180
      const imgMPerPx = 40075016.686 * Math.cos(lat37Rad) / (256 * Math.pow(2, screenshotZoom))
      const sf = imgMPerPx / pixelScale  // 이미지px → Canvas px 비율
      const dw = screenshotImg.naturalWidth * sf
      const dh = screenshotImg.naturalHeight * sf
      const dx = CANVAS_W / 2 - screenshotCentroid.x * sf
      const dy = CANVAS_H / 2 - screenshotCentroid.y * sf
      ctx.drawImage(screenshotImg, dx, dy, dw, dh)
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
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

    const hasParcelData = parcels.length > 0
    const hasManualPoints = points.length > 0 && !hasParcelData

    if (!hasParcelData && points.length === 0) {
      ctx.fillStyle = satTiles.length > 0 ? 'rgba(255,255,255,0.85)' : '#94a3b8'
      ctx.font = '14px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText('지번을 검색하거나 직접 부지 경계를 그려주세요', CANVAS_W / 2, CANVAS_H / 2 - 12)
      ctx.fillText('(더블클릭으로 완료)', CANVAS_W / 2, CANVAS_H / 2 + 12)
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(`축척: 1px = ${pixelScale.toFixed(3)}m`, 8, CANVAS_H - 8)
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

    // ❷-단독 필지 경계 폴리곤 (수동 드로잉)
    if (hasManualPoints) {
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
    }

    // ❷-c 마진 정보 표시 (경계선 우상단 배지)
    if (isComplete && points.length >= 3) {
      const marginM = BOUNDARY_MARGIN[installType] ?? 2.0
      const badge = `경계마진 ${marginM}m`
      ctx.font = 'bold 10px sans-serif'
      const bw = ctx.measureText(badge).width + 12
      ctx.fillStyle = 'rgba(251,146,60,0.90)'
      ctx.fillRect(CANVAS_W - bw - 4, 32, bw, 18)
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
      ctx.fillText(badge, CANVAS_W - bw / 2 - 4, 44)
    }

    // ❷-b 제외구역 (hole) — 빨간 점선
    holePolygons.forEach(hole => {
      if (hole.length < 3) return
      ctx.beginPath()
      ctx.moveTo(hole[0].x, hole[0].y)
      hole.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
      ctx.closePath()
      ctx.fillStyle = 'rgba(239,68,68,0.12)'
      ctx.fill()
      ctx.setLineDash([5, 3])
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
      // 중심 레이블
      const hcx = hole.reduce((s, p) => s + p.x, 0) / hole.length
      const hcy = hole.reduce((s, p) => s + p.y, 0) / hole.length
      ctx.fillStyle = 'rgba(239,68,68,0.85)'
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText('제외', hcx, hcy + 4)
    })

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

    // ❺-b 수동 드로잉 미리보기 선 (마우스 추적)
    if (drawMode && points.length > 0 && mousePos && !isComplete) {
      const last = points[points.length - 1]
      // 현재 그릴 선 (점선)
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(mousePos.x, mousePos.y); ctx.stroke()
      // 첫 점까지의 닫는 선 (반투명)
      if (points.length >= 2) {
        ctx.setLineDash([3, 5])
        ctx.strokeStyle = 'rgba(245,158,11,0.4)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(mousePos.x, mousePos.y); ctx.lineTo(points[0].x, points[0].y); ctx.stroke()
      }
      ctx.setLineDash([])

      // 마우스 위치에 실시간 면적 표시
      if (points.length >= 2) {
        const previewPts = [...points, mousePos]
        let sho = 0
        for (let i = 0; i < previewPts.length; i++) {
          const j = (i + 1) % previewPts.length
          sho += previewPts[i].x * previewPts[j].y - previewPts[j].x * previewPts[i].y
        }
        const previewArea = Math.abs(sho / 2) * pixelScale * pixelScale
        const areaLabel = previewArea >= 10000
          ? `${(previewArea / 10000).toFixed(2)}ha`
          : `${previewArea.toFixed(0)}m²`
        ctx.font = 'bold 11px sans-serif'
        const tw = ctx.measureText(areaLabel).width
        const bx = mousePos.x + 10, by = mousePos.y - 8
        ctx.fillStyle = 'rgba(245,158,11,0.9)'
        ctx.fillRect(bx - 4, by - 13, tw + 8, 18)
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'
        ctx.fillText(areaLabel, bx, by)
      }
      // 현재 마우스 위치 점
      ctx.beginPath(); ctx.arc(mousePos.x, mousePos.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#f59e0b'; ctx.fill()
    }

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

    // ❼ 축척 텍스트 (왼쪽 하단)
    const scaleLabel = satZoom > 0
      ? `축척 Z${satZoom}: 1px = ${pixelScale.toFixed(3)}m  (지도=CAD 일치)`
      : `축척: 1px = ${pixelScale.toFixed(3)}m`
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

    // ❼-b 시각적 축척바 (오른쪽 하단) — 지도·CAD 축척 일치 검증용
    {
      const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500]
      const targetBarPx = 80
      const barM = candidates.find(m => m / pixelScale >= targetBarPx) ?? 500
      const rawBarPx = barM / pixelScale
      const dispPx = Math.min(rawBarPx, CANVAS_W * 0.28)
      const barX = CANVAS_W - dispPx - 16
      const barY = CANVAS_H - 10
      const onMap = satTiles.length > 0 || (screenshotImg !== null)
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

    // ❽ VWorld 배지
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
  }, [points, isComplete, area, panelRects, spacingValue, panelCount,
      pixelScale, apiSource, satTiles, satZoom,
      screenshotImg, screenshotCentroid, screenshotZoom, holePolygons,
      parcels, mapMode, drawMode, mousePos, installType])

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

    // 1차: VWorld 검색 API (기존 키 재사용, 지번/도로명 모두 지원)
    try {
      const vwSRes = await fetch(`/api/vworld?type=search&query=${encodeURIComponent(q)}`)
      const vwSData = await vwSRes.json()
      if (vwSRes.ok && vwSData?.response?.status === 'OK') {
        const item = vwSData?.response?.result?.items?.[0]
        const point = item?.point
        if (point) {
          const lon = parseFloat(point.x)
          const lat = parseFloat(point.y)
          if (!isNaN(lon) && !isNaN(lat)) return { lon, lat, source: 'vworld-search' }
        }
      }
      errors.push('VWorld검색: ' + (vwSData?.response?.status ?? `HTTP ${vwSRes.status}`))
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

    // 3차: Naver Geocoding API
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

    // 4차: VWorld 주소→좌표 (구형)
    try {
      const vwRes = await fetch(`/api/vworld?type=coord&address=${encodeURIComponent(q)}`)
      const vwData = await vwRes.json()
      if (vwRes.ok && !vwData?.error) {
        const point = vwData?.response?.result?.point
        if (point) return { lon: parseFloat(point.x), lat: parseFloat(point.y), source: 'vworld' }
      }
      errors.push('VWorld: ' + (vwData?.error ?? `HTTP ${vwRes.status}`))
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
      const parcelRes = await fetch(`/api/vworld?type=parcel&lon=${lon}&lat=${lat}`)
      const parcelData = await parcelRes.json()
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
    setPoints([]); setArea(0); setPanelRects([]); setPanelCount(0)
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
        // 경계 없음 — 첫 번째 좌표로 위성 로드 후 수동 드로우 안내
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
        setSearchError('필지 경계를 불러올 수 없습니다.\n"직접 그리기"로 부지를 표시해 주세요.')
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
      setDrawMode(false)
      setApiSource('api')

      // 첫 번째 필지 기준으로 KIER·경사도·방위각
      const first = converted[0]
      setAutoAzimuth(calcAutoAzimuth(first.canvasPoints))
      setLocationCoords({ lat: first.lat, lon: first.lon })
      setApiCoords({ lat: first.lat, lon: first.lon })
      setParcelLabel(converted.map(p => p.label).join(' · '))

      // 각 필지별 패널 계산 후 합산
      let totalPanelRects: PanelRect[] = []
      let totalCount = 0
      for (const parcel of converted) {
        const module = MODULES[moduleIndex]
        const isBuilding = installType === '건물지붕형'
        const slopeFactor = Math.cos(Math.atan(slopePercent / 100))
        const ltr = (tiltAngle * Math.PI) / 180
        const panelPxW = module.w / scale
        const panelPxH = (module.h * Math.cos(ltr)) / scale
        const rowPitch = panelPxH + spacingValue / scale
        const marginM = BOUNDARY_MARGIN[installType] ?? 2.0
        const marginPx = marginM / scale
        const pts = parcel.canvasPoints
        const minX = Math.min(...pts.map(p => p.x))
        const maxX = Math.max(...pts.map(p => p.x))
        const minY = Math.min(...pts.map(p => p.y))
        const maxY = Math.max(...pts.map(p => p.y))
        const rects: PanelRect[] = []
        for (let y = minY + marginPx; y + panelPxH <= maxY - marginPx; y += rowPitch) {
          for (let x = minX + marginPx; x + panelPxW <= maxX - marginPx; x += panelPxW + 2) {
            // ① 선분 교차 체크 (오목 폴리곤 대응)
            if (panelCrossesBoundary(x, y, panelPxW, panelPxH, pts)) continue
            // ② 4 꼭짓점 + 4변 중점 모두 경계 안쪽 & marginPx 이상
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
        // 면적 기반 카운트
        const perimeterPx = pts.reduce((sum, p, i) => {
          const j = (i + 1) % pts.length
          return sum + Math.sqrt((pts[j].x - p.x) ** 2 + (pts[j].y - p.y) ** 2)
        }, 0)
        const effectiveArea = Math.max(0, parcel.areaSqm - perimeterPx * scale * marginM)
        const footprintPerPanel = module.w * (module.h * Math.cos(ltr) + spacingValue)
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

      loadTiles(cLon, cLat, z, scale, mapMode)
      fetchKierData(first.lat, first.lon, tiltAngle)
      fetchSlope(first.lon, first.lat)

    } catch (e) {
      setSearchError('검색 중 오류가 발생했습니다: ' + String(e))
    } finally {
      setSearchLoading(false)
    }
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

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawMode || isComplete) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    setMousePos({
      x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
      y: (e.clientY - rect.top) * (CANVAS_H / rect.height),
    })
  }

  const handleCanvasMouseLeave = () => setMousePos(null)

  const handleCanvasDblClick = () => {
    if (points.length >= 3) {
      let sho = 0
      for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length
        sho += points[i].x * points[j].y - points[j].x * points[i].y
      }
      const manualArea = Math.abs(sho / 2) * pixelScale * pixelScale
      setArea(manualArea)
      setIsComplete(true)
      setDrawMode(false)
      setMousePos(null)
    }
  }

  // 마지막 꼭짓점 실행취소
  const handleUndoPoint = () => {
    if (!drawMode || points.length === 0) return
    setPoints(prev => prev.slice(0, -1))
  }

  const handleStartDraw = () => {
    setPoints([]); setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false)
    setDrawMode(true); setApiSource('manual'); setParcelLabel('')
    setSearchError('')
    // 위성 타일이 로드된 경우 pixelScale 유지 (배경 위에서 정확한 면적 계산 보장)
    if (satTiles.length === 0) setPixelScale(0.1)
    setKierResult(null); setApiCoords(null); setAutoAzimuth(null)
  }

  const handleReset = () => {
    setPoints([]); setArea(0); setPanelRects([]); setPanelCount(0)
    setCapacityKwp(0); setAnnualKwh(0); setIsComplete(false); setDrawMode(false)
    setApiSource('none'); setParcelLabel(''); setSearchError('')
    setPixelScale(0.1); setSatTiles([]); setSatZoom(0)
    setKierResult(null); setApiCoords(null); setAutoAzimuth(null)
    setKierPvHours(null); setKierGhi(null); setLocationCoords(null)
    // 복수 필지 초기화
    setParcels([])
    // 스크린샷 초기화
    setScreenshotImg(null); setScreenshotCentroid(null); setScreenshotRawPts(null)
    setScreenshotRawHoles([]); setHolePolygons([])
    setScreenshotError(''); setScreenshotAnalyzing(false)
    setScreenshotScaleCorr(1.0)
  }

  // ── 스크린샷 rawPts/zoom/보정계수 변경 시 Canvas 좌표 재계산 ──────
  useEffect(() => {
    if (!screenshotRawPts || !screenshotCentroid) return
    // vworld 화면 픽셀 실측 기반 스케일 (드롭다운 표시값 사용)
    // 이론 타일 스케일(0.119) 대신 실제 화면 해상도에 맞는 값 사용
    // 줌 20 = 0.15m/px, 줌 19 = 0.30, 줌 18 = 0.60, 줌 17 = 1.20, 줌 16 = 2.40
    const VWORLD_BASE_SCALE = 0.15 // zoom 20 기준 vworld 화면 픽셀 스케일 (m/px)
    const imgMPerPx = VWORLD_BASE_SCALE * Math.pow(2, 20 - screenshotZoom) * screenshotScaleCorr
    const minX = Math.min(...screenshotRawPts.map(p => p.x))
    const maxX = Math.max(...screenshotRawPts.map(p => p.x))
    const minY = Math.min(...screenshotRawPts.map(p => p.y))
    const maxY = Math.max(...screenshotRawPts.map(p => p.y))
    const extentPx = Math.max(maxX - minX, maxY - minY, 10)
    const canvScale = (extentPx * imgMPerPx) / (Math.min(CANVAS_W, CANVAS_H) * 0.62)
    const sf = imgMPerPx / canvScale
    const canvasPoints: Point[] = screenshotRawPts.map(p => ({
      x: CANVAS_W / 2 + (p.x - screenshotCentroid.x) * sf,
      y: CANVAS_H / 2 + (p.y - screenshotCentroid.y) * sf,
    }))
    // 넓이 (쇼레이스 공식)
    let sho = 0
    for (let i = 0; i < canvasPoints.length; i++) {
      const j = (i + 1) % canvasPoints.length
      sho += canvasPoints[i].x * canvasPoints[j].y - canvasPoints[j].x * canvasPoints[i].y
    }
    const areaSqm = Math.abs(sho / 2) * canvScale * canvScale
    // hole 폴리곤도 같은 sf/centroid 기준으로 변환
    const mappedHoles = screenshotRawHoles.map(h =>
      h.rawPts.map(p => ({
        x: CANVAS_W / 2 + (p.x - screenshotCentroid.x) * sf,
        y: CANVAS_H / 2 + (p.y - screenshotCentroid.y) * sf,
      }))
    )
    setHolePolygons(mappedHoles)
    setPixelScale(canvScale)
    setPoints(canvasPoints)
    setArea(areaSqm)
    setIsComplete(true)
    setDrawMode(false)
    setApiSource('manual')
    calcPanelsFromPolygon(canvasPoints, areaSqm, canvScale)
  }, [screenshotRawPts, screenshotCentroid, screenshotZoom, screenshotScaleCorr, screenshotRawHoles, calcPanelsFromPolygon])

  // ── vworld 스크린샷 분석 ──────────────────────────────────────────
  const analyzeScreenshot = useCallback((img: HTMLImageElement) => {
    setScreenshotAnalyzing(true)
    setScreenshotError('')
    // 오프스크린 Canvas로 픽셀 데이터 추출
    const off = document.createElement('canvas')
    off.width = img.naturalWidth
    off.height = img.naturalHeight
    const offCtx = off.getContext('2d')
    if (!offCtx) { setScreenshotAnalyzing(false); return }
    offCtx.drawImage(img, 0, 0)
    const imgData = offCtx.getImageData(0, 0, off.width, off.height)
    const results = detectAllOrangeBoundaries(imgData)
    setScreenshotAnalyzing(false)
    if (!results.length) {
      setScreenshotError('주황색 경계선을 감지하지 못했습니다. vworld에서 주황색 경계가 그려진 화면을 스크린샷 해주세요.')
      return
    }
    // 첫 번째 = 외곽 경계, 나머지 = 제외구역
    setScreenshotCentroid({ x: results[0].cx, y: results[0].cy })
    setScreenshotRawPts(results[0].rawPts)
    setScreenshotRawHoles(results.slice(1).map(r => ({ rawPts: r.rawPts, cx: r.cx, cy: r.cy })))
  }, [])

  // ── 파일 드롭 / 선택 핸들러 ──────────────────────────────────────
  const handleDropFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setScreenshotImg(img)
      analyzeScreenshot(img)
    }
    img.onerror = () => {
      setScreenshotError('이미지를 불러올 수 없습니다.')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }, [analyzeScreenshot])

  // Ctrl+V 클립보드 이미지 붙여넣기 감지
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imgItem = items.find(it => it.type.startsWith('image/'))
      if (!imgItem) return
      e.preventDefault()
      const file = imgItem.getAsFile()
      if (file) handleDropFile(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [handleDropFile])

  const handleSendToRevenue = () => {
    const addressLabel = addresses.filter(Boolean).join(', ')
    setMapResult({ panelCount, capacityKwp, annualKwh, area, address: addressLabel, tiltAngle, moduleIndex })
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
      pdf.save(`solar-layout-${addresses.filter(Boolean)[0] || 'site'}.pdf`)
    } finally {
      document.body.removeChild(div)
    }
  }

  const step1Done = addresses.some(a => a.trim().length > 0)
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
          <p className="text-xs text-gray-400 mb-2">API 키 없을 때 — vworld 스크린샷 붙여넣기 또는 캔버스에 직접 그리기</p>

          {/* vworld 스크린샷 붙여넣기 안내 */}
          <div className={`mb-2 border-2 rounded-lg p-3 text-center transition-colors ${
            screenshotAnalyzing
              ? 'border-orange-300 bg-orange-50'
              : screenshotImg && !screenshotError
              ? 'border-green-400 bg-green-50'
              : 'border-gray-200 bg-gray-50'
          }`}>
            {screenshotAnalyzing ? (
              <div className="flex items-center justify-center gap-2 text-xs text-orange-600">
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                경계선 분석 중...
              </div>
            ) : screenshotImg && !screenshotError ? (
              <div className="text-xs text-green-700 font-semibold">
                ✓ 스크린샷 경계 인식 완료
                <div className="text-green-600 font-normal mt-0.5">다시 붙여넣으면 교체됩니다 (Ctrl+V)</div>
              </div>
            ) : (
              <div className="text-xs text-gray-500">
                <div className="text-base mb-1">🗺</div>
                <div className="font-medium text-gray-700">vworld 스크린샷 후 <kbd className="bg-gray-200 text-gray-700 px-1 py-0.5 rounded text-xs">Ctrl+V</kbd></div>
                <div className="text-gray-400 mt-0.5">화면 어디서나 붙여넣기 가능</div>
              </div>
            )}
          </div>

          {/* 오류 메시지 */}
          {screenshotError && (
            <div className="mb-2 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600">
              {screenshotError}
            </div>
          )}

          {/* vworld 줌레벨 선택 + 축척 보정 */}
          {screenshotImg && (
            <div className="mb-2 space-y-2">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs text-blue-700">
                <div className="font-semibold mb-1">📐 vworld 줌레벨 = 스크린샷 축척 기준</div>
                <div className="text-blue-600">vworld에서 스크린샷을 찍을 때의 <strong>확대 단계</strong>를 선택하세요.<br/>줌이 높을수록 확대(1px당 더 작은 면적)됩니다.</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 whitespace-nowrap font-medium">줌레벨</label>
                <select
                  value={screenshotZoom}
                  onChange={e => { setScreenshotZoom(Number(e.target.value)); setScreenshotScaleCorr(1.0) }}
                  className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
                >
                  <option value={16}>16단계 (넓은 지역, ~2.4m/px)</option>
                  <option value={17}>17단계 (~1.2m/px)</option>
                  <option value={18}>18단계 (~0.6m/px) — 기본</option>
                  <option value={19}>19단계 (~0.3m/px)</option>
                  <option value={20}>20단계 (최대 확대, ~0.15m/px)</option>
                </select>
              </div>
              {/* 축척 보정: 캔버스 스케일바와 vworld 스케일바 불일치 시 조정 */}
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2 space-y-1.5">
                <div className="text-xs text-yellow-700 font-semibold">🔧 축척 미세 보정</div>
                <div className="text-xs text-yellow-600">
                  캔버스 우하단 <strong>「{Math.round(0.15 * Math.pow(2, 20 - screenshotZoom) * screenshotScaleCorr * 310 / (0.15 * Math.pow(2, 20 - screenshotZoom) * screenshotScaleCorr))}m」</strong> 스케일바와 배경지도의 스케일바가 다르면 조정하세요.
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">보정 ×{screenshotScaleCorr.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0.3}
                    max={3.0}
                    step={0.05}
                    value={screenshotScaleCorr}
                    onChange={e => setScreenshotScaleCorr(Number(e.target.value))}
                    className="flex-1"
                  />
                </div>
                <div className="text-xs text-gray-400">
                  현재 캔버스 축척: 1px ≈ {(0.15 * Math.pow(2, 20 - screenshotZoom) * screenshotScaleCorr * (1 / (Math.min(CANVAS_W, CANVAS_H) * 0.62))).toFixed(3)}m (참고용, 폴리곤 크기에 따라 결정됨)
                </div>
                {screenshotScaleCorr !== 1.0 && (
                  <button
                    onClick={() => setScreenshotScaleCorr(1.0)}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    기본값 초기화 (×1.00)
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 직접 그리기 버튼 */}
          <div className="flex gap-2">
            <button onClick={handleStartDraw}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                drawMode ? 'bg-red-50 border-red-400 text-red-600' : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'}`}>
              {drawMode ? '✕ 취소' : '✏ 직접 그리기'}
            </button>
            {(points.length > 0 || isComplete || screenshotImg) && (
              <button onClick={handleReset}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50">
                초기화
              </button>
            )}
          </div>
          {drawMode && (
            <div className="mt-2 bg-blue-50 rounded-lg p-2 text-xs text-blue-700 space-y-1.5">
              <div>
                클릭으로 꼭짓점 추가 · <strong>더블클릭</strong>으로 완료
                {points.length > 0 && <span className="ml-1 text-blue-500">({points.length}점)</span>}
              </div>
              {satTiles.length === 0 && (
                <div className="bg-yellow-50 border border-yellow-300 rounded p-1.5 space-y-1">
                  <div className="text-yellow-700 font-semibold">⚠ 위성사진 없음 — 수동 축척 설정 필수</div>
                  <div className="text-yellow-600">지번 검색 후 그리기를 권장합니다 (자동 축척)</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <label className="text-gray-600 whitespace-nowrap">1px =</label>
                    <input
                      type="number"
                      step={0.01}
                      min={0.001}
                      value={pixelScale}
                      onChange={e => setPixelScale(Math.max(0.001, Number(e.target.value)))}
                      className="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    <span className="text-gray-600">m/px</span>
                  </div>
                  <div className="text-gray-400">캔버스 800px 기준 총 {(pixelScale * 800).toFixed(0)}m 폭</div>
                </div>
              )}
              {points.length > 0 && (
                <button
                  onClick={handleUndoPoint}
                  className="flex items-center gap-1 text-xs bg-white border border-blue-300 text-blue-600 px-2 py-1 rounded hover:bg-blue-100 transition-colors"
                >
                  ↩ 마지막 점 취소
                </button>
              )}
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
                {apiSource === 'api' ? `  ·  VWorld ${parcels.length}개 필지` : '  ·  수동 측정'}
                {satTiles.length > 0 ? `  ·  ${mapMode === 'cadastral' ? '지적도' : '위성'}` : ''}
                {`  ·  경계마진 ${BOUNDARY_MARGIN[installType] ?? 2}m`}
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
            onClick={handleCanvasClick}
            onDoubleClick={handleCanvasDblClick}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={handleCanvasMouseLeave}
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

        {/* ── SVG 정밀 배치 분석 (geo-meter 기반, VWorld 필지 경계 필요) ── */}
        {apiSource === 'api' && parcels.length > 0 && (
          <div className="mt-4 bg-white rounded-xl border border-indigo-200 p-4">
            <div className="mb-3">
              <h3 className="font-semibold text-gray-800 text-sm flex items-center gap-1.5">
                🔬 SVG 정밀 배치 분석 <span className="text-xs font-normal text-indigo-500">v5.2</span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                지리 미터 좌표 기반 · 위도 {effectiveLatitude.toFixed(4)}° · 방위각/경사지/다구역 지원
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

              {/* 부지 용도 */}
              <div>
                <label className="text-xs text-gray-500 font-medium">부지 용도</label>
                <select
                  value={svgPlotType}
                  onChange={e => setSvgPlotType(e.target.value as PlotType)}
                  className="mt-1 w-full text-xs border border-gray-300 rounded px-2 py-1.5">
                  <option value="land">토지 (마진 2m)</option>
                  <option value="roof">지붕 (마진 0.5m)</option>
                  <option value="farmland">농지 (마진 2m)</option>
                  <option value="forest">임야 (마진 2m)</option>
                  <option value="land_change_planned">지목변경 예정 (마진 1.5m)</option>
                </select>
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

              {/* 경사지 보정 */}
              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" checked={svgHasSlope}
                    onChange={e => setSvgHasSlope(e.target.checked)}
                    className="accent-indigo-500" />
                  <span className="text-xs text-gray-700 font-medium">경사지 보정 적용</span>
                </label>
                {svgHasSlope && (
                  <div className="grid grid-cols-2 gap-2 bg-indigo-50 rounded p-2">
                    <div>
                      <label className="text-xs text-gray-500">경사각 (°)</label>
                      <input type="number" min={1} max={45} value={svgSlopeAngle}
                        onChange={e => setSvgSlopeAngle(Number(e.target.value))}
                        className="mt-1 w-full text-xs border border-gray-300 rounded px-2 py-1" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500">경사 방위각 (°)</label>
                      <input type="number" min={0} max={360} value={svgSlopeAzimuth}
                        onChange={e => setSvgSlopeAzimuth(Number(e.target.value))}
                        className="mt-1 w-full text-xs border border-gray-300 rounded px-2 py-1" />
                    </div>
                  </div>
                )}
              </div>

              {/* 특수 경계 체크박스 */}
              <div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={svgHasRiver}
                    onChange={e => setSvgHasRiver(e.target.checked)}
                    className="accent-blue-500" />
                  <span className="text-xs text-gray-700">하천 인접 (마진 +5m)</span>
                </label>
              </div>
              <div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={svgHasRoad}
                    onChange={e => setSvgHasRoad(e.target.checked)}
                    className="accent-orange-500" />
                  <span className="text-xs text-gray-700">도로 인접 (마진 +3m)</span>
                </label>
              </div>

              {/* 지목변경 예정 */}
              <div className="col-span-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={svgJimokChangePlanned}
                    onChange={e => setSvgJimokChangePlanned(e.target.checked)}
                    className="accent-purple-500" />
                  <span className="text-xs text-gray-700">지목변경 예정 (마진 1.5m 자동 적용)</span>
                </label>
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
                    const panelSpec = PRESET_PANELS[svgPanelType] ?? PRESET_PANELS.TYPE_A
                    const polygon = convertGeoRingToLocalPolygon(
                      parcels[0].ring,
                      apiCoords.lat,
                      apiCoords.lon
                    )

                    if (svgZoneMode === 'multi') {
                      // 다구역 자동 분할
                      const zones = autoSplitPolygon(
                        polygon,
                        panelSpec,
                        svgPlotType,
                        svgPanelType,
                        {
                          azimuthDeg: svgAzimuthDeg,
                          slopeAngleDeg: svgHasSlope ? svgSlopeAngle : 0,
                          slopeAzimuthDeg: svgHasSlope ? svgSlopeAzimuth : 180,
                          isJimokChangePlanned: svgJimokChangePlanned,
                        }
                      )
                      const result = runMultiZoneAnalysis(zones, apiCoords.lat)
                      setSvgAnalysisResult(result)
                    } else {
                      // 단일 구역
                      const result = runFullAnalysis({
                        cadastrePolygon: polygon,
                        plotType: svgPlotType,
                        panelSpec,
                        panelType: svgPanelType,
                        latitude: apiCoords.lat,
                        azimuthDeg: svgAzimuthDeg,
                        slopeAngleDeg: svgHasSlope ? svgSlopeAngle : 0,
                        slopeAzimuthDeg: svgHasSlope ? svgSlopeAzimuth : 180,
                        isJimokChangePlanned: svgJimokChangePlanned,
                      })
                      setSvgAnalysisResult(result)
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
    </div>
  )
}
