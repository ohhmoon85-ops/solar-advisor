// lib/spacingCalculator.ts
// 현장 실무 수식 기반 태양광 행간거리 자동 계산 라이브러리
// 원본: 경사각_단수_행간거리_관계.xlsx
// §1 행간거리 계산식 — 엑셀 예시값 검증 완료

import { getSolarElevation } from './shadowCalculator'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

// ── 타입 ─────────────────────────────────────────────────────────────

export interface RowSpacingCalcResult {
  /** 모듈 수직 높이 (m) = sin(moduleAngle) × moduleLength */
  verticalLength: number
  /** 모듈 수평 지면 투영 길이 (m) = cos(moduleAngle) × moduleLength */
  horizontalLength: number
  /** 토지 경사 보정 수직길이 (m) = sin(landAngle) × moduleLength */
  correctedVertical: number
  /** 보정 태양각 거리 (m) = tan(90°-solarAngle) × (verticalLength - correctedVertical) */
  correctedSolarDistance: number
  /** 행간 거리 (m): 모듈 앞끝 ~ 다음 모듈 앞끝 = horizontalLength + correctedSolarDistance */
  rowSpacing: number
  /** 모듈 사이 빈 공간 (m): 모듈 뒤끝 ~ 다음 모듈 앞끝 = rowSpacing - horizontalLength */
  moduleToModuleGap: number
}

export interface ProjectedAreaResult {
  projectedLength: number   // 수평 투영 길이 (m)
  projectedArea: number     // 수평 투영 면적 (m²)
  totalArea: number         // 모듈 실제 면적 (m²)
  reductionRate: number     // 축소율 (%)
}

// ── 핵심 함수 ─────────────────────────────────────────────────────────

/**
 * 행간 거리 자동 계산 (§1 핵심 수식)
 *
 * 검증값 (엑셀 일치):
 *   solarAngle=26°, moduleAngle=15°, landAngle=3°, moduleLength=2.384m
 *   → verticalLength=0.617m, horizontalLength=2.303m
 *   → correctedSolarDistance=1.009m, rowSpacing=3.312m, moduleToModuleGap=1.009m
 *
 * @param solarAngle    동지 태양고도각 (°)
 * @param moduleAngle   모듈 경사각 (°)
 * @param landAngle     토지 경사각 (°)
 * @param moduleLength  모듈 N-S 방향 길이 (m)
 */
export function calculateRowSpacing(
  solarAngle: number,
  moduleAngle: number,
  landAngle: number,
  moduleLength: number,
): RowSpacingCalcResult {
  const verticalLength = Math.sin(moduleAngle * DEG2RAD) * moduleLength
  const horizontalLength = Math.cos(moduleAngle * DEG2RAD) * moduleLength
  const correctedVertical = Math.sin(landAngle * DEG2RAD) * moduleLength
  const correctedSolarDistance =
    Math.tan((90 - solarAngle) * DEG2RAD) * (verticalLength - correctedVertical)
  const rowSpacing = horizontalLength + correctedSolarDistance
  const moduleToModuleGap = rowSpacing - horizontalLength

  return {
    verticalLength:          round3(verticalLength),
    horizontalLength:        round3(horizontalLength),
    correctedVertical:       round3(correctedVertical),
    correctedSolarDistance:  round3(correctedSolarDistance),
    rowSpacing:              round3(rowSpacing),
    moduleToModuleGap:       round3(moduleToModuleGap),
  }
}

/**
 * 수평 투영 면적 계산 (§3)
 */
export function calculateProjectedArea(
  moduleAngle: number,
  moduleLength: number,
  moduleWidth: number,
  count: number,
): ProjectedAreaResult {
  const projectedLength = Math.cos(moduleAngle * DEG2RAD) * moduleLength
  const projectedArea = projectedLength * moduleWidth * count
  const totalArea = moduleLength * moduleWidth * count
  const reductionRate = (totalArea - projectedArea) / totalArea * 100
  return {
    projectedLength: round3(projectedLength),
    projectedArea:   round2(projectedArea),
    totalArea:       round2(totalArea),
    reductionRate:   round2(reductionRate),
  }
}

/**
 * 기울기 % → 경사각 (°) (§2)
 * 예: 7% → atan(0.07) = 4.00°
 */
export function calculateSlopeFromPercent(slopePercent: number): number {
  return Math.atan(slopePercent / 100) * RAD2DEG
}

/**
 * 수직/수평 거리 → 경사각 (°) (§2)
 * 예: vertical=30, horizontal=73 → atan(30/73) = 22.34°
 */
export function calculateSlopeFromVerticalHorizontal(vertical: number, horizontal: number): number {
  if (horizontal <= 0) return 0
  return Math.atan(vertical / horizontal) * RAD2DEG
}

/**
 * 위도 기반 동지 태양고도각 자동 계산
 * 공식: 90° - 위도 - 23.45°
 *
 * 한국 위도 범위:
 *   위도 33°(제주) → 33.55°
 *   위도 35°(부산·광주) → 31.55°
 *   위도 37°(서울) → 29.55°
 *   위도 38°(강원) → 28.55°
 */
export function getSolarAngleByLocation(lat: number): number {
  return getSolarElevation(lat, -23.45)
}

/**
 * 모듈 앞면(남측) 지면고 계산 (§4)
 * @param moduleAngle  모듈 경사각 (°)
 * @param moduleLength 모듈 길이 (m)
 * @param centerHeight 외기둥 중심 높이 (m)
 */
export function calculateFrontHeight(
  moduleAngle: number,
  moduleLength: number,
  centerHeight: number,
): number {
  const slopeHeight = Math.sin(moduleAngle * DEG2RAD) * moduleLength
  return round3(centerHeight - slopeHeight / 2)
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────
function round3(v: number): number { return Math.round(v * 1000) / 1000 }
function round2(v: number): number { return Math.round(v * 100) / 100 }