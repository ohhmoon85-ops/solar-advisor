// lib/gabledLayoutEngine.ts — 박공(경사) 지붕 패널 배치 엔진
// 용마루(ridge)를 기준으로 양 슬로프에 대칭 배치
// ridgeIgnore=true 시 일반 슬라브 배치(generateLayout)로 폴백

import type { PanelSpec } from './panelConfig'
import type { LayoutResult, PanelPlacement, Point, Polygon } from './layoutEngine'
import {
  applyInsetMargin,
  generateLayout,
  isPanelInsidePolygon,
  isPointInPolygon,
  polygonAreaM2,
  polygonCentroid,
} from './layoutEngine'
import type { GabledRoofConfig } from './roofGabledConfig'

const DEG2RAD = Math.PI / 180

/** PCA로 폴리곤의 주축(long axis) 각도 계산 (라디안)
 *  공분산 행렬의 큰 고유값에 대응하는 고유벡터 방향
 */
function computeLongAxisAngleRad(polygon: Polygon): number {
  const c = polygonCentroid(polygon)
  let sxx = 0, syy = 0, sxy = 0
  for (const p of polygon) {
    const dx = p.x - c.x, dy = p.y - c.y
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy)
}

/** 한 점을 (cx, cy) 기준 radian 만큼 회전 */
function rotateRad(p: Point, cx: number, cy: number, rad: number): Point {
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const dx = p.x - cx, dy = p.y - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

function emptyResult(safeZonePolygon: Polygon, panelSpec: PanelSpec): LayoutResult {
  const safeAreaM2 = polygonAreaM2(safeZonePolygon)
  const panelFootprint = panelSpec.lengthM * panelSpec.widthM
  return {
    placements: [],
    totalCount: 0,
    totalKwp: 0,
    coverageRatio: 0,
    theoreticalMax: panelFootprint > 0 ? Math.floor(safeAreaM2 / panelFootprint) : 0,
    utilizationRate: 0,
  }
}

/**
 * 박공 지붕 패널 배치
 * - ridgeIgnore=true: generateLayout(fixedGridAngle=true)로 폴백
 * - 그 외: ridge 기준 양 슬로프 분할 후 각 슬로프에 행/열 배치
 */
export function placeGabledPanels(params: {
  safeZonePolygon: Polygon
  panelSpec: PanelSpec
  config: GabledRoofConfig
  /** 지붕 경사각 (°) — 패널 top-down 풋프린트의 cos 단축에 사용 */
  tiltAngle: number
  panelOrientation?: 'portrait' | 'landscape'
  /** orientationMode='true-south'일 때 사용 */
  azimuthDeg?: number
  excludeZones?: Polygon[]
  validPolygons?: Polygon[]
}): LayoutResult {
  const {
    safeZonePolygon,
    panelSpec,
    config,
    tiltAngle,
    panelOrientation = 'portrait',
    azimuthDeg = 180,
    excludeZones = [],
    validPolygons,
  } = params

  console.log('[Gabled-Engine] placeGabledPanels 진입', {
    ridgeIgnore: config.ridgeIgnore,
    ridgeGap: config.ridgeGap,
    intraSlopeGap: config.intraSlopeGap,
    eaveSetback: config.eaveSetback,
    polyLen: safeZonePolygon.length,
    tiltAngle,
  })

  // ── ridgeIgnore: 슬라브와 동일 처리 (직선 배치) ─────────────────
  if (config.ridgeIgnore) {
    console.log('[Gabled-Engine] ridgeIgnore=true → generateLayout 폴백')
    const projLen = panelSpec.lengthM * Math.cos(tiltAngle * DEG2RAD)
    return generateLayout({
      safeZonePolygon,
      panelSpec,
      panelOrientation,
      rowSpacing: projLen + config.intraSlopeGap,
      tiltAngle,
      azimuthDeg,
      excludeZones,
      validPolygons,
      fixedGridAngle: true,
    })
  }

  // ── 1. 외곽 eaveSetback inset ────────────────────────────────
  const insetPoly = applyInsetMargin(safeZonePolygon, config.eaveSetback)
  if (insetPoly.length < 3) return emptyResult(safeZonePolygon, panelSpec)

  // ── 2. ridge 축 결정 + 폴리곤 회전 (ridge ∥ x축) ───────────────
  const ridgeAxisRad =
    config.ridgeAxisMode === 'manual' && config.manualRidgeAxisDeg != null
      ? config.manualRidgeAxisDeg * DEG2RAD
      : computeLongAxisAngleRad(insetPoly)
  const centroid = polygonCentroid(insetPoly)
  const rotPoly = insetPoly.map(p => rotateRad(p, centroid.x, centroid.y, -ridgeAxisRad))

  // ── 3. 회전 폴리곤 AABB + ridge 라인 (centroid 통과) ──────────
  const xs = rotPoly.map(p => p.x), ys = rotPoly.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const ridgeY = centroid.y

  // ── 4. 패널 top-down 풋프린트 ────────────────────────────────
  const effEW = panelOrientation === 'landscape' ? panelSpec.lengthM : panelSpec.widthM
  const effNS = panelOrientation === 'landscape' ? panelSpec.widthM : panelSpec.lengthM
  const projLen = effNS * Math.cos(tiltAngle * DEG2RAD)
  const colPitch = effEW + 0.02
  const rowPitch = projLen + config.intraSlopeGap

  // ── 5. 양 슬로프 행/열 배치 ──────────────────────────────────
  const placements: PanelPlacement[] = []
  let id = 0
  const placeRow = (yBottom: number, rowIdx: number) => {
    const yTop = yBottom + projLen
    let col = 0
    for (let x = minX; x + effEW <= maxX; x += colPitch, col++) {
      const corners: [Point, Point, Point, Point] = [
        { x, y: yBottom },
        { x: x + effEW, y: yBottom },
        { x: x + effEW, y: yTop },
        { x, y: yTop },
      ]
      const passes = validPolygons
        ? validPolygons.some(poly => {
            const rotValid = poly.map(p => rotateRad(p, centroid.x, centroid.y, -ridgeAxisRad))
            return isPanelInsidePolygon(corners, rotValid)
          })
        : isPanelInsidePolygon(corners, rotPoly)
      if (!passes) continue
      const actualCorners = corners.map(p =>
        rotateRad(p, centroid.x, centroid.y, ridgeAxisRad),
      ) as [Point, Point, Point, Point]
      const center = rotateRad(
        { x: x + effEW / 2, y: yBottom + projLen / 2 },
        centroid.x, centroid.y, ridgeAxisRad,
      )
      if (excludeZones.some(zone => isPointInPolygon(center, zone))) continue
      placements.push({ id: id++, corners: actualCorners, centerX: center.x, centerY: center.y, row: rowIdx, col })
    }
  }

  // ── 남/북 사면 판정 (회전 후 frame의 -y 방향이 원래 남쪽인가?)
  // PCA atan2/2 결과는 (-π/2, π/2]이므로 cos(ridgeAxisRad) >= 0 → 보통 Slope A=남
  // 단, ridge가 거의 N-S로 누우면 cos→0이라 사면 판정 모호 (E/W 사면이 됨)
  const slopeAIsSouth = Math.cos(ridgeAxisRad) >= 0
  const rowsSouth = config.rowsSouth ?? Number.MAX_SAFE_INTEGER
  const rowsNorth = config.rowsNorth ?? Number.MAX_SAFE_INTEGER
  const rowsA = slopeAIsSouth ? rowsSouth : rowsNorth
  const rowsB = slopeAIsSouth ? rowsNorth : rowsSouth

  // Slope A: 아래쪽 (남쪽 처마 minY부터 ridge 쪽으로 올라가며 행 배치)
  const slopeATop = ridgeY - config.ridgeGap / 2
  const slopeACountBefore = placements.length
  let slopeARows = 0
  for (let i = 0; i < rowsA; i++) {
    const yB = minY + i * rowPitch
    if (yB + projLen > slopeATop) break
    placeRow(yB, slopeARows)
    slopeARows++
  }
  const slopeACount = placements.length - slopeACountBefore

  // Slope B: 위쪽 (북쪽 처마 maxY부터 ridge 쪽으로 내려가며 행 배치 — 처마 우선)
  const slopeBBottom = ridgeY + config.ridgeGap / 2
  const slopeBCountBefore = placements.length
  let slopeBRows = 0
  for (let i = 0; i < rowsB; i++) {
    const yB = maxY - projLen - i * rowPitch
    if (yB < slopeBBottom) break
    placeRow(yB, slopeARows + slopeBRows)
    slopeBRows++
  }
  const slopeBCount = placements.length - slopeBCountBefore
  console.log('[Gabled-Engine] ridge 분할 결과', {
    ridgeAxisDeg: ((ridgeAxisRad * 180) / Math.PI).toFixed(1),
    slopeAIsSouth,
    aabb: { minX: minX.toFixed(2), maxX: maxX.toFixed(2), minY: minY.toFixed(2), maxY: maxY.toFixed(2) },
    ridgeY: ridgeY.toFixed(2),
    rowPitch: rowPitch.toFixed(3),
    capRowsSouth: config.rowsSouth ?? '자동',
    capRowsNorth: config.rowsNorth ?? '자동',
    slopeA: { isSouth: slopeAIsSouth, rows: slopeARows, panels: slopeACount },
    slopeB: { isSouth: !slopeAIsSouth, rows: slopeBRows, panels: slopeBCount },
    total: placements.length,
  })

  // ── 6. 결과 집계 ────────────────────────────────────────────
  const safeAreaM2 = polygonAreaM2(safeZonePolygon)
  const totalKwp = (placements.length * panelSpec.wattNominal) / 1000
  const panelFootprint = panelSpec.lengthM * panelSpec.widthM
  const theoreticalMax = panelFootprint > 0 ? Math.floor(safeAreaM2 / panelFootprint) : 0
  const utilizationRate = theoreticalMax > 0 ? placements.length / theoreticalMax : 0
  const panelAreaM2 = placements.length * panelSpec.lengthM * panelSpec.widthM

  // azimuthDeg는 현재 결과 메타에 포함하지 않음 (FullAnalysisResult.azimuthDeg에서 별도 관리)
  void azimuthDeg

  return {
    placements,
    totalCount: placements.length,
    totalKwp: Math.round(totalKwp * 100) / 100,
    coverageRatio: safeAreaM2 > 0 ? Math.round((panelAreaM2 / safeAreaM2) * 1000) / 1000 : 0,
    theoreticalMax,
    utilizationRate: Math.round(utilizationRate * 1000) / 1000,
  }
}
