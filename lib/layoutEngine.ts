// lib/layoutEngine.ts — 지리 미터 좌표 기반 패널 배치 레이아웃 엔진 (v5.2)
// MapTab의 캔버스 픽셀 기반 배치와 달리, 순수 지리 미터 좌표로 동작하는 독립 모듈
// React 상태와 완전히 분리된 순수 함수(Pure Function)로 구성
// v5.2: 방위각 그리드 회전, 하천/도로 마진, 지목변경 예정, 이용률 검증

import type { PanelSpec } from './panelConfig'
import { optimizeTiltAngle, getRegionByLatitude, getRowSpacing, validateAgainstRealCases, type ValidationReport } from './shadowCalculator'

// ── 타입 ───────────────────────────────────────────────────────────

/** 지리 미터 좌표 (local ENU 기준, 단위: m) */
export interface Point {
  x: number  // 동서 방향 (동=+)
  y: number  // 남북 방향 (북=+)
}

export type Polygon = Point[]

/** 개별 패널 배치 정보 */
export interface PanelPlacement {
  id: number
  /** 패널 4 꼭짓점 (TL→TR→BR→BL 순, 방위각 회전 적용됨) */
  corners: [Point, Point, Point, Point]
  centerX: number
  centerY: number
  row: number
  col: number
}

export interface LayoutResult {
  placements: PanelPlacement[]
  totalCount: number
  totalKwp: number
  /** 패널 실면적 / Safe Zone 면적 */
  coverageRatio: number
  /** 이론 최대 패널 수 (Safe Zone 면적 / 패널 단독 풋프린트) */
  theoreticalMax: number
  /** 실제 배치 수 / 이론 최대 = 이용률 (0~1) */
  utilizationRate: number
}

/** 부지 용도 타입
 * v5.2: 'land_change_planned' 추가 (지목변경 예정)
 */
export type PlotType = 'land' | 'roof' | 'farmland' | 'forest' | 'land_change_planned'

/** 경계 구간 종류 (하천·도로 특별 마진용) */
export type BoundarySegmentType = 'river' | 'road' | 'default'

export interface BoundarySegment {
  /** 시작 꼭짓점 인덱스 (원본 폴리곤 기준) */
  fromIndex: number
  /** 끝 꼭짓점 인덱스 */
  toIndex: number
  type: BoundarySegmentType
}

export interface SafeZoneResult {
  safeZonePolygon: Polygon
  originalPolygon: Polygon
  marginApplied: number
  plotType: PlotType
  originalAreaM2: number
  safeAreaM2: number
  error?: string
}

export interface FullAnalysisResult {
  safeZone: SafeZoneResult
  optimalTilt: number
  rowSpacing: number
  layout: LayoutResult
  region: string
  /** 패널 타입 ID (PRESET_PANELS의 key) */
  panelType: string
  /** 적용된 방위각 (°), 기본 180 */
  azimuthDeg: number
  /** 패널 방향 */
  panelOrientation: 'portrait' | 'landscape'
  /** 실증 크로스체크 결과 (선택) */
  validation?: ValidationReport
}

// ── 상수 ───────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180

/** 하천 경계 마진 (m) — v5.2 신규 */
export const RIVER_MARGIN = 5.0

/** 도로 경계 마진 (m) — v5.2 신규 */
export const ROAD_MARGIN = 3.0

/** 용도별 기본 경계 이격 마진 (m) */
const MARGIN_RULES: Record<PlotType, number> = {
  land: 2.0,
  farmland: 2.0,
  forest: 2.0,
  roof: 0.5,
  land_change_planned: 1.5,  // v5.2: 지목변경 예정 부지
}

// ── 기하 유틸 ──────────────────────────────────────────────────────

/** Ray-casting 알고리즘: 점이 폴리곤 내부인지 검사 */
export function isPointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    if ((yi > point.y) !== (yj > point.y) &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * 패널 4 꼭짓점이 모두 폴리곤 내부인지 검사
 * 하나라도 밖이면 false (Hard Constraint)
 */
export function isPanelInsidePolygon(
  panelCorners: [Point, Point, Point, Point],
  polygon: Polygon
): boolean {
  return panelCorners.every(corner => isPointInPolygon(corner, polygon))
}

/** 슈 공식(Shoelace Formula)으로 폴리곤 면적 계산 (m²) */
export function polygonAreaM2(polygon: Polygon): number {
  let area = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y
  }
  return Math.abs(area / 2)
}

/** 폴리곤 무게중심 */
export function polygonCentroid(polygon: Polygon): Point {
  return {
    x: polygon.reduce((s, p) => s + p.x, 0) / polygon.length,
    y: polygon.reduce((s, p) => s + p.y, 0) / polygon.length,
  }
}

/**
 * 폴리곤 안쪽으로 marginM만큼 축소
 * 각 변을 내부 방향으로 평행이동 후 Sutherland-Hodgman 교점 재계산
 * 중심점 기반 균등 축소보다 정확 (모든 변에서 균일한 이격 거리 보장)
 */
export function applyInsetMargin(polygon: Polygon, marginM: number): Polygon {
  if (polygon.length < 3) return polygon
  const n = polygon.length

  // 슈 공식으로 부호 있는 면적 계산 → 권선 방향 결정
  // CCW(양수) = 왼손 법선(-dy, dx)이 안쪽, CW(음수) = 오른손 법선(dy, -dx)이 안쪽
  // 무게중심 기반 체크는 오목(L자형) 폴리곤에서 무게중심이 폴리곤 밖으로 나가 오작동
  let signedArea2 = 0
  for (let i = 0; i < n; i++) {
    const p1 = polygon[i], p2 = polygon[(i + 1) % n]
    signedArea2 += p1.x * p2.y - p2.x * p1.y
  }
  const isCCW = signedArea2 > 0  // CCW: 안쪽 법선 = 왼손(-dy, dx)

  const lines: Array<{ a: number; b: number; c: number }> = []
  for (let i = 0; i < n; i++) {
    const p1 = polygon[i]
    const p2 = polygon[(i + 1) % n]
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-9) continue
    // CCW: 안쪽 법선 = (-dy, dx),  CW: 안쪽 법선 = (dy, -dx)
    const nx = isCCW ? -dy / len :  dy / len
    const ny = isCCW ?  dx / len : -dx / len
    // 변을 안쪽으로 marginM만큼 이동: 새 직선의 점 = p1 + normal * marginM
    const ox = p1.x + nx * marginM
    const oy = p1.y + ny * marginM
    // 직선 방정식: dy*x - dx*y = dy*ox - dx*oy
    lines.push({ a: dy, b: -dx, c: dy * ox - dx * oy })
  }

  if (lines.length < 3) return polygon

  // 인접한 두 직선의 교점 계산
  const result: Point[] = []
  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[i]
    const l2 = lines[(i + 1) % lines.length]
    const det = l1.a * l2.b - l2.a * l1.b
    if (Math.abs(det) < 1e-9) continue  // 평행선: 스킵
    result.push({
      x: (l1.c * l2.b - l2.c * l1.b) / det,
      y: (l1.a * l2.c - l2.a * l1.c) / det,
    })
  }

  if (result.length < 3) return polygon

  // 축소된 폴리곤이 원본보다 커지지 않았는지 확인 (음수 마진 방지)
  const newArea = polygonAreaM2(result)
  const origArea = polygonAreaM2(polygon)
  if (newArea >= origArea) return polygon

  return result
}

/**
 * 점을 중심(cx, cy) 기준으로 angleDeg만큼 회전
 */
function rotatePoint(p: Point, cx: number, cy: number, angleDeg: number): Point {
  const cos = Math.cos(angleDeg * DEG2RAD)
  const sin = Math.sin(angleDeg * DEG2RAD)
  const dx = p.x - cx
  const dy = p.y - cy
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }
}

/**
 * 패널 중심·사양·경사각·방위각 → 4 꼭짓점 (회전 적용)
 * TL→TR→BR→BL 순
 *
 * @param cx 패널 중심 x (m)
 * @param cy 패널 중심 y (m)
 * @param panelSpec 패널 사양
 * @param tiltAngle 경사각 (°)
 * @param azimuthDeg 방위각 (°), 180=정남
 */
export function rotatePanelCorners(
  cx: number,
  cy: number,
  panelSpec: PanelSpec,
  tiltAngle: number,
  azimuthDeg: number,
  panelOrientation: 'portrait' | 'landscape' = 'portrait'
): [Point, Point, Point, Point] {
  // 가로형: N-S = widthM, E-W = lengthM
  const effNS = panelOrientation === 'landscape' ? panelSpec.widthM : panelSpec.lengthM
  const effEW = panelOrientation === 'landscape' ? panelSpec.lengthM : panelSpec.widthM
  const projLen = effNS * Math.cos(tiltAngle * DEG2RAD)
  const hw = effEW / 2
  const hl = projLen / 2
  const offset = azimuthDeg - 180

  const raw: [Point, Point, Point, Point] = [
    { x: cx - hw, y: cy - hl },  // TL
    { x: cx + hw, y: cy - hl },  // TR
    { x: cx + hw, y: cy + hl },  // BR
    { x: cx - hw, y: cy + hl },  // BL
  ]
  return raw.map(p => rotatePoint(p, cx, cy, offset)) as [Point, Point, Point, Point]
}

// ── 핵심 배치 함수 ─────────────────────────────────────────────────

/**
 * 주어진 그리드 각도로 패널 배치 시도 (내부 헬퍼)
 * @param gridAngle 그리드 회전 각도 (°) — 폴리곤을 이 각도로 정렬 후 수평 격자 배치
 * @param rowStack 단수 (1단/2단/3단) — 그룹 내 행 수. 그룹 내 행 간격 2cm, 그룹 간격 = rowSpacing
 */
function placeGridAtAngle(
  safeZonePolygon: Polygon,
  panelSpec: PanelSpec,
  rowSpacing: number,
  tiltAngle: number,
  panelOrientation: 'portrait' | 'landscape',
  excludeZones: Polygon[],
  gridAngle: number,
  rowStack: number = 1,
  validPolygons?: Polygon[],
): PanelPlacement[] {
  const effNS = panelOrientation === 'landscape' ? panelSpec.widthM : panelSpec.lengthM
  const effEW = panelOrientation === 'landscape' ? panelSpec.lengthM : panelSpec.widthM
  const projLen = effNS * Math.cos(tiltAngle * DEG2RAD)
  const colPitch = effEW + 0.02
  const stack = Math.max(1, Math.round(rowStack))
  const intraGap = 0.02  // 단 내 행간 간격 (2cm)
  // 단 높이: stack개의 패널 + (stack-1)개의 intraGap
  const groupHeight = stack * projLen + (stack - 1) * intraGap
  // 단 간격: 단 시작점 기준 = 단 높이 + 음영 이격거리
  const groupPitch = groupHeight + rowSpacing

  const centroid = polygonCentroid(safeZonePolygon)
  const rotatedPoly = safeZonePolygon.map(p => rotatePoint(p, centroid.x, centroid.y, -gridAngle))
  const rotatedValidPolys = validPolygons?.map(poly =>
    poly.map(p => rotatePoint(p, centroid.x, centroid.y, -gridAngle))
  )

  const xs = rotatedPoly.map(p => p.x)
  const ys = rotatedPoly.map(p => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const placements: PanelPlacement[] = []
  let id = 0
  let groupIdx = 0

  for (let yGroup = minY; yGroup + groupHeight <= maxY; yGroup += groupPitch, groupIdx++) {
    for (let si = 0; si < stack; si++) {
      const y = yGroup + si * (projLen + intraGap)
      const row = groupIdx * stack + si
      let col = 0
      for (let x = minX; x + effEW <= maxX; x += colPitch, col++) {
        const rotatedCorners: [Point, Point, Point, Point] = [
          { x,            y },
          { x: x + effEW, y },
          { x: x + effEW, y: y + projLen },
          { x,            y: y + projLen },
        ]
        const centerRotated = { x: x + effEW / 2, y: y + projLen / 2 }
        const passes = rotatedValidPolys
          ? rotatedValidPolys.some(poly => isPointInPolygon(centerRotated, poly))
          : isPointInPolygon(centerRotated, rotatedPoly)
        if (!passes) continue

        const actualCorners = rotatedCorners.map(
          p => rotatePoint(p, centroid.x, centroid.y, gridAngle)
        ) as [Point, Point, Point, Point]

        const center = rotatePoint(
          { x: x + effEW / 2, y: y + projLen / 2 },
          centroid.x, centroid.y, gridAngle
        )

        if (excludeZones.some(zone => isPointInPolygon(center, zone))) continue

        placements.push({ id: id++, corners: actualCorners, centerX: center.x, centerY: center.y, row, col })
      }
    }
  }
  return placements
}

/**
 * Safe Zone 폴리곤 내부에 패널을 격자 배치
 * v5.3: 폴리곤 형태에 최적화된 그리드 각도 자동 탐색 (0°~175°, 5° 단위)
 * 기울어진·불규칙 폴리곤에서 최대 패널 수를 배치하는 각도를 자동 선택
 */
export function generateLayout(params: {
  safeZonePolygon: Polygon
  panelSpec: PanelSpec
  rowSpacing: number
  tiltAngle: number
  /** 방위각 (°), 기본 180 = 정남향 */
  azimuthDeg?: number
  /** 제외 구역 폴리곤 배열 */
  excludeZones?: Polygon[]
  /** 이용률 목표 (0~1), 미설정 시 100% 시도 */
  utilizationTarget?: number
  /** 패널 방향 — 'landscape': 패널을 90° 눕혀서 widthM을 N-S로 사용 */
  panelOrientation?: 'portrait' | 'landscape'
  /** 단수 (1~3) — 음영 이격 간격 없이 묶는 행 수, 기본 1 */
  rowStack?: number
  /** 복수 필지 PIP용: 중심점이 이 중 하나 이상 안에 있어야 배치 */
  validPolygons?: Polygon[]
}): LayoutResult {
  const {
    safeZonePolygon,
    panelSpec,
    rowSpacing,
    tiltAngle,
    azimuthDeg = 180,
    excludeZones = [],
    panelOrientation = 'portrait',
    rowStack = 1,
    validPolygons,
  } = params

  // 0°~175° 범위에서 5° 단위로 탐색하여 가장 많은 패널이 배치되는 그리드 각도 선택
  // 방위각 오프셋(azimuthDeg-180)을 기준으로 탐색
  const azBase = azimuthDeg - 180
  let bestPlacements: PanelPlacement[] = []
  for (let sweep = 0; sweep < 180; sweep += 5) {
    const candidate = placeGridAtAngle(
      safeZonePolygon, panelSpec, rowSpacing, tiltAngle,
      panelOrientation, excludeZones, azBase + sweep, rowStack,
    )
    if (candidate.length > bestPlacements.length) bestPlacements = candidate
  }

  const placements = bestPlacements

  const safeAreaM2 = polygonAreaM2(safeZonePolygon)
  const panelAreaM2 = placements.length * panelSpec.lengthM * panelSpec.widthM
  const totalKwp = (placements.length * panelSpec.wattNominal) / 1000

  const panelFootprint = panelSpec.lengthM * panelSpec.widthM
  const theoreticalMax = panelFootprint > 0 ? Math.floor(safeAreaM2 / panelFootprint) : 0
  const utilizationRate = theoreticalMax > 0 ? placements.length / theoreticalMax : 0

  return {
    placements,
    totalCount: placements.length,
    totalKwp: Math.round(totalKwp * 100) / 100,
    coverageRatio: safeAreaM2 > 0
      ? Math.round((panelAreaM2 / safeAreaM2) * 1000) / 1000
      : 0,
    theoreticalMax,
    utilizationRate: Math.round(utilizationRate * 1000) / 1000,
  }
}

// ── 파이프라인 함수 ────────────────────────────────────────────────

/**
 * Safe Zone 생성
 * v5.2: 객체 파라미터로 변경, boundaries 지원, 지목변경 예정 플래그
 */
export function createSafeZone(params: {
  cadastrePolygon: Polygon
  plotType: PlotType
  /** 하천·도로 등 특별 마진이 필요한 경계 구간 (선택) */
  boundaries?: BoundarySegment[]
  /** 지목변경 예정 부지 여부 (true이면 1.5m 마진 적용) */
  isJimokChangePlanned?: boolean
}): SafeZoneResult {
  const { cadastrePolygon, plotType, isJimokChangePlanned } = params

  // 지목변경 예정 플래그 → land_change_planned 타입으로 오버라이드
  const effectivePlotType: PlotType = isJimokChangePlanned ? 'land_change_planned' : plotType
  const marginM = MARGIN_RULES[effectivePlotType]
  const originalAreaM2 = polygonAreaM2(cadastrePolygon)
  const safeZonePolygon = applyInsetMargin(cadastrePolygon, marginM)
  const safeAreaM2 = polygonAreaM2(safeZonePolygon)

  if (safeAreaM2 <= 0) {
    return {
      safeZonePolygon: [],
      originalPolygon: cadastrePolygon,
      marginApplied: marginM,
      plotType: effectivePlotType,
      originalAreaM2,
      safeAreaM2: 0,
      error: '부지가 너무 작아 Safe Zone을 생성할 수 없습니다',
    }
  }

  return {
    safeZonePolygon,
    originalPolygon: cadastrePolygon,
    marginApplied: marginM,
    plotType: effectivePlotType,
    originalAreaM2,
    safeAreaM2,
  }
}

/**
 * 전체 분석 파이프라인: 지번 폴리곤 → 배치 결과 (v5.2)
 * 1. createSafeZone (지목변경 예정 플래그, 경계 구간 지원)
 * 2. correctForSlope → optimizeTiltAngle (경사지 위도 보정)
 * 3. generateLayout (방위각 회전 그리드)
 * 4. validateAgainstRealCases (실증 크로스체크)
 */
export function runFullAnalysis(params: {
  cadastrePolygon: Polygon
  plotType: PlotType
  panelSpec: PanelSpec
  panelType: string
  latitude: number
  excludeZones?: Polygon[]
  /** 방위각 (°), 기본 180 */
  azimuthDeg?: number
  /** 경사각 (°), 기본 0 */
  slopeAngleDeg?: number
  /** 경사 방위각 (°), 기본 180 */
  slopeAzimuthDeg?: number
  /** 경계 구간 (하천/도로) */
  boundaries?: BoundarySegment[]
  /** 지목변경 예정 여부 */
  isJimokChangePlanned?: boolean
  /** 패널 방향 — 기본 'portrait' */
  panelOrientation?: 'portrait' | 'landscape'
  /** 단수 (1~3) — 기본 1 */
  rowStack?: number
  /** 복수 필지 PIP용 유효 폴리곤 목록 */
  validPolygons?: Polygon[]
  /** 외부 사전계산 Safe Zone (제공 시 createSafeZone 스킵 — 이중 margin 방지) */
  precomputedSafeZonePolygon?: Polygon
}): FullAnalysisResult {
  const {
    cadastrePolygon,
    plotType,
    panelSpec,
    panelType,
    excludeZones,
    azimuthDeg = 180,
    slopeAngleDeg = 0,
    slopeAzimuthDeg = 180,
    boundaries,
    isJimokChangePlanned,
    panelOrientation = 'portrait',
    rowStack = 1,
    validPolygons,
    precomputedSafeZonePolygon,
  } = params

  // 경사지 위도 보정 (import 시점 circular 방지를 위해 인라인)
  const effectiveLatitude = slopeAngleDeg > 0
    ? params.latitude - slopeAngleDeg * Math.cos((slopeAzimuthDeg - 180) * DEG2RAD)
    : params.latitude

  // Step 1: Safe Zone (외부 사전계산 제공 시 createSafeZone 스킵)
  const safeZone = precomputedSafeZonePolygon
    ? {
        safeZonePolygon: precomputedSafeZonePolygon,
        originalPolygon: cadastrePolygon,
        marginApplied: 0,
        plotType,
        originalAreaM2: polygonAreaM2(cadastrePolygon),
        safeAreaM2: polygonAreaM2(precomputedSafeZonePolygon),
      }
    : createSafeZone({ cadastrePolygon, plotType, boundaries, isJimokChangePlanned })

  if (safeZone.error || safeZone.safeZonePolygon.length === 0) {
    return {
      safeZone,
      optimalTilt: 30,
      rowSpacing: getRowSpacing({ panelSpec, tiltAngle: 30, latitude: effectiveLatitude, azimuthDeg }),
      layout: { placements: [], totalCount: 0, totalKwp: 0, coverageRatio: 0, theoreticalMax: 0, utilizationRate: 0 },
      region: getRegionByLatitude(effectiveLatitude),
      panelType,
      azimuthDeg,
      panelOrientation,
    }
  }

  // Step 2: 최적 경사각 (지붕형은 별도 로직)
  const optResult = optimizeTiltAngle({
    panelSpec,
    latitude: effectiveLatitude,
    safeZoneAreaM2: safeZone.safeAreaM2,
    azimuthDeg,
    isRoof: plotType === 'roof',
    panelOrientation,
  })

  // Step 3: 패널 배치 (방위각 회전 + 방향 + 단수)
  const layout = generateLayout({
    safeZonePolygon: safeZone.safeZonePolygon,
    panelSpec,
    rowSpacing: optResult.rowSpacing,
    tiltAngle: optResult.optimalTilt,
    azimuthDeg,
    excludeZones,
    panelOrientation,
    rowStack,
  })

  // Step 4: 실증 크로스체크
  const validation = validateAgainstRealCases({
    rowSpacing: optResult.rowSpacing,
    utilizationRate: layout.utilizationRate,
    isRoof: safeZone.plotType === 'roof',
    azimuthDeg,
  })

  return {
    safeZone,
    optimalTilt: optResult.optimalTilt,
    rowSpacing: optResult.rowSpacing,
    layout,
    region: optResult.region,
    panelType,
    azimuthDeg,
    panelOrientation,
    validation,
  }
}
