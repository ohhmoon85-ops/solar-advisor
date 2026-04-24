// lib/multiZoneLayout.ts — 다구역 분할 배치 엔진 (v5.2 신규)
// 복잡한 폴리곤(L자형·다각형)을 여러 구역으로 분할하여 독립적으로 배치
// 사례 5·6: 2구역 병렬 배치 (총 87~91장)
// 순수 함수만 포함 — React/Zustand 의존 없음

import type { PanelSpec } from './panelConfig'
import {
  type Polygon, type Point, type PlotType, type FullAnalysisResult,
  runFullAnalysis, polygonAreaM2, polygonCentroid, applyInsetMargin,
} from './layoutEngine'

// ── 타입 ───────────────────────────────────────────────────────────

export interface ZoneConfig {
  /** 구역 라벨 (예: 'A구역', 'B구역') */
  label: string
  polygon: Polygon
  plotType: PlotType
  panelSpec: PanelSpec
  panelType: string
  /** 방위각 (°), 기본 180 */
  azimuthDeg?: number
  /** 경사각 (°), 기본 0 */
  slopeAngleDeg?: number
  /** 경사 방위각 (°), 기본 180 */
  slopeAzimuthDeg?: number
  /** 지목변경 예정 여부 */
  isJimokChangePlanned?: boolean
  /** 패널 방향 */
  panelOrientation?: 'portrait' | 'landscape'
}

export interface ZoneLayoutResult extends FullAnalysisResult {
  zoneLabel: string
  zoneIndex: number
}

export interface MultiZoneResult {
  zones: ZoneLayoutResult[]
  totalCount: number
  totalKwp: number
  totalAreaM2: number
  /** 전체 이용률 (총 패널 수 / 각 구역 이론 최대 합) */
  totalUtilizationRate: number
  region: string
}

// ── 구역 분할 함수 ─────────────────────────────────────────────────

/**
 * 폴리곤의 추정 구역 수
 * 면적 > 2000m² 또는 세장비(aspect ratio) > 2.5이면 2구역 권장
 */
export function estimateZoneCount(polygon: Polygon): number {
  const area = polygonAreaM2(polygon)
  const xs = polygon.map(p => p.x)
  const ys = polygon.map(p => p.y)
  const rangeX = Math.max(...xs) - Math.min(...xs)
  const rangeY = Math.max(...ys) - Math.min(...ys)
  const aspectRatio = rangeX > 0 && rangeY > 0
    ? Math.max(rangeX, rangeY) / Math.min(rangeX, rangeY)
    : 1

  if (area > 2000 || aspectRatio > 2.5) return 2
  return 1
}

/**
 * Sutherland-Hodgman 클립 — 폴리곤을 수평선(y = clipY) 위/아래로 분리
 * @param polygon 원본 폴리곤
 * @param clipY 분리 기준 y 좌표
 * @param keepAbove true=상단, false=하단
 */
function clipPolygonByHorizontal(
  polygon: Polygon,
  clipY: number,
  keepAbove: boolean
): Polygon {
  const result: Point[] = []
  const n = polygon.length

  for (let i = 0; i < n; i++) {
    const curr = polygon[i]
    const next = polygon[(i + 1) % n]

    const currIn = keepAbove ? curr.y >= clipY : curr.y <= clipY
    const nextIn = keepAbove ? next.y >= clipY : next.y <= clipY

    if (currIn) result.push(curr)

    // 교차점 계산
    if (currIn !== nextIn) {
      const t = (clipY - curr.y) / (next.y - curr.y)
      result.push({
        x: curr.x + t * (next.x - curr.x),
        y: clipY,
      })
    }
  }
  return result
}

/**
 * Sutherland-Hodgman 클립 — 폴리곤을 수직선(x = clipX) 좌/우로 분리
 */
function clipPolygonByVertical(
  polygon: Polygon,
  clipX: number,
  keepRight: boolean
): Polygon {
  const result: Point[] = []
  const n = polygon.length

  for (let i = 0; i < n; i++) {
    const curr = polygon[i]
    const next = polygon[(i + 1) % n]

    const currIn = keepRight ? curr.x >= clipX : curr.x <= clipX
    const nextIn = keepRight ? next.x >= clipX : next.x <= clipX

    if (currIn) result.push(curr)

    if (currIn !== nextIn) {
      const t = (clipX - curr.x) / (next.x - curr.x)
      result.push({
        x: clipX,
        y: curr.y + t * (next.y - curr.y),
      })
    }
  }
  return result
}

/**
 * 폴리곤을 2개 구역으로 분할
 * - 세로가 길면 수평 분할 (y축 중간)
 * - 가로가 길면 수직 분할 (x축 중간)
 */
function splitPolygonIntoTwo(polygon: Polygon): [Polygon, Polygon] {
  const xs = polygon.map(p => p.x)
  const ys = polygon.map(p => p.y)
  const rangeX = Math.max(...xs) - Math.min(...xs)
  const rangeY = Math.max(...ys) - Math.min(...ys)
  const centroid = polygonCentroid(polygon)

  if (rangeY >= rangeX) {
    // 수평 분할: 남쪽(하단) / 북쪽(상단)
    const zone1 = clipPolygonByHorizontal(polygon, centroid.y, false)  // 하단
    const zone2 = clipPolygonByHorizontal(polygon, centroid.y, true)   // 상단
    return [zone1, zone2]
  } else {
    // 수직 분할: 서쪽(좌) / 동쪽(우)
    const zone1 = clipPolygonByVertical(polygon, centroid.x, false)  // 좌
    const zone2 = clipPolygonByVertical(polygon, centroid.x, true)   // 우
    return [zone1, zone2]
  }
}

/**
 * 복잡한 폴리곤 → ZoneConfig 배열 자동 생성
 * - 단순 폴리곤: 1개 구역
 * - 복잡/세장형: 2개 구역으로 분할
 */
export function autoSplitPolygon(
  polygon: Polygon,
  panelSpec: PanelSpec,
  plotType: PlotType,
  panelType: string,
  options?: {
    azimuthDeg?: number
    slopeAngleDeg?: number
    slopeAzimuthDeg?: number
    isJimokChangePlanned?: boolean
  }
): ZoneConfig[] {
  const count = estimateZoneCount(polygon)

  const baseConfig = {
    plotType,
    panelSpec,
    panelType,
    azimuthDeg: options?.azimuthDeg ?? 180,
    slopeAngleDeg: options?.slopeAngleDeg ?? 0,
    slopeAzimuthDeg: options?.slopeAzimuthDeg ?? 180,
    isJimokChangePlanned: options?.isJimokChangePlanned ?? false,
  }

  if (count === 1) {
    return [{ label: 'A구역', polygon, ...baseConfig }]
  }

  const [poly1, poly2] = splitPolygonIntoTwo(polygon)
  const configs: ZoneConfig[] = []

  if (poly1.length >= 3 && polygonAreaM2(poly1) > 10) {
    configs.push({ label: 'A구역', polygon: poly1, ...baseConfig })
  }
  if (poly2.length >= 3 && polygonAreaM2(poly2) > 10) {
    configs.push({ label: 'B구역', polygon: poly2, ...baseConfig })
  }

  return configs.length > 0 ? configs : [{ label: 'A구역', polygon, ...baseConfig }]
}

// ── 다구역 분석 ────────────────────────────────────────────────────

/**
 * 다구역 배치 분석 실행
 * 각 구역을 독립적으로 runFullAnalysis 후 결과 합산
 */
export function runMultiZoneAnalysis(
  zones: ZoneConfig[],
  latitude: number
): MultiZoneResult {
  const zoneResults: ZoneLayoutResult[] = zones.map((zone, idx) => {
    const result = runFullAnalysis({
      cadastrePolygon: zone.polygon,
      plotType: zone.plotType,
      panelSpec: zone.panelSpec,
      panelType: zone.panelType,
      latitude,
      azimuthDeg: zone.azimuthDeg ?? 180,
      slopeAngleDeg: zone.slopeAngleDeg ?? 0,
      slopeAzimuthDeg: zone.slopeAzimuthDeg ?? 180,
      isJimokChangePlanned: zone.isJimokChangePlanned ?? false,
      panelOrientation: zone.panelOrientation ?? 'portrait',
    })
    return {
      ...result,
      zoneLabel: zone.label,
      zoneIndex: idx,
    }
  })

  const totalCount = zoneResults.reduce((s, r) => s + r.layout.totalCount, 0)
  const totalKwp = zoneResults.reduce((s, r) => s + r.layout.totalKwp, 0)
  const totalAreaM2 = zoneResults.reduce((s, r) => s + r.safeZone.originalAreaM2, 0)
  const totalTheoreticalMax = zoneResults.reduce((s, r) => s + r.layout.theoreticalMax, 0)
  const totalUtilizationRate = totalTheoreticalMax > 0
    ? Math.round((totalCount / totalTheoreticalMax) * 1000) / 1000
    : 0
  const region = zoneResults[0]?.region ?? '알 수 없음'

  return {
    zones: zoneResults,
    totalCount,
    totalKwp: Math.round(totalKwp * 100) / 100,
    totalAreaM2,
    totalUtilizationRate,
    region,
  }
}

// ── 타입 가드 ──────────────────────────────────────────────────────

export function isMultiZoneResult(
  result: FullAnalysisResult | MultiZoneResult
): result is MultiZoneResult {
  return 'zones' in result && Array.isArray((result as MultiZoneResult).zones)
}
