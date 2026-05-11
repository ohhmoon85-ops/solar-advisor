'use client'

// VWorld 호출은 모두 /api/vworld 서버 프록시 경유 (Edge Runtime, icn1 PoP)
// → 브라우저는 키 노출 없이 사용, Vercel IP 차단 회피

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useSolarStore } from '@/store/useStore'
import { MODULES, GENERATION_HOURS } from '@/lib/constants'
import { getSolarElevation } from '@/lib/shadowCalculator'
import { calculateRowSpacing, calculateSlopeFromPercent, getSolarAngleByLocation, type RowSpacingCalcResult } from '@/lib/spacingCalculator'
import { runFullAnalysis, createSafeZone, type FullAnalysisResult, type PlotType, type SpacingPolicy } from '@/lib/layoutEngine'
import { convertGeoRingToLocalPolygon } from '@/lib/cadastre'
import { PRESET_PANELS } from '@/lib/panelConfig'
import { type MultiZoneResult, type ZoneLayoutResult, type ZoneConfig, runMultiZoneAnalysis, isMultiZoneResult, mergePolygonsToHull } from '@/lib/multiZoneLayout'
import { union as turfUnion, polygon as turfPolygon, featureCollection as turfFeatureCollection, booleanPointInPolygon as turfPIP, point as turfPoint, buffer as turfBuffer } from '@turf/turf'

// SVG 캔버스는 클라이언트 전용
const SolarLayoutCanvas = dynamic(
  () => import('@/components/SolarLayoutCanvas'),
  { ssr: false }
)

const LayoutEditor = dynamic(
  () => import('@/components/LayoutEditor'),
  { ssr: false }
)

// 경매 파일 드롭존 — pdfjs/tesseract.js 동적 로드 (번들 크기 최적화)
const AuctionFileDropzone = dynamic(
  () => import('@/components/AuctionFileDropzone'),
  { ssr: false }
)

const ParcelInfoCard = dynamic(
  () => import('@/components/ParcelInfoCard'),
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
interface SatTile { img: HTMLImageElement; cx: number; cy: number; px: number; pxH: number }

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
    setLastFullAnalysisJson, setLastAnalysisAddress,
    pendingRestore, setPendingRestore,
    liveSmp, priceOverride,
    roofPolygons, drawingMode, currentDrawingPoints,
    setDrawingMode, addDrawingPoint, popDrawingPoint, clearDrawing, commitPolygon,
    removePolygon, clearAllPolygons,
    spacingPolicy, setSpacingPolicy,
    constructionStdGap, setConstructionStdGap,
    userBoundaryMargin, setUserBoundaryMargin,
    userRowSpacing, setUserRowSpacing,
    userFirstStackGap, setUserFirstStackGap,
  } = useSolarStore()
  // SMP 단일 소스 — store의 실시간 KPX 응답값 (없으면 사용자 수동 설정값)
  const smpDisplay = liveSmp ?? priceOverride.smp
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobUrlsRef = useRef<string[]>([]) // cleanup용

  // ── 입력 ──
  const [addresses, setAddresses] = useState<string[]>(['', '', '', '', ''])
  const [installType, setInstallType] = useState<string>('건물지붕형')
  const [moduleIndex, setModuleIndex] = useState(0)
  const [tiltAngle, setTiltAngle] = useState(33)
  const [spacingValue, setSpacingValue] = useState(1.2)
  const [autoSpacingMode, setAutoSpacingMode] = useState(false)
  const [autoSolarAngle, setAutoSolarAngle] = useState<number | null>(null)
  const [autoLandAngle, setAutoLandAngle] = useState(0)
  const [autoMargin, setAutoMargin] = useState(0)
  const [workPathM, setWorkPathM] = useState(0)
  const [autoSpacingResult, setAutoSpacingResult] = useState<RowSpacingCalcResult | null>(null)
  const [applyToQuick, setApplyToQuick] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [panelOrientation, setPanelOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [rowStack, setRowStack] = useState<1 | 2 | 3>(2)
  const [slopePercent, setSlopePercent] = useState(0)
  const [slopeAuto, setSlopeAuto] = useState(false)  // 자동측정 여부
  const [slopeFetching, setSlopeFetching] = useState(false)
  const [structureType, setStructureType] = useState<StructureType>('철골구조')
  const [bipvEnabled, setBipvEnabled] = useState(false)
  const [roofType, setRoofType] = useState<'슬라브' | '박공'>('슬라브')
  const [jjokOlrim, setJjokOlrim] = useState(false)

  // ── 드로잉 ──
  const [isComplete, setIsComplete] = useState(false)
  const [area, setArea] = useState(0)
  const [pixelScale, setPixelScale] = useState(0.1) // m/px

  // ── 위성/지적도 오버레이 ──
  const [satTiles, setSatTiles] = useState<SatTile[]>([])
  const [cadImgTiles, setCadImgTiles] = useState<{src:string;cx:number;cy:number;px:number;pxH:number}[]>([])
  const [roadImgTiles, setRoadImgTiles] = useState<{src:string;cx:number;cy:number;px:number;pxH:number}[]>([])
  const [baseTiles, setBaseTiles] = useState<{src:string;cx:number;cy:number;px:number;pxH:number}[]>([])
  const [satLoading, setSatLoading] = useState(false)
  const [satFailed, setSatFailed] = useState(false)
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
  // 지도 캔버스 좌표계 원점 (전체 필지 정점 무게중심) — apiCoords(첫 필지 coord API)와 구분
  const [canvasCenter, setCanvasCenter] = useState<{ lat: number; lon: number } | null>(null)
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
  // 필지별 패널 수 (union ring 단위, STEP 3)
  const [landInfo, setLandInfo] = useState<import('@/components/ParcelInfoCard').LandInfoData | null>(null)
  const [ringPanelCounts, setRingPanelCounts] = useState<number[]>([])
  // SVG 캔버스 동적 너비 (STEP 4)
  const svgContainerRef = useRef<HTMLDivElement>(null)
  const [svgContainerWidth, setSvgContainerWidth] = useState(900)
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
  // 분석 실행마다 증가 → LayoutEditor key로 사용해 이전 편집 상태 완전 초기화
  const [analysisKey, setAnalysisKey] = useState(0)
  // 정밀 분석 버튼 통합 — 입력 변경 감지
  const analysisHasRunRef = useRef(false)
  const [analysisStale, setAnalysisStale] = useState(false)
  // 다구역 편집 시 선택된 구역 ('A', 'B', ...)
  const [activeZoneId, setActiveZoneId] = useState<string>('A')
  // Phase C-1: 지붕 그리기 마우스 미리보기 위치 (canvas 내부 픽셀 좌표)
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null)
  // 다중 지붕 폴리곤 commit 감지 (toast 알림용)
  const prevRoofCountRef = useRef(0)

  // 이론 이격 거리 — 현장 위도 기반 (hardcode 37.5665° → 동적 위도)
  const tiltRad = (tiltAngle * Math.PI) / 180
  const effectiveLatitude = apiCoords?.lat ?? 37.5665
  const winterElevDeg = getSolarElevation(effectiveLatitude, -23.45)
  const winterAltRad = (winterElevDeg * Math.PI) / 180
  const theoreticalSpacing =
    Math.round(MODULES[moduleIndex].h * Math.cos(tiltRad) * (1 / Math.tan(winterAltRad)) * 100) / 100

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3000)
  }, [])

  // 지붕 폴리곤 추가 감지 — drawingMode 중 commit 시 toast 안내
  useEffect(() => {
    const prev = prevRoofCountRef.current
    prevRoofCountRef.current = roofPolygons.length
    if (roofPolygons.length > prev && drawingMode) {
      showToast(`건물 ${roofPolygons.length} 추가됨. 다음 건물 외곽을 클릭으로 시작하거나 그리기 모드를 끄세요.`)
    }
  }, [roofPolygons.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // svgPlotType !== 'roof' 전환 시 그리기 상태 초기화 (토지형 회귀 보호)
  useEffect(() => {
    if (svgPlotType !== 'roof' && drawingMode) {
      clearDrawing()
      setDrawingMode(false)
    }
  }, [svgPlotType]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase C-1: 지붕 그리기 키보드 핸들러 ──────────────────────────
  useEffect(() => {
    if (!drawingMode || svgPlotType !== 'roof') {
      setMouseCanvasPos(null)
      return
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearDrawing(); setDrawingMode(false) }
      else if (e.key === 'Enter') { commitPolygon() }
      else if (e.key === 'Backspace') { e.preventDefault(); popDrawingPoint() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [drawingMode, svgPlotType, clearDrawing, setDrawingMode, commitPolygon, popDrawingPoint])

  // canvas px → 경위도 변환 (geoToCanvas 역함수)
  const canvasPxToGeo = useCallback((cx: number, cy: number) => {
    if (!canvasCenter || pixelScale <= 0) return null
    const { lat, lon } = canvasCenter
    return {
      lng: lon + (cx - CANVAS_W / 2) * pixelScale / mpdLon(lat),
      lat: lat + (CANVAS_H / 2 - cy) * pixelScale / MPD_LAT,
    }
  }, [canvasCenter, pixelScale])

  const handleDrawingSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!drawingMode) return
    if (e.detail > 1) return  // 더블클릭의 두 번째 클릭은 무시
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = (e.clientX - rect.left) * (CANVAS_W / rect.width)
    const cy = (e.clientY - rect.top) * (CANVAS_H / rect.height)
    const geo = canvasPxToGeo(cx, cy)
    if (geo) addDrawingPoint(geo)
  }, [drawingMode, canvasPxToGeo, addDrawingPoint])

  const handleDrawingSvgDoubleClick = useCallback(() => {
    if (!drawingMode) return
    commitPolygon()
  }, [drawingMode, commitPolygon])

  const handleDrawingSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!drawingMode) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = (e.clientX - rect.left) * (CANVAS_W / rect.width)
    const cy = (e.clientY - rect.top) * (CANVAS_H / rect.height)
    setMouseCanvasPos({ x: cx, y: cy })
  }, [drawingMode])

  const handleDrawingSvgMouseLeave = useCallback(() => {
    setMouseCanvasPos(null)
  }, [])

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
        setLastAnalysisAddress(rec.address)
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
    setRoadImgTiles([])
    setBaseTiles([])
    setSatFailed(false)
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []

    // fetchZ ≤ 18: 한국 농촌 z=19~20 타일 미지원 → 오버줌으로 표시
    const fetchZ = Math.min(z, 18)
    const zoomRatio = Math.pow(2, z - fetchZ) // z=20→4, z=19→2, z≤18→1

    const { tx: ctX, ty: ctY } = lonLatToTile(cLon, cLat, z)
    const R = 2

    // VWorld 기본지도 타일 헬퍼 (두 모드 공용)
    // pxH: Mercator 타일 지리 높이를 equirectangular 캔버스 픽셀로 변환 (cos 보정)
    const buildBaseTiles = () => {
      const tiles: {src:string;cx:number;cy:number;px:number;pxH:number}[] = []
      const seen = new Set<string>()
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const tx = ctX + dx, ty = ctY + dy
          const tx18 = Math.floor(tx / zoomRatio)
          const ty18 = Math.floor(ty / zoomRatio)
          const key = `${tx18},${ty18}`
          if (seen.has(key)) continue
          seen.add(key)
          const origin = tileOriginLonLat(tx18, ty18, fetchZ)
          const originSouth = tileOriginLonLat(tx18, ty18 + 1, fetchZ)
          const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
          const px = tilePixelScaleM(cLat, fetchZ) * 256 / scale
          const pxH = (origin.lat - originSouth.lat) * MPD_LAT / scale
          tiles.push({ src: `/api/vworld?type=basetile&z=${fetchZ}&x=${tx18}&y=${ty18}`, cx, cy, px, pxH })
        }
      }
      return tiles
    }

    if (mode === 'cadastral') {
      // 지적도: VWorld Base 기본지도(도로) 배경 + WMS 지적도(지번·경계) 투명 오버레이
      setBaseTiles(buildBaseTiles())

      const wmsZ = Math.min(z, 18)
      const wmsRatio = Math.pow(2, z - wmsZ)
      const cadTiles: {src:string;cx:number;cy:number;px:number;pxH:number}[] = []
      const seenWms = new Set<string>()
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const tx = ctX + dx, ty = ctY + dy
          const tx18 = Math.floor(tx / wmsRatio)
          const ty18 = Math.floor(ty / wmsRatio)
          const key = `${tx18},${ty18}`
          if (seenWms.has(key)) continue
          seenWms.add(key)
          const origin = tileOriginLonLat(tx18, ty18, wmsZ)
          const originSouth = tileOriginLonLat(tx18, ty18 + 1, wmsZ)
          const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
          const px = tilePixelScaleM(cLat, wmsZ) * 256 / scale
          // WMS는 EPSG:4326 equirectangular — 타일 지리 높이를 정확히 계산
          const pxH = (origin.lat - originSouth.lat) * MPD_LAT / scale
          const bbox = tileToWgs84Bbox(wmsZ, tx18, ty18)
          const src = `/api/vworld?type=wms&bbox=${encodeURIComponent(bbox)}&layers=lt_c_landinfobasemap&width=256&height=256&transparent=true`
          cadTiles.push({ src, cx, cy, px, pxH })
        }
      }
      setCadImgTiles(cadTiles)
      setSatLoading(false)
      return
    }

    // 위성사진: ArcGIS CORS 허용 → canvas drawImage (VWorld Satellite fallback)
    const jobs: Promise<SatTile | null>[] = []
    const fetchedSat = new Set<string>()
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = ctX + dx, ty = ctY + dy
        const tx18 = Math.floor(tx / zoomRatio)
        const ty18 = Math.floor(ty / zoomRatio)
        const key = `${tx18},${ty18}`
        if (fetchedSat.has(key)) continue
        fetchedSat.add(key)
        jobs.push((async () => {
          try {
            const origin = tileOriginLonLat(tx18, ty18, fetchZ)
            const originSouth = tileOriginLonLat(tx18, ty18 + 1, fetchZ)
            const { x: cx, y: cy } = geoToCanvas(origin.lon, origin.lat, cLon, cLat, scale)
            const fetchTilePx = tilePixelScaleM(cLat, fetchZ) * 256 / scale
            // Mercator 타일 지리 높이 (equirectangular 기준) — cos 보정
            const fetchTilePxH = (origin.lat - originSouth.lat) * MPD_LAT / scale
            const arcUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${fetchZ}/${ty18}/${tx18}`
            return await new Promise<SatTile | null>(resolve => {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              img.onload = () => resolve({ img, cx, cy, px: fetchTilePx, pxH: fetchTilePxH })
              img.onerror = () => {
                const vwImg = new Image()
                vwImg.onload = () => resolve({ img: vwImg, cx, cy, px: fetchTilePx, pxH: fetchTilePxH })
                vwImg.onerror = () => resolve(null)
                vwImg.src = `/api/vworld?type=satellite&z=${fetchZ}&x=${tx18}&y=${ty18}`
              }
              img.src = arcUrl
            })
          } catch { return null }
        })())
      }
    }
    const results = (await Promise.all(jobs)).filter(Boolean) as SatTile[]
    setSatTiles(results)
    setSatFailed(results.length === 0)

    // 도로 오버레이: VWorld 기본지도(Base) — mix-blend-mode:multiply로 위성 위에 도로 표시
    // Hybrid는 불투명 타일(위성+도로 합성)이라 ArcGIS 위성을 가림 → Base로 대체
    setRoadImgTiles(buildBaseTiles())

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
      satTiles.forEach(t => ctx.drawImage(t.img, t.cx, t.cy, t.px, t.pxH))
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 0.5
      for (let x = 0; x < CANVAS_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y < CANVAS_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_H, y); ctx.stroke()
      }
    } else if (cadImgTiles.length === 0 && baseTiles.length === 0) {
      // 기본 그리드 배경 (배경 타일 없을 때만)
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
      pixelScale, apiSource, satTiles, cadImgTiles, baseTiles, satZoom,
      parcels, mapMode])

  useEffect(() => { drawCanvas() }, [drawCanvas])

  // ── 패널 배치 계산 (필지·설정 변경 시 자동 재계산) ──────────────
  const recalculatePanels = useCallback((currentParcels: ParcelInfo[], scale: number) => {
    if (currentParcels.length === 0) return
    const module = MODULES[moduleIndex]
    const isBuilding = installType === '건물지붕형'
    const ltr = (tiltAngle * Math.PI) / 180
    const panelW = panelOrientation === 'landscape' ? module.h : module.w
    const panelH = panelOrientation === 'landscape' ? module.w : module.h
    const panelPxW = panelW / scale
    const panelPxH = (panelH * Math.cos(ltr) * rowStack) / scale
    const rowPitch = panelPxH + spacingValue / scale
    const marginM = BOUNDARY_MARGIN[installType] ?? 2.0
    const marginPx = marginM / scale

    // turf union으로 인접 필지 병합 → 내부 경계 마진 제거
    const cLon = apiCoords?.lon ?? 0
    const cLat = apiCoords?.lat ?? 0
    const parcelFeats = currentParcels
      .filter(p => p.ring.length >= 3)
      .map(p => {
        const r = p.ring
        const closed = (r[0][0] === r[r.length-1][0] && r[0][1] === r[r.length-1][1]) ? r : [...r, r[0]]
        return turfPolygon([closed])
      })
    let unionFeat = parcelFeats[0]
    for (let i = 1; i < parcelFeats.length; i++) {
      const res = turfUnion(turfFeatureCollection([unionFeat, parcelFeats[i]]))
      if (res) unionFeat = res as ReturnType<typeof turfPolygon>
    }
    const ug = unionFeat.geometry
    const unionRings: number[][][] = ug.type === 'Polygon'
      ? [ug.coordinates[0] as number[][]]
      : (ug.coordinates as unknown as number[][][][]).map(p => p[0])

    let totalPanelRects: PanelRect[] = []
    let totalCount = 0
    for (const ring of unionRings) {
      const pts = ring.map(([lon, lat]) => geoToCanvas(lon, lat, cLon, cLat, scale))
      if (pts.length < 3) continue
      const minX = Math.min(...pts.map(p => p.x))
      const maxX = Math.max(...pts.map(p => p.x))
      const minY = Math.min(...pts.map(p => p.y))
      const maxY = Math.max(...pts.map(p => p.y))
      const rects: PanelRect[] = []
      for (let y = minY + marginPx; y + panelPxH <= maxY - marginPx; y += rowPitch) {
        for (let x = minX + marginPx; x + panelPxW <= maxX - marginPx; x += panelPxW + 2) {
          if (panelCrossesBoundary(x, y, panelPxW, panelPxH, pts)) continue
          // 조건 1: 패널 4꼭짓점 모두 폴리곤 안 + 마진 이상 이격
          const corners = [
            { x, y }, { x: x + panelPxW, y },
            { x: x + panelPxW, y: y + panelPxH }, { x, y: y + panelPxH },
          ]
          if (!corners.every(c =>
                isPointInPolygon(c.x, c.y, pts) &&
                minDistToPolygonEdge(c.x, c.y, pts) >= marginPx)) continue
          // 조건 2: 가장자리 중간점 4개 추가 검사 (오목 폴리곤 대응)
          const edgeMids = [
            { x: x + panelPxW / 2, y }, { x: x + panelPxW / 2, y: y + panelPxH },
            { x, y: y + panelPxH / 2 }, { x: x + panelPxW, y: y + panelPxH / 2 },
          ]
          if (!edgeMids.every(c =>
                isPointInPolygon(c.x, c.y, pts) &&
                minDistToPolygonEdge(c.x, c.y, pts) >= marginPx)) continue
          rects.push({ x, y, w: panelPxW, h: panelPxH })
        }
      }
      totalPanelRects = [...totalPanelRects, ...rects]
      totalCount += rects.length
    }
    // 필지별 패널 수 — recalculatePanels 로컬 cLon/cLat/scale로 재변환 (canvasPoints는 원점 다름)
    const perParcelCounts = currentParcels.map(p => {
      if (!p.ring || p.ring.length < 3) return 0
      const pts = p.ring.map(([lon, lat]: number[]) =>
        geoToCanvas(lon, lat, cLon, cLat, scale)
      )
      if (pts.length < 3) return 0
      return totalPanelRects.filter(rect => {
        const cx = rect.x + rect.w / 2
        const cy = rect.y + rect.h / 2
        return isPointInPolygon(cx, cy, pts)
      }).length
    })
    setPanelRects(totalPanelRects)
    setPanelCount(totalCount)
    setRingPanelCounts(perParcelCounts)
    const cap = (totalCount * MODULES[moduleIndex].watt) / 1000
    setCapacityKwp(Math.round(cap * 100) / 100)
    setAnnualKwh(Math.round(cap * GENERATION_HOURS * 365))
  }, [installType, moduleIndex, tiltAngle, spacingValue, panelOrientation, rowStack, slopePercent])

  // SMP는 app/page.tsx 에서 단일 fetch (store.liveSmp) — 여기서 중복 호출 안 함

  useEffect(() => {
    if (apiCoords?.lat) {
      const angle = getSolarAngleByLocation(apiCoords.lat)
      setAutoSolarAngle(Math.round(angle * 10) / 10)
    }
  }, [apiCoords?.lat])

  useEffect(() => {
    setAutoLandAngle(Math.round(calculateSlopeFromPercent(slopePercent) * 10) / 10)
  }, [slopePercent])

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

  // SVG 캔버스 컨테이너 너비 측정
  // - showSvgCanvas/svgAnalysisResult 의존성: 캔버스가 처음 마운트되는 타이밍에 measure
  // - requestAnimationFrame: 레이아웃 안정 후 정확한 clientWidth 획득
  // - ResizeObserver: 다구역↔단일 토글, 윈도우 리사이즈, 사이드바 펼침 등 폭 변동 자동 감지
  useEffect(() => {
    if (!showSvgCanvas || !svgAnalysisResult) return
    const el = svgContainerRef.current
    if (!el) return

    const measure = () => {
      const w = el.clientWidth
      if (w > 0) setSvgContainerWidth(w)
    }

    // 첫 측정은 다음 프레임으로 연기 (DOM 레이아웃 안정 후)
    const rafId = requestAnimationFrame(measure)

    // 컨테이너 크기 변경 자동 감지
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      ro.observe(el)
    }
    // 폴백: 구형 브라우저 — 윈도우 리사이즈 이벤트
    window.addEventListener('resize', measure)

    return () => {
      cancelAnimationFrame(rafId)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [showSvgCanvas, svgAnalysisResult])

  // 주요 분석 입력 변경 시 "재분석 필요" 표시 (분석을 한 번이라도 실행한 이후만)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (analysisHasRunRef.current) setAnalysisStale(true)
  }, [tiltAngle, autoMargin, workPathM, rowStack, svgPanelType, svgPanelOrientation,
      svgAzimuthDeg, userRowSpacing, spacingPolicy, constructionStdGap, userFirstStackGap,
      svgZoneMode, svgPlotType])

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

  // ── VWorld DEM 경사도 자동 측정 (서버 프록시 경유, 5점 통합 1회 호출) ──
  const fetchSlope = useCallback(async (lon: number, lat: number) => {
    setSlopeFetching(true)
    try {
      const r = await fetch(`/api/vworld?type=elevation&lon=${lon}&lat=${lat}`)
      if (!r.ok) return
      const d = await r.json()
      if (typeof d?.slope !== 'number') return
      setSlopePercent(Math.min(d.slope, 50))
      setSlopeAuto(true)
    } catch { /* 무시 */ } finally { setSlopeFetching(false) }
  }, [])

  // ── 주소 → 좌표 + 필지 통합 조회 (VWorld 단일 체계) ──
  // /api/geocode (Edge Runtime) 한 번의 호출로 좌표·PNU·폴리곤·면적·라벨 모두 수신
  interface GeocodeResult {
    lon: number; lat: number
    ring: number[][]
    areaSqm: number
    label: string
    pnu?: string
    jimok?: string
  }
  const geocodeAddress = async (q: string): Promise<GeocodeResult | { error: string }> => {
    try {
      const res = await fetch(`/api/geocode?address=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        return { error: data.error ?? `HTTP ${res.status}` }
      }
      if (typeof data.lat !== 'number' || typeof data.lng !== 'number') {
        return { error: '좌표 응답 형식 오류' }
      }
      if (!data.parcel) {
        return { error: '필지 경계를 찾을 수 없습니다' }
      }
      return {
        lon: data.lng,
        lat: data.lat,
        ring: data.parcel.ring,
        areaSqm: data.parcel.areaSqm,
        label: data.parcel.label,
        pnu: data.parcel.pnu ?? data.pnu,
        jimok: data.parcel.jimok,
      }
    } catch (e) {
      return { error: 'VWorld 통합 지오코더 호출 실패: ' + String(e) }
    }
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
    // 부지 변경 시 이전 분석 결과 초기화
    // (구 결과가 남아 있으면 multizone onCountChange → setSvgAnalysisResult 무한 루프 발생)
    setSvgAnalysisResult(null)
    setShowSvgCanvas(false)
    setIsEditing(false)
    setEditingCount(null)

    try {
      // 모든 지번 병렬 조회 — /api/geocode 단일 호출로 좌표+필지 동시 수신
      const geoResults = await Promise.all(queries.map(q => geocodeAddress(q)))
      const parcelResults: ParcelInfo[] = []

      for (let i = 0; i < geoResults.length; i++) {
        const r = geoResults[i]
        if ('error' in r) continue
        parcelResults.push({
          ring: r.ring,
          canvasPoints: [], // 나중에 공통 좌표계로 변환
          areaSqm: r.areaSqm,
          label: r.label,
          lon: r.lon, lat: r.lat,
          color: PARCEL_COLORS[i % PARCEL_COLORS.length],
        })
      }

      if (parcelResults.length === 0) {
        const firstError = geoResults.find(r => 'error' in r) as { error: string } | undefined
        setSearchError(firstError?.error ?? '필지 경계를 불러올 수 없습니다.')
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
      setCanvasCenter({ lat: cLat, lon: cLon })
      setParcelLabel(converted.map(p => p.label).join(' · '))

      // 패널 계산은 recalculatePanels useEffect가 parcels/pixelScale 변경 시 자동 처리

      loadTiles(cLon, cLat, z, scale, mapMode)
      fetchKierData(first.lat, first.lon, tiltAngle)
      fetchSlope(first.lon, first.lat)

      // land-info: 용도지역·지목 조회
      fetch('/api/land-info?lon=' + first.lon + '&lat=' + first.lat)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && !d.error) setLandInfo(d) })
        .catch(() => {})

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
    setPixelScale(0.1); setSatTiles([]); setSatZoom(0); setSatFailed(false); setBaseTiles([])
    setKierResult(null); setApiCoords(null); setCanvasCenter(null); setAutoAzimuth(null)
    setKierPvHours(null); setKierGhi(null); setLocationCoords(null)
    // 복수 필지 초기화
    setParcels([])
    setLandInfo(null)
    // 사용자 입력 전체 초기화 → R-new 기준점 복원
    setUserBoundaryMargin(undefined)
    setUserRowSpacing(undefined)
    setConstructionStdGap(undefined)
    setUserFirstStackGap(undefined)
    setSpacingPolicy('construction_std')
    setAutoMargin(0)
    setWorkPathM(0)
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
    // 인접 체크 결과 — store에서 직접 조회 (PDF 생성 시점 스냅샷)
    const { useAdjacencyStore } = await import('@/store/useAdjacencyStore')
    const { ADJACENCY_RULES, ADJACENCY_DISCLAIMER, getRiskLevel } = await import('@/lib/adjacencyRules')
    const adj = useAdjacencyStore.getState()
    const adjCheckedCount = Object.values(adj.checked).filter(Boolean).length
    const adjRisk = getRiskLevel(adjCheckedCount)
    const adjBadgeColor = adjRisk.level === 'critical'
      ? { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' }
      : adjRisk.level === 'caution'
      ? { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d' }
      : { bg: '#dcfce7', fg: '#166534', border: '#86efac' }
    const adjacencyHtml = adjCheckedCount > 0
      ? `<div style="margin-top:14px;padding:10px 12px;border:1px solid ${adjBadgeColor.border};background:${adjBadgeColor.bg}cc;border-radius:6px;font-size:11px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="color:${adjBadgeColor.fg};font-size:12px">🚧 인접 시설 사전 체크</strong>
            <span style="background:${adjBadgeColor.fg};color:white;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:bold">${adjRisk.label} · ${adjCheckedCount}/4</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            ${ADJACENCY_RULES.map(rule => {
              const isChecked = !!adj.checked[rule.id]
              const dist = adj.distances[rule.id] ?? rule.defaultDistance
              return `<tr style="background:${isChecked ? '#ffffff' : 'transparent'}">
                <td style="padding:4px 8px;border-bottom:1px solid #e7e5e4;width:24px;text-align:center">${isChecked ? '☑' : '☐'}</td>
                <td style="padding:4px 8px;border-bottom:1px solid #e7e5e4;font-weight:${isChecked ? 'bold' : 'normal'};color:${isChecked ? adjBadgeColor.fg : '#57534e'}">${rule.icon} ${rule.label}</td>
                <td style="padding:4px 8px;border-bottom:1px solid #e7e5e4;text-align:right;font-weight:${isChecked ? 'bold' : 'normal'};color:${isChecked ? adjBadgeColor.fg : '#78716c'}">${dist}m</td>
              </tr>`
            }).join('')}
          </table>
          <div style="margin-top:6px;font-size:9px;color:#78716c;line-height:1.3">ⓘ ${ADJACENCY_DISCLAIMER}</div>
        </div>`
      : ''  // 체크 0개면 섹션 통째로 생략 (사용자 지시: 빈 상태 생략 권장)

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
      ${adjacencyHtml}
      <div style="margin-top:10px;font-size:10px;color:#94a3b8;text-align:center">
        생성: ${new Date().toLocaleDateString('ko-KR')} — SolarAdvisor v5.2 (SMP ${smpDisplay.toFixed(2)}원/kWh${liveSmp != null ? ' · KPX 실시간' : ''} · REC 건물 ${priceOverride.recBuilding.toLocaleString()}원/MWh · 발전시간 3.5h)
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

  function handleLayoutDownloadPNG() {
    const svgEl = document.getElementById('svg-layout-canvas') as SVGSVGElement | null
    if (!svgEl) return
    const svgData = new XMLSerializer().serializeToString(svgEl)
    const vb = svgEl.viewBox.baseVal
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = (vb.width || svgEl.clientWidth) * scale
    canvas.height = (vb.height || svgEl.clientHeight) * scale
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const a = document.createElement('a')
      a.download = `배치도_${new Date().toISOString().slice(0, 10)}.png`
      a.href = canvas.toDataURL('image/png')
      a.click()
    }
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  async function handleLayoutDownloadPDF() {
    const svgEl = document.getElementById('svg-layout-canvas') as SVGSVGElement | null
    if (!svgEl) return
    const svgData = new XMLSerializer().serializeToString(svgEl)
    const vb = svgEl.viewBox.baseVal
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = (vb.width || svgEl.clientWidth) * scale
    canvas.height = (vb.height || svgEl.clientHeight) * scale
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await new Promise<void>(resolve => {
      const img = new Image()
      img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); resolve() }
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
    })
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF('l', 'mm', 'a4')
    const pw = pdf.internal.pageSize.getWidth() - 16
    const ph = (canvas.height / canvas.width) * pw
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 8, 8, pw, ph)
    pdf.save(`배치도_${new Date().toISOString().slice(0, 10)}.pdf`)
  }

  const runSVGAnalysis = useCallback(async (overrides?: {
    panelOrientation?: 'portrait' | 'landscape'
    rowStack?: 1 | 2 | 3
    rowSpacing?: number
  }) => {
    if (!apiCoords) return
    if (svgPlotType !== 'roof' && parcels.length === 0) return
    if (svgPlotType === 'roof' && roofPolygons.length === 0) {
      showToast('지붕을 먼저 그려주세요')
      return
    }
    setSvgAnalyzing(true)
    try {
      const panelSpec = PRESET_PANELS[svgPanelType] ?? PRESET_PANELS.GS710wp
      const lat = effectiveLatitude
      const orientation = overrides?.panelOrientation ?? svgPanelOrientation
      const stack = overrides?.rowStack ?? rowStack
      const customRowSpacing = overrides?.rowSpacing
      const gableRowSpacing = installType === '건물지붕형' && roofType === '박공' ? 0.1 : undefined

      // [Option C 해백] 일반토지/슬라브에서 customRowSpacing 미지정 시,
      // 자동 계산 패널의 입력값(경사·마진)으로 행간거리를 계산하여 해백.
      // workPath는 별도로 runFullAnalysis에 전달되므로 여기서는 baseSpacing(=recommended+margin)만 산출.
      // 박공은 gableRowSpacing(0.1m)이 우선이므로 해백 미적용.
      let autoCalcRowSpacing: number | undefined
      if (customRowSpacing === undefined && gableRowSpacing === undefined) {
        const solarAng = autoSolarAngle ?? getSolarAngleByLocation(effectiveLatitude)
        const moduleLen = MODULES[moduleIndex].h
        const calcResult = calculateRowSpacing(solarAng, tiltAngle, autoLandAngle, moduleLen)
        const baseRecommended = userRowSpacing ?? calcResult.rowSpacing
        autoCalcRowSpacing = Math.round((baseRecommended + autoMargin) * 100) / 100
      }

      const effectiveRowSpacing = customRowSpacing ?? gableRowSpacing ?? autoCalcRowSpacing
      const isGable = installType === '건물지붕형' && roofType === '박공'
      const workPath = isGable ? 0 : workPathM

      // 경계 마진: 사용자 입력 우선, 미지정 시 모드별 기본값 (토지 2m / 지붕 0.5m)
      const defaultMargin = svgPlotType === 'roof' ? 0.5 : 2.0
      const rawMargin = userBoundaryMargin ?? defaultMargin
      const effectiveMargin = Math.max(rawMargin, 0.01)  // 0 입력 시 turfBuffer 크래시 방지

      // ── Phase C-2: 지붕 폴리곤 모드 ────────────────────────────────
      if (svgPlotType === 'roof' && roofPolygons.length > 0) {
        const roofFixedGridAngle = isGable && jjokOlrim
        const roofRowSpacing = isGable ? 0.1 : effectiveRowSpacing
        const commonRoofOpts = {
          azimuthDeg: svgAzimuthDeg,
          slopeAngleDeg: 0,
          slopeAzimuthDeg: 180,
          isJimokChangePlanned: false,
          panelOrientation: orientation,
          rowStack: stack,
        }
        const zones: ZoneConfig[] = roofPolygons.map((poly, idx) => {
          const ring: number[][] = poly.points.map(p => [p.lng, p.lat])
          const closed = (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
            ? ring : [...ring, ring[0]]
          const geoJson = turfPolygon([closed])
          const safeGeoJson = turfBuffer(geoJson, -effectiveMargin, { units: 'meters' })
          if (!safeGeoJson || safeGeoJson.geometry.type !== 'Polygon') return null
          const safeRing = safeGeoJson.geometry.coordinates[0] as number[][]
          const safePolygon = convertGeoRingToLocalPolygon(safeRing, apiCoords.lat, apiCoords.lon)
          const cadastrePolyLocal = convertGeoRingToLocalPolygon(closed, apiCoords.lat, apiCoords.lon)
          return {
            label: `${String.fromCharCode(65 + idx)}구역`,
            polygon: cadastrePolyLocal,
            plotType: 'roof' as PlotType,
            panelSpec,
            panelType: svgPanelType,
            precomputedSafeZonePolygon: safePolygon,
            rowSpacing: roofRowSpacing,
            landStandard: false,
            fixedGridAngle: roofFixedGridAngle,
            workPath: 0,
            spacingPolicy,
            constructionStdGap,
            firstStackGap: userFirstStackGap,
            ...commonRoofOpts,
          } as ZoneConfig
        }).filter((z): z is ZoneConfig => z !== null)
        if (zones.length === 0) return
        const mzResult = runMultiZoneAnalysis(zones, lat)
        setSvgAnalysisResult(mzResult)
        setLastFullAnalysisJson(JSON.stringify(mzResult))
        setLastAnalysisAddress(addresses.filter(Boolean).join(', '))
        setIsEditing(false)
        setAnalysisKey(k => k + 1)
        setShowSvgCanvas(true)
        return
      }

      // turf union: GeoJSON 레벨에서 복수 필지를 정확히 합산 (convex hull 대신)
      const parcelFeatures = parcels
        .filter(p => p.ring.length >= 3)
        .map(p => {
          const ring = p.ring
          const closed = (ring.length > 0 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
            ? ring : [...ring, ring[0]]
          return turfPolygon([closed])
        })
      if (parcelFeatures.length === 0) return
      let mergedFeature = parcelFeatures[0]
      for (let i = 1; i < Math.min(parcelFeatures.length, 5); i++) {
        const result = turfUnion(turfFeatureCollection([mergedFeature, parcelFeatures[i]]))
        if (result) mergedFeature = result as ReturnType<typeof turfPolygon>
      }
      // Polygon vs MultiPolygon 분기: union 결과에 따라 safe zone 계산
      const geomType = mergedFeature.geometry?.type
      const allRings: number[][][] = []
      let cadastreRing: number[][] = []

      if (geomType === 'Polygon') {
        // 인접 필지 → 단일 폴리곤, 내부 경계 마진 없음
        cadastreRing = mergedFeature.geometry.coordinates[0] as number[][]
        const safeZone = turfBuffer(mergedFeature, -effectiveMargin, { units: 'meters' })
        if (safeZone?.geometry?.type === 'Polygon') {
          allRings.push(safeZone.geometry.coordinates[0] as number[][])
        }
      } else if (geomType === 'MultiPolygon') {
        // 이격 필지 → 각각 개별 Safe Zone
        const mpCoords = mergedFeature.geometry.coordinates as unknown as number[][][][]
        if (mpCoords[0]) cadastreRing = mpCoords[0][0]
        for (const polyCoords of mpCoords) {
          const singlePoly = turfPolygon(polyCoords as number[][][])
          const safeZone = turfBuffer(singlePoly, -effectiveMargin, { units: 'meters' })
          if (safeZone?.geometry?.type === 'Polygon') {
            allRings.push(safeZone.geometry.coordinates[0] as number[][])
          }
        }
      }

      const allPolygons = allRings
        .map(ring => convertGeoRingToLocalPolygon(ring, apiCoords.lat, apiCoords.lon))
        .filter(p => p.length >= 3)
      if (allPolygons.length === 0) return
      const cadastrePolygon = convertGeoRingToLocalPolygon(cadastreRing, apiCoords.lat, apiCoords.lon)
      const commonOpts = {
        azimuthDeg: svgAzimuthDeg,
        slopeAngleDeg: 0,
        slopeAzimuthDeg: 180,
        isJimokChangePlanned: false,
        panelOrientation: orientation,
        rowStack: stack,
      }
      // 단일/다구역 공통: allPolygons = turf-buffered safe zones (이중 margin 없음)
      const validPolygons = allPolygons.length > 1 ? allPolygons : undefined
      const precomputedSafeZonePolygon = allPolygons.length === 1
        ? allPolygons[0]
        : mergePolygonsToHull(allPolygons)

      if (svgZoneMode === 'multi') {
        // 다구역: Polygon/MultiPolygon 구분 없이 각 원본 필지를 개별 구역으로 처리
        const zones: ZoneConfig[] = parcels
          .filter(p => p.ring && p.ring.length >= 3)
          .map((parcel, idx) => {
            const ring = parcel.ring
            const closed = (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
              ? ring : [...ring, ring[0]]
            const parcelGeoJson = turfPolygon([closed])
            const safeGeoJson = turfBuffer(parcelGeoJson, -effectiveMargin, { units: 'meters' })
            if (!safeGeoJson || safeGeoJson.geometry.type !== 'Polygon') return null
            const safeRing = safeGeoJson.geometry.coordinates[0] as number[][]
            const safePolygon = convertGeoRingToLocalPolygon(safeRing, apiCoords.lat, apiCoords.lon)
            const cadastrePolyLocal = convertGeoRingToLocalPolygon(closed, apiCoords.lat, apiCoords.lon)
            return {
              label: `${String.fromCharCode(65 + idx)}구역`,
              polygon: cadastrePolyLocal,
              plotType: svgPlotType,
              panelSpec,
              panelType: svgPanelType,
              precomputedSafeZonePolygon: safePolygon,
              rowSpacing: effectiveRowSpacing,
              landStandard: svgPlotType === 'land',
              fixedGridAngle: svgPlotType === 'land' ||
                (installType === '건물지붕형' && jjokOlrim),
              workPath,
              spacingPolicy,
              constructionStdGap,
              firstStackGap: userFirstStackGap,
              ...commonOpts,
            } as ZoneConfig
          })
          .filter((z): z is ZoneConfig => z !== null)
        if (zones.length === 0) return
        const mzResult = runMultiZoneAnalysis(zones, lat)
        setSvgAnalysisResult(mzResult)
        setLastFullAnalysisJson(JSON.stringify(mzResult))
        setLastAnalysisAddress(addresses.filter(Boolean).join(', '))
        setIsEditing(false)
        setAnalysisKey(k => k + 1)
      } else {
        // single: precomputedSafeZonePolygon으로 이중 margin 방지
        const faResult = runFullAnalysis({
          cadastrePolygon,
          plotType: svgPlotType,
          panelSpec,
          panelType: svgPanelType,
          latitude: lat,
          precomputedSafeZonePolygon,
          validPolygons,
          rowSpacing: effectiveRowSpacing,
          landStandard: svgPlotType === 'land',
          fixedGridAngle: svgPlotType === 'land' ||
            (installType === '건물지붕형' && jjokOlrim),
          workPath,
          spacingPolicy,
          constructionStdGap,
          firstStackGap: userFirstStackGap,
          ...commonOpts,
        })
        setSvgAnalysisResult(faResult)
        setLastFullAnalysisJson(JSON.stringify(faResult))
        setLastAnalysisAddress(addresses.filter(Boolean).join(', '))
        setIsEditing(true)
        setAnalysisKey(k => k + 1)
      }
      setShowSvgCanvas(true)
    } catch (err) {
      console.error('SVG 분석 오류:', err)
    } finally {
      setSvgAnalyzing(false)
      analysisHasRunRef.current = true
      setAnalysisStale(false)
    }
  }, [apiCoords, parcels, roofPolygons, svgPanelType, svgAzimuthDeg, svgPanelOrientation, rowStack, svgPlotType, svgZoneMode, effectiveLatitude,
      autoSolarAngle, moduleIndex, tiltAngle, autoLandAngle, autoMargin,
      workPathM, installType, roofType, jjokOlrim, spacingPolicy, constructionStdGap, userFirstStackGap, userBoundaryMargin, userRowSpacing])

  // 통합 버튼 라벨·간이 연동용 — 현재 설정 기준 최종 1단 행간거리
  const displayFinalSpacing = (() => {
    const solarAng = autoSolarAngle ?? getSolarAngleByLocation(effectiveLatitude)
    const moduleLen = MODULES[moduleIndex].h
    const { rowSpacing: recommended } = calculateRowSpacing(solarAng, tiltAngle, autoLandAngle, moduleLen)
    const isGablePanel = installType === '건물지붕형' && roofType === '박공'
    const workDisplay = isGablePanel ? 0 : workPathM
    const projLen = moduleLen * Math.cos(tiltAngle * Math.PI / 180)
    const base = Math.round(((userRowSpacing ?? recommended) + autoMargin) * 100) / 100
    const effective = Math.round((base + workDisplay) * 100) / 100
    return (!isGablePanel && spacingPolicy === 'construction_std' && userFirstStackGap != null)
      ? Math.round((projLen + userFirstStackGap) * 100) / 100
      : effective
  })()

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
      {/* 토스트 알림 */}
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white text-xs rounded-lg px-4 py-2.5 shadow-lg pointer-events-none">
          {toastMsg}
        </div>
      )}
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

          {/* 경매 파일 자동 추출 (PDF/JPG/PNG 드롭존) */}
          <AuctionFileDropzone
            defaultCollapsed={addresses.some(a => a.trim().length > 0)}
            onParsed={jibuns => {
              const next = [...addresses]
              jibuns.slice(0, 5).forEach((j, i) => { next[i] = j })
              // 5개 미만이면 나머지는 기존 값 유지 (또는 빈 칸)
              setAddresses(next)
              setSearchError('')
            }}
            onAutoSearch={() => {
              // setAddresses는 비동기 — 다음 틱에 검색 트리거
              setTimeout(() => handleAddressSearch(), 0)
            }}
          />

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
          {landInfo && parcels.length > 0 && (
            <div className='mt-2'>
              <ParcelInfoCard
                landInfo={landInfo}
                smp={liveSmp}
                panelCount={panelCount || undefined}
                capacityKwp={capacityKwp || undefined}
                annualKwh={annualKwh || undefined}
              />
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
          {satFailed && !satLoading && mapMode === 'satellite' && (
            <div className="mt-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              ⚠ 위성 이미지를 불러올 수 없습니다 (Z{satZoom}). 지적도 모드를 사용하거나 잠시 후 재시도해 주세요.
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
              {/* 지붕 종류 — 슬라브/박공 */}
              <div>
                <label className="text-xs text-gray-500 font-medium">지붕 종류</label>
                <div className="flex gap-1.5 mt-1">
                  {(['슬라브', '박공'] as const).map(rt => (
                    <button key={rt}
                      onClick={() => { setRoofType(rt); if (rt === '슬라브') setJjokOlrim(false) }}
                      className={`flex-1 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        roofType === rt
                          ? 'bg-orange-500 text-white border-orange-500'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-orange-300'}`}>
                      {rt === '슬라브' ? '슬라브 (옥상/평지붕)' : '박공 (경사지붕)'}
                    </button>
                  ))}
                </div>
                {roofType === '박공' && (
                  <div className="mt-1.5 space-y-1">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={jjokOlrim}
                        onChange={e => setJjokOlrim(e.target.checked)}
                        className="accent-orange-500"/>
                      <span className="text-xs text-gray-700">쫙 올림 (용마루 무시, 직선 배치)</span>
                    </label>
                    <div className="bg-orange-50 border border-orange-200 rounded-lg p-2 text-xs text-orange-700">
                      박공 기준: 60평 ≈ 30kW · 이격 0.1m · 마진 50cm
                    </div>
                  </div>
                )}
              </div>
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

            {/* 배열 방법 (단수) — 간이·정밀 공용 */}
            <div>
              <label className="text-xs text-gray-500 font-medium">배열 방법 (단수)</label>
              <div className="flex gap-1.5 mt-1">
                {([1, 2, 3] as const).map(n => (
                  <button key={n} onClick={() => { setRowStack(n); if (showSvgCanvas) runSVGAnalysis({ rowStack: n }) }}
                    className={`flex-1 py-1 rounded-lg text-xs font-bold border transition-colors ${
                      rowStack === n ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-gray-600 border-gray-300 hover:border-violet-300'}`}>
                    {n}단
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-gray-400">간이·정밀 공용 — 단수 변경 시 두 분석 모두 반영</p>
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-500 font-medium">이격 거리 <span className="text-gray-400">(간이 분석)</span></label>
                <span className="text-xs text-gray-400">이론값: {theoreticalSpacing}m <span className="text-gray-300">ⓘ 참조용</span></span>
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
              <p className="mt-1 text-[10px] text-gray-400">정밀 분석은 우측 행간거리 자동 계산 패널을 사용하세요</p>
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
                {`  ·  경계마진 ${(userBoundaryMargin ?? (BOUNDARY_MARGIN[installType] ?? 2)).toFixed(1)}m${userBoundaryMargin != null ? ' (사용자 지정)' : ''}`}
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
            {/* z:0 — VWorld 기본지도(Base): 도로·건물 배경 (지적도 모드: 불투명 / 위성 모드: 미사용) */}
            {baseTiles.map((t, i) => (
              <img key={i} src={t.src} alt=""
                style={{
                  position: 'absolute',
                  left: `${t.cx / CANVAS_W * 100}%`,
                  top: `${t.cy / CANVAS_H * 100}%`,
                  width: `${t.px / CANVAS_W * 100}%`,
                  height: `${t.pxH / CANVAS_H * 100}%`,
                  zIndex: 0,
                  pointerEvents: 'none',
                }}
              />
            ))}
            {/* z:1 — VWorld WMS 지적도(투명 PNG): 지번·필지 경계 오버레이 (지적도 모드) */}
            {cadImgTiles.map((t, i) => (
              <img key={i} src={t.src} alt=""
                style={{
                  position: 'absolute',
                  left: `${t.cx / CANVAS_W * 100}%`,
                  top: `${t.cy / CANVAS_H * 100}%`,
                  width: `${t.px / CANVAS_W * 100}%`,
                  height: `${t.pxH / CANVAS_H * 100}%`,
                  zIndex: 1,
                  pointerEvents: 'none',
                }}
              />
            ))}
            {/* z:2 — Canvas: 위성사진(satellite) 또는 투명(cadastral) + 필지 polygon 드로잉 */}
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H}
              className="relative w-full h-auto border border-gray-200 rounded-lg cursor-default"
              style={{
                zIndex: 2,
                maxHeight: '500px',
                background: (baseTiles.length > 0 || cadImgTiles.length > 0) ? 'transparent' : '#f8fafc',
              }}
            />
            {/* z:3 — VWorld Base 도로 오버레이 (위성 모드 전용, mix-blend-mode:multiply로 도로만 표시) */}
            {roadImgTiles.map((t, i) => (
              <img key={i} src={t.src} alt=""
                style={{
                  position: 'absolute',
                  left: `${t.cx / CANVAS_W * 100}%`,
                  top: `${t.cy / CANVAS_H * 100}%`,
                  width: `${t.px / CANVAS_W * 100}%`,
                  height: `${t.pxH / CANVAS_H * 100}%`,
                  zIndex: 3,
                  pointerEvents: 'none',
                  mixBlendMode: 'multiply',
                }}
              />
            ))}
            {/* z:6 — 지붕 그리기 SVG 오버레이 (svgPlotType==='roof' 시 항상 마운트) */}
            {svgPlotType === 'roof' && (
              <svg
                viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                preserveAspectRatio="none"
                onClick={handleDrawingSvgClick}
                onDoubleClick={handleDrawingSvgDoubleClick}
                onMouseMove={handleDrawingSvgMouseMove}
                onMouseLeave={handleDrawingSvgMouseLeave}
                style={{
                  position: 'absolute',
                  top: 0, left: 0,
                  width: '100%', height: '100%',
                  zIndex: 6,
                  cursor: drawingMode ? 'crosshair' : 'default',
                  pointerEvents: drawingMode ? 'auto' : 'none',
                }}
              >
                {/* VWorld 필지 경계 — 회색 점선 참고용 */}
                {parcels.map((parcel, pi) => {
                  const pts = parcel.canvasPoints
                  if (pts.length < 2) return null
                  const d = `M${pts[0].x},${pts[0].y}` +
                    pts.slice(1).map(p => `L${p.x},${p.y}`).join('') + 'Z'
                  return (
                    <path key={pi} d={d} fill="none"
                      stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="4 2" />
                  )
                })}

                {/* 완성된 지붕 폴리곤들 */}
                {roofPolygons.map(poly => {
                  if (!canvasCenter) return null
                  const svgPts = poly.points.map(p =>
                    geoToCanvas(p.lng, p.lat, canvasCenter.lon, canvasCenter.lat, pixelScale)
                  )
                  if (svgPts.length < 2) return null
                  const cx = svgPts.reduce((s, p) => s + p.x, 0) / svgPts.length
                  const cy = svgPts.reduce((s, p) => s + p.y, 0) / svgPts.length
                  const ptStr = svgPts.map(p => `${p.x},${p.y}`).join(' ')
                  return (
                    <g key={poly.id}>
                      <polygon points={ptStr}
                        fill="rgba(34,197,94,0.18)" stroke="#16a34a" strokeWidth="2" />
                      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
                        fontSize="13" fontWeight="bold" fill="#166534"
                        style={{ pointerEvents: 'none' }}>
                        {poly.areaM2.toFixed(1)} m²
                      </text>
                    </g>
                  )
                })}

                {/* 현재 그리는 중인 폴리곤 */}
                {(() => {
                  if (!canvasCenter || currentDrawingPoints.length === 0) return null
                  const pts = currentDrawingPoints.map(p =>
                    geoToCanvas(p.lng, p.lat, canvasCenter.lon, canvasCenter.lat, pixelScale)
                  )
                  return (
                    <g>
                      {/* 정점 간 변 */}
                      {pts.slice(1).map((p, i) => (
                        <line key={i}
                          x1={pts[i].x} y1={pts[i].y} x2={p.x} y2={p.y}
                          stroke="#f59e0b" strokeWidth="2" />
                      ))}
                      {/* 마우스 위치까지 점선 미리보기 */}
                      {mouseCanvasPos && (
                        <line
                          x1={pts[pts.length - 1].x} y1={pts[pts.length - 1].y}
                          x2={mouseCanvasPos.x} y2={mouseCanvasPos.y}
                          stroke="#f59e0b" strokeWidth="2" strokeDasharray="5 3" />
                      )}
                      {/* 정점 원형 마커 */}
                      {pts.map((p, i) => (
                        <circle key={i} cx={p.x} cy={p.y} r="4"
                          fill="#f59e0b" stroke="#ffffff" strokeWidth="1.5" />
                      ))}
                    </g>
                  )
                })()}
              </svg>
            )}
          </div>

          {isComplete && area > 0 && (
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
              {/* 필지별 면적·수량 상세 */}
              {parcels.length > 1 && ringPanelCounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {parcels.map((p, i) => (
                    <span key={i} className="text-xs bg-slate-100 text-slate-700 rounded px-2 py-1">
                      필지{i + 1}{p.label ? ` (${p.label})` : ''} {p.areaSqm.toFixed(0)}m² · {ringPanelCounts[i] ?? 0}장
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Phase C-1: 지붕 폴리곤 그리기 UI (svgPlotType==='roof' 전용) ── */}
        {svgPlotType === 'roof' && isComplete && parcels.length > 0 && (
          <div className="mt-3 bg-amber-50 rounded-xl border border-amber-200 p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-amber-900 text-sm flex items-center gap-1.5">
                🏠 지붕 폴리곤 그리기
              </h4>
              <button
                onClick={() => {
                  if (drawingMode) { clearDrawing(); setDrawingMode(false) }
                  else { setDrawingMode(true) }
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                  drawingMode
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'bg-white border border-amber-300 text-amber-700 hover:bg-amber-100'
                }`}
              >
                {drawingMode ? '✏ 그리기 모드 ON' : '🏠 지붕 그리기 모드'}
              </button>
            </div>
            {drawingMode && (
              <p className="text-xs text-amber-700 bg-amber-100 rounded px-2 py-1.5 mb-2">
                {roofPolygons.length > 0
                  ? `건물 ${roofPolygons.length}개 완료. 다음 건물 외곽을 클릭으로 시작하세요.`
                  : '위성사진에서 지붕 외곽을 클릭으로 그려주세요.'}
                {" "}더블클릭으로 닫기, Esc 취소, Backspace로 마지막 정점 삭제.
                {currentDrawingPoints.length > 0 && (
                  <span className="ml-1 font-semibold text-amber-900">
                    (현재 {currentDrawingPoints.length}개 정점)
                  </span>
                )}
              </p>
            )}
            {roofPolygons.length > 0 && (
              <div className="space-y-1 mt-1">
                {roofPolygons.map((poly, i) => (
                  <div key={poly.id}
                    className="flex items-center justify-between bg-white rounded px-2 py-1 text-xs border border-amber-100">
                    <span className="text-gray-700">건물 {i + 1}: {poly.areaM2.toFixed(1)} m²</span>
                    <button
                      onClick={() => removePolygon(poly.id)}
                      className="text-red-500 hover:text-red-700 ml-2 font-medium">
                      삭제
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1.5 border-t border-amber-200 mt-1">
                  <span className="text-xs font-semibold text-amber-900">
                    합계: {roofPolygons.reduce((s, p) => s + p.areaM2, 0).toFixed(1)} m²
                  </span>
                  <button
                    onClick={clearAllPolygons}
                    className="text-xs text-red-500 hover:text-red-700 font-medium">
                    모두 지우기
                  </button>
                </div>
              </div>
            )}
            {roofPolygons.length === 0 && !drawingMode && (
              <p className="text-xs text-amber-600 text-center py-1">
                지붕 그리기 모드를 켜고 위성사진에서 지붕 외곽을 그려보세요.
              </p>
            )}
          </div>
        )}

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
                  <option value="land">토지</option>
                  <option value="roof">지붕</option>
                </select>
              </div>

              {/* 경계 마진 사용자 입력 */}
              <div className="col-span-2 rounded-md border border-gray-200 bg-gray-50 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-gray-600 font-medium" title={svgPlotType === 'roof' ? '지붕 경계 안전 거리. 시공사 통상 0.3~1.0m' : '부지 경계 안전 거리. 시공사 통상 0.5~2.0m'}>경계 마진 (m)</label>
                  {userBoundaryMargin != null && (
                    <button
                      onClick={() => setUserBoundaryMargin(undefined)}
                      className="text-[10px] text-gray-400 hover:text-red-500 transition-colors">
                      리셋
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0} max={5} step={0.1}
                    placeholder={svgPlotType === 'roof' ? '기본 0.5' : '기본 2.0'}
                    value={userBoundaryMargin ?? ''}
                    onChange={e => {
                      const v = parseFloat(e.target.value)
                      setUserBoundaryMargin(isNaN(v) ? undefined : v)
                    }}
                    className="w-20 text-xs border border-gray-300 rounded px-2 py-1.5 text-right font-mono bg-white"
                  />
                  <span className="text-xs text-gray-400">m</span>
                  {userBoundaryMargin != null ? (
                    <span className="text-[11px] text-amber-600 font-semibold">✎ {userBoundaryMargin.toFixed(1)}m 적용 중</span>
                  ) : (
                    <span className="text-[11px] text-gray-400">기본값 ({svgPlotType === 'roof' ? '0.5' : '2.0'}m)</span>
                  )}
                </div>
                <p className="mt-1.5 text-[10px] text-gray-400 leading-tight">
                  부지/지붕 경계로부터 패널까지의 안전 거리. 소규모 부지에서는 줄여서 사용
                </p>
              </div>

              {/* 패널 방향 (세로형/가로형) */}
              <div className="col-span-2">
                <label className="text-xs text-gray-500 font-medium block mb-1">패널 방향</label>
                <div className="flex gap-1.5">
                  {(['portrait', 'landscape'] as const).map(ori => (
                    <button key={ori} onClick={() => { setSvgPanelOrientation(ori); if (showSvgCanvas) runSVGAnalysis({ panelOrientation: ori }) }}
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
                  <label className="text-xs text-gray-500 font-medium">
                    방위각
                    {svgPlotType !== 'land' && !(installType === '건물지붕형' && jjokOlrim) &&
                      <span className="text-gray-400 font-normal ml-1">(배치 후 미세 조정)</span>}
                  </label>
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
                {/* 정렬 정책 안내 */}
                <div className="mt-1 text-[10px] text-gray-500 bg-gray-50 rounded px-2 py-1">
                  {svgPlotType === 'land'
                    ? '일반토지형: 정남향(180°) 기본 — 슬라이더 조정 후 재분석 가능'
                    : installType === '건물지붕형' && roofType === '박공' && jjokOlrim
                      ? `박공 쫙 올림: ${svgAzimuthDeg}° 그대로 고정 배치`
                      : '지붕형: 형태 자동 정렬 — 배치 후 그리드 방위각 버튼으로 미세 조정'}
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


            {/* 행간거리 자동 계산 — 정밀 분석 전용 */}
            {(() => {
              const solarAng = autoSolarAngle ?? getSolarAngleByLocation(effectiveLatitude)
              const moduleLen = MODULES[moduleIndex].h
              const result = calculateRowSpacing(solarAng, tiltAngle, autoLandAngle, moduleLen)
              const recommended = result.rowSpacing
              const isGablePanel = installType === '건물지붕형' && roofType === '박공'
              const workDisplay = isGablePanel ? 0 : workPathM
              const projLen = moduleLen * Math.cos(tiltAngle * Math.PI / 180)
              const baseSpacing = Math.round(((userRowSpacing ?? recommended) + autoMargin) * 100) / 100
              const effectiveSpacing = Math.round((baseSpacing + workDisplay) * 100) / 100
              const sg = Math.max(effectiveSpacing - projLen, 0)
              // Phase L: userFirstStackGap이 설정된 경우 1단 행간 = projLen + userFirstStackGap
              const finalSpacing = (!isGablePanel && spacingPolicy === 'construction_std' && userFirstStackGap != null)
                ? Math.round((projLen + userFirstStackGap) * 100) / 100
                : effectiveSpacing
              return (
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 space-y-2 mb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-sky-800">⚙ 1단 행간 결정</div>
                      <div className="text-[10px] text-sky-600 mt-0.5">1단 패널 사이의 거리. 모든 단수의 시작점.</div>
                    </div>
                    <span className="text-[10px] bg-sky-100 text-sky-600 px-1.5 py-0.5 rounded font-medium">정밀 분석</span>
                  </div>

                  {/* 입력 행 */}
                  <div className="grid grid-cols-3 gap-1.5">
                    <div>
                      <div className="text-[10px] text-gray-500 mb-0.5">모듈경사각</div>
                      <div className="flex items-center gap-0.5">
                        <input type="number" min={0} max={60} step={1}
                          value={tiltAngle}
                          onChange={e => setTiltAngle(Number(e.target.value))}
                          className="w-full px-1 py-0.5 text-xs border border-gray-300 rounded bg-white text-center font-mono" />
                        <span className="text-[10px] text-gray-400">°</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 mb-0.5">토지경사각 <span className="text-sky-500">(DEM)</span></div>
                      <div className="flex items-center gap-0.5">
                        <input type="number" min={0} max={45} step={0.5}
                          value={autoLandAngle}
                          onChange={e => setAutoLandAngle(Number(e.target.value))}
                          className="w-full px-1 py-0.5 text-xs border border-gray-300 rounded bg-white text-center font-mono" />
                        <span className="text-[10px] text-gray-400">°</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 mb-0.5">태양각(동지) <span className="text-sky-500">(위도)</span></div>
                      <div className="flex items-center gap-0.5">
                        <input type="number" min={10} max={50} step={0.5}
                          value={autoSolarAngle ?? Math.round(getSolarAngleByLocation(effectiveLatitude) * 10) / 10}
                          onChange={e => setAutoSolarAngle(Number(e.target.value))}
                          className="w-full px-1 py-0.5 text-xs border border-gray-300 rounded bg-white text-center font-mono" />
                        <span className="text-[10px] text-gray-400">°</span>
                      </div>
                    </div>
                  </div>

                  {/* 계산 결과 */}
                  <div className="bg-white rounded border border-sky-200 px-2 py-1.5 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">권장 행간거리 <span className="text-gray-400 text-[10px]">(자동 {recommended.toFixed(3)}m)</span></span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number" min={0.5} max={15} step={0.05}
                          placeholder={recommended.toFixed(2)}
                          value={userRowSpacing ?? ''}
                          onChange={e => {
                            const v = parseFloat(e.target.value)
                            setUserRowSpacing(isNaN(v) ? undefined : v)
                          }}
                          className="w-20 text-xs border border-sky-300 rounded px-2 py-0.5 text-right font-mono bg-white"
                        />
                        <span className="text-gray-400">m</span>
                        {userRowSpacing != null && (
                          <button onClick={() => setUserRowSpacing(undefined)}
                            className="text-[10px] text-gray-400 hover:text-red-500 transition-colors">리셋</button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500" title="권장 행간거리에 그늘 회피 + 시공 여유 이미 포함. 추가 운영 통로 필요시 입력">작업 통로</span>
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} max={2} step={0.1}
                          value={workPathM}
                          placeholder="0"
                          onChange={e => setWorkPathM(Number(e.target.value))}
                          disabled={isGablePanel}
                          title="권장 행간거리에 그늘 회피 + 시공 여유 이미 포함. 추가 운영 통로 필요시 입력"
                          className="w-12 px-1 py-0.5 text-xs border border-gray-300 rounded text-center font-mono disabled:opacity-40" />
                        <span className="text-gray-400">m</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500" title="측량 오차/시공 편차 추가 여유. 일반적으로 0m">안전 마진</span>
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} max={3} step={0.1}
                          value={autoMargin}
                          placeholder="0"
                          onChange={e => setAutoMargin(Number(e.target.value))}
                          title="측량 오차/시공 편차 추가 여유. 일반적으로 0m"
                          className="w-12 px-1 py-0.5 text-xs border border-gray-300 rounded text-center font-mono" />
                        <span className="text-gray-400">m</span>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs border-t border-sky-100 pt-1">
                      <span className="text-gray-700 font-medium">최종 적용값</span>
                      <span className="font-bold text-emerald-700 text-sm">{finalSpacing.toFixed(2)}m</span>
                    </div>
                  </div>

                  {/* ── 2단 이상 단수 정책 ── */}
                  {!isGablePanel && (
                    <>
                      <div className="border-t border-sky-200 pt-0.5" />
                      <div className="rounded-md border border-sky-200 bg-white p-2.5 space-y-2">
                        <div>
                          <div className="text-xs font-semibold text-sky-800">≡ 2단 이상 단수 정책</div>
                          <div className="text-[10px] text-sky-600 mt-0.5">단수가 늘어날 때 그늘을 어떻게 처리할지</div>
                        </div>
                      {(['construction_std', 'shadow_avoid'] as const).map(pol => (
                        <label key={pol} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="spacingPolicy"
                            value={pol}
                            checked={spacingPolicy === pol}
                            onChange={() => setSpacingPolicy(pol)}
                            className="mt-0.5 accent-sky-500"
                          />
                          <span className="text-[11px] text-gray-700 leading-tight">
                            {pol === 'construction_std' ? (
                              <><span className="font-semibold text-sky-700">시공 표준</span> — 빈공간 단수 무관 <span className="text-[10px] text-sky-600 font-semibold">(기본값)</span></>
                            ) : (
                              <><span className="font-semibold text-violet-700">그늘 회피</span> — 단수 비례, 동지 정오 100% 회피</>
                            )}
                          </span>
                        </label>
                      ))}
                      {/* 1단/2단+ 빈공간 입력 (시공표준 전용) */}
                      {spacingPolicy === 'construction_std' && (
                        <div className="space-y-1 pt-1">
                          <div className="flex items-center gap-2">
                            <label className="text-[11px] text-gray-600 whitespace-nowrap w-16">1단 빈공간</label>
                            <input
                              type="number"
                              min={0.1}
                              max={5}
                              step={0.1}
                              placeholder={sg.toFixed(2)}
                              value={userFirstStackGap ?? ''}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setUserFirstStackGap(isNaN(v) ? undefined : v)
                              }}
                              title="1단은 그늘이 짧아 더 작게 잡아도 안전. 시공사 통상 2.0~2.4m"
                              className="w-16 text-[11px] border border-gray-300 rounded px-1.5 py-0.5 text-right"
                            />
                            <span className="text-[11px] text-gray-500">m <span className="text-sky-600">(통상 2.0~2.4m)</span></span>
                            {userFirstStackGap != null && (
                              <button onClick={() => setUserFirstStackGap(undefined)}
                                className="text-[10px] text-gray-400 hover:text-red-500">초기화</button>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <label className="text-[11px] text-gray-600 whitespace-nowrap w-16">2단+ 빈공간</label>
                            <input
                              type="number"
                              min={0.1}
                              max={5}
                              step={0.1}
                              placeholder={sg.toFixed(2)}
                              value={constructionStdGap ?? ''}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setConstructionStdGap(isNaN(v) ? undefined : v)
                              }}
                              title="2단 이상 빈공간. 시공사 통상 2.4m 권장"
                              className="w-16 text-[11px] border border-gray-300 rounded px-1.5 py-0.5 text-right"
                            />
                            <span className="text-[11px] text-gray-500">m <span className="text-sky-600">(통상 2.4m)</span></span>
                            {constructionStdGap != null && (
                              <button onClick={() => setConstructionStdGap(undefined)}
                                className="text-[10px] text-gray-400 hover:text-red-500">초기화</button>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-400 leading-tight">1단은 그늘이 짧으므로 빈공간을 더 작게 잡아도 안전. 2단+는 시공사 통상 2.4m 권장.</p>
                        </div>
                      )}
                      {/* 행간/빈공간 미리보기 (시공표준 기준, 그늘회피는 주석 표시) */}
                      {(() => {
                        // projLen, sg는 외부 IIFE 스코프에서 사용
                        const firstGapStd = userFirstStackGap ?? sg
                        const rows = [1, 2, 3].map(n => {
                          const gh = n * projLen + (n - 1) * 0.02
                          const stdGap = n === 1 ? firstGapStd : (constructionStdGap ?? sg)
                          const stdSpacing = n === 1
                            ? parseFloat((projLen + firstGapStd).toFixed(2))
                            : parseFloat((gh + stdGap).toFixed(2))
                          const avoidGap = n * sg
                          const avoidSameAsStd = Math.abs(avoidGap - stdGap) < 0.005
                          return { n, stdSpacing, stdGap, avoidGap, avoidSameAsStd }
                        })
                        return (
                          <div className="mt-1 text-[10px]">
                            <div className="grid grid-cols-3 gap-x-1 font-semibold border-b border-gray-100 pb-0.5 mb-0.5 text-gray-500">
                              <span>단수</span>
                              <span title="한 행 시작점부터 다음 행 시작점 (모듈 길이 + 빈공간)" className="text-sky-600 text-center cursor-help">행간 ↔</span>
                              <span title="한 모듈 끝에서 다음 모듈 시작까지의 빈 공간" className="text-center cursor-help">빈공간</span>
                            </div>
                            {rows.map(r => (
                              <div key={r.n} className={`grid grid-cols-3 gap-x-1 py-0.5 ${r.n === 1 ? 'text-gray-400' : 'text-gray-600'}`}>
                                <span>{r.n}단</span>
                                <span className="text-center font-mono text-sky-700 font-semibold">{r.stdSpacing.toFixed(2)}m</span>
                                <div className="text-right leading-tight">
                                  <span className="font-mono">{r.stdGap.toFixed(2)}m</span>
                                  <div className="text-[9px] text-gray-400">
                                    {r.avoidSameAsStd ? '(회피동일)' : `(회피 ${r.avoidGap.toFixed(2)}m)`}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                      </div>
                    </>
                  )}

                  {/* 미니 단면도 */}
                  <svg viewBox="0 0 200 72" className="w-full" style={{ height: '120px' }}>
                    <line x1="0" y1="56" x2="200" y2="56" stroke="#9ca3af" strokeWidth="2"/>
                    <line x1="10" y1="56" x2="40" y2="34" stroke="#3b82f6" strokeWidth="3" strokeLinecap="round"/>
                    <rect x="40" y="34" width={Math.min(70, Math.round(result.moduleToModuleGap * 20))} height="22"
                      fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.6)" strokeWidth="1" strokeDasharray="3,2"/>
                    <line x1={Math.min(110, 40 + Math.round(result.moduleToModuleGap * 20))} y1="56"
                      x2={Math.min(140, 70 + Math.round(result.moduleToModuleGap * 20))} y2="34"
                      stroke="#3b82f6" strokeWidth="3" strokeLinecap="round"/>
                    <line x1="40" y1="8" x2="18" y2="34" stroke="#f59e0b" strokeWidth="1.5"/>
                    <text x="44" y="52" fontSize="9" fill="#6b7280">빈공간 {result.moduleToModuleGap.toFixed(2)}m</text>
                    <text x="80" y="69" fontSize="9" fill="#9ca3af">행간 {recommended.toFixed(2)}m</text>
                    <text x="2" y="69" fontSize="9" fill="#3b82f6">모듈</text>
                    <text x="43" y="14" fontSize="9" fill="#f59e0b">태양 {Math.round(solarAng)}°</text>
                    <text x="162" y="53" fontSize="9" fill="#9ca3af">토지</text>
                    <text x="143" y="69" fontSize="9" fill="#3b82f6">다음 모듈</text>
                  </svg>

                  {/* 간이에도 적용 체크박스 */}
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={applyToQuick} onChange={e => setApplyToQuick(e.target.checked)}
                      className="accent-sky-500 w-3 h-3" />
                    <span className="text-[10px] text-gray-500">간이 분석에도 동시 적용</span>
                  </label>

                </div>
              )
            })()}

            {/* 정밀 분석 실행 버튼 (통합) */}
            <div className="space-y-1.5">
              {analysisStale && (
                <div className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1 text-center">
                  ⚠ 설정 변경됨 — 재분석 필요
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (applyToQuick) setSpacingValue(displayFinalSpacing)
                    runSVGAnalysis()
                  }}
                  disabled={svgAnalyzing}
                  className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors">
                  {svgAnalyzing ? '분석 중...' : `▶ 정밀 분석 실행 (${displayFinalSpacing.toFixed(2)}m 적용)`}
                </button>
                {svgAnalysisResult && (
                  <button
                    onClick={() => setShowSvgCanvas(v => !v)}
                    className="px-3 py-2 border border-indigo-300 text-indigo-600 text-xs rounded-lg hover:bg-indigo-50">
                    {showSvgCanvas ? '숨기기' : '결과 보기'}
                  </button>
                )}
              </div>
            </div>

            {/* 결과 표시 */}
            {showSvgCanvas && svgAnalysisResult && (
              <div className="mt-3" ref={svgContainerRef}>
                {/* 툴바: 구역 탭(다구역) + 편집 버튼(단일/다구역 공통) */}
                <div className="flex items-center justify-between mb-2 gap-2">
                  {/* 다구역 구역 선택 탭 */}
                  {isMultiZoneResult(svgAnalysisResult) ? (
                    <div className="flex gap-1 flex-wrap">
                      {(svgAnalysisResult as MultiZoneResult).zones.map(z => {
                        const zid = z.zoneLabel.replace('구역', '')
                        return (
                          <button
                            key={z.zoneLabel}
                            onClick={() => { setActiveZoneId(zid); setIsEditing(false); setEditingCount(null) }}
                            className={[
                              'px-2.5 py-1 rounded text-xs font-semibold transition-colors',
                              activeZoneId === zid
                                ? 'bg-indigo-500 text-white'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                            ].join(' ')}
                          >
                            {z.zoneLabel} {z.layout.totalCount}장
                          </button>
                        )
                      })}
                      <span className="text-xs text-slate-400 ml-1 self-center">{`| 전체 ${(svgAnalysisResult as MultiZoneResult).zones.reduce((s, z) => s + z.layout.totalCount, 0)}장`}</span>
                    </div>
                  ) : (
                    <div />
                  )}
                  {/* 다운로드 버튼 — 편집 모드가 아닐 때만 */}
                  {!isEditing && svgAnalysisResult && (
                    <div className="flex gap-1">
                      <button
                        onClick={handleLayoutDownloadPNG}
                        className="px-2.5 py-1.5 rounded text-xs font-semibold bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-500 flex-shrink-0"
                        title="배치도 PNG 저장"
                      >
                        ↓ PNG
                      </button>
                      <button
                        onClick={handleLayoutDownloadPDF}
                        className="px-2.5 py-1.5 rounded text-xs font-semibold bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-500 flex-shrink-0"
                        title="배치도 PDF 출력"
                      >
                        ↓ PDF
                      </button>
                    </div>
                  )}
                  {/* 편집 버튼 — 단일/다구역 공통 */}
                  <button
                    onClick={() => setIsEditing(v => !v)}
                    className={[
                      'px-3 py-1.5 rounded text-xs font-semibold transition-colors flex-shrink-0',
                      isEditing
                        ? 'bg-amber-500 text-slate-900 hover:bg-amber-400'
                        : 'bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-500',
                    ].join(' ')}
                  >
                    {isEditing
                      ? `✏ 편집 중${isMultiZoneResult(svgAnalysisResult) ? ` (${activeZoneId}구역)` : ''}`
                      : `✏ 배치 편집${isMultiZoneResult(svgAnalysisResult) ? ` (${activeZoneId}구역)` : ''}`}
                  </button>
                </div>

                {/* 편집 모드: 다구역은 항상 LayoutEditor 표시, 단일은 isEditing 시에만 */}
                {(isEditing || isMultiZoneResult(svgAnalysisResult)) ? (
                  <LayoutEditor
                    key={`${analysisKey}-${isMultiZoneResult(svgAnalysisResult) ? activeZoneId : 'single'}`}
                    result={
                      isMultiZoneResult(svgAnalysisResult)
                        ? (svgAnalysisResult as MultiZoneResult).zones.find(
                            z => z.zoneLabel === activeZoneId + '구역'
                          ) as FullAnalysisResult
                        : svgAnalysisResult as FullAnalysisResult
                    }
                    zoneLabel={isMultiZoneResult(svgAnalysisResult) ? activeZoneId + '구역' : undefined}
                    backgroundZones={
                      isMultiZoneResult(svgAnalysisResult)
                        ? (svgAnalysisResult as MultiZoneResult).zones.filter(
                            (z): z is ZoneLayoutResult => z.zoneLabel !== activeZoneId + '구역'
                          )
                        : undefined
                    }
                    width={svgContainerWidth}
                    height={Math.round(svgContainerWidth * 520 / 920)}
                    onCountChange={(count) => {
                      setEditingCount(count)
                      if (isMultiZoneResult(svgAnalysisResult)) {
                        setSvgAnalysisResult(prev => {
                          if (!prev || !isMultiZoneResult(prev)) return prev
                          const zoneLabel = activeZoneId + '구역'
                          const updatedZones = (prev as MultiZoneResult).zones.map(z =>
                            z.zoneLabel === zoneLabel
                              ? { ...z, layout: { ...z.layout, totalCount: count } }
                              : z
                          )
                          return {
                            ...(prev as MultiZoneResult),
                            zones: updatedZones,
                            totalCount: updatedZones.reduce((s, z) => s + z.layout.totalCount, 0),
                          }
                        })
                      }
                    }}
                    onComplete={(placements, totalKwp) => {
                      if (isMultiZoneResult(svgAnalysisResult)) {
                        // 다구역: activeZoneId 구역만 직접 업데이트
                        const mzResult = svgAnalysisResult as MultiZoneResult
                        const zoneLabel = activeZoneId + '구역'
                        const updatedZones = mzResult.zones.map(z =>
                          z.zoneLabel === zoneLabel
                            ? {
                                ...z,
                                layout: {
                                  ...z.layout,
                                  placements,
                                  totalCount: placements.length,
                                  totalKwp,
                                  utilizationRate: placements.length / (z.layout.theoreticalMax || 1),
                                },
                              }
                            : z
                        )
                        const newTotalCount = updatedZones.reduce((s, z) => s + z.layout.totalCount, 0)
                        const newTotalKwp = parseFloat(
                          updatedZones.reduce((s, z) => s + z.layout.totalKwp, 0).toFixed(2)
                        )
                        const updatedMz = { ...mzResult, zones: updatedZones, totalCount: newTotalCount, totalKwp: newTotalKwp }
                        setSvgAnalysisResult(updatedMz)
                        setLastFullAnalysisJson(JSON.stringify(updatedMz))
                      } else {
                        // 단일 구역
                        const faResult = svgAnalysisResult as FullAnalysisResult
                        const updatedSingle: FullAnalysisResult = {
                          ...faResult,
                          layout: {
                            ...faResult.layout,
                            placements,
                            totalCount: placements.length,
                            totalKwp,
                            utilizationRate: placements.length / (faResult.layout.theoreticalMax || 1),
                          },
                        }
                        setSvgAnalysisResult(updatedSingle)
                        setLastFullAnalysisJson(JSON.stringify(updatedSingle))
                        setIsEditing(false)
                      }
                      setEditingCount(null)
                    }}
                    reanalysisOptions={{
                      panelSpec: PRESET_PANELS[svgPanelType] ?? PRESET_PANELS.GS710wp,
                      rowStack,
                      landStandard: svgPlotType === 'land',
                      rowSpacing: installType === '건물지붕형' && roofType === '박공' ? 0.1 : undefined,
                      spacingPolicy,
                      constructionStdGap,
                    }}
                    onCancel={() => { setIsEditing(false); setEditingCount(null) }}
                  />
                ) : (
                  <div>
                    <SolarLayoutCanvas
                      result={svgAnalysisResult}
                      width={svgContainerWidth}
                      height={Math.round(svgContainerWidth * 480 / 700)}
                      showLabels
                      activeZoneId={isMultiZoneResult(svgAnalysisResult) ? activeZoneId : undefined}
                      geoOrigin={apiCoords ?? undefined}
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
                    {/* 다구역 — 구역별 요약 */}
                    {isMultiZoneResult(svgAnalysisResult) && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                          <span>{svgPlotType === 'roof' ? '지붕면적 합계' : '토지면적'}</span>
                          <span className="font-semibold text-slate-700">
                            {(svgAnalysisResult as MultiZoneResult).totalAreaM2.toFixed(1)} m²
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {(svgAnalysisResult as MultiZoneResult).zones.map(z => (
                            <div
                              key={z.zoneLabel}
                              className={`rounded p-2 text-xs cursor-pointer transition-colors ${
                                activeZoneId === z.zoneLabel.replace('구역', '')
                                  ? 'bg-indigo-100 border border-indigo-300'
                                  : 'bg-indigo-50 border border-transparent hover:border-indigo-200'
                              }`}
                              onClick={() => { setActiveZoneId(z.zoneLabel.replace('구역', '')); setIsEditing(false) }}
                            >
                              <div className="font-semibold text-indigo-700">{z.zoneLabel}</div>
                              <div className="text-gray-600">{z.layout.totalCount}장 · {z.layout.totalKwp}kWp</div>
                            </div>
                          ))}
                        </div>
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
