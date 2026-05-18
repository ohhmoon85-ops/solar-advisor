// lib/roofGabledConfig.ts — 박공(경사) 지붕 패널 배치 설정 단일 진실 공급원
// 시공 컨설턴트 검증값 기반 (위장아이텍 본사 2026-05-18 교차검증)
// 변경 시 lib/gabledLayoutEngine.ts + components/GabledConfigPanel.tsx에 영향

/** 패널 배치 방위각 선정 모드 */
export type GabledOrientationMode = 'roof-direction' | 'true-south'

/** 용마루 축(ridge axis) 판정 모드 */
export type GabledRidgeAxisMode = 'auto' | 'manual'

export interface GabledRoofConfig {
  /** 용마루 가운데 사공 통로 폭 (m) — 양 슬로프 분리 dead zone */
  ridgeGap: number
  /** 같은 슬로프 내 행간 간격 (m) */
  intraSlopeGap: number
  /** 처마(eave) 끝 이격 거리 (m) — 외곽 4변 inset */
  eaveSetback: number
  /** 용마루 무시 (true: 슬라브와 동일 직선 배치) */
  ridgeIgnore: boolean
  /** 패널 방위각 우선순위 */
  orientationMode: GabledOrientationMode
  /** 용마루 축 판정 방법 */
  ridgeAxisMode: GabledRidgeAxisMode
  /** ridgeAxisMode='manual'일 때 사용자 지정 축 각도 (°, 0=동서, 90=남북) */
  manualRidgeAxisDeg?: number
  /** 남향 슬로프 최대 행 수 — undefined: 자동(공간 허용 전부 채움) */
  rowsSouth?: number
  /** 북향 슬로프 최대 행 수 — undefined: 자동 */
  rowsNorth?: number
}

/** 박공 지붕 기본값 — 한국 시공 표준 */
export const GABLED_ROOF_DEFAULTS: GabledRoofConfig = {
  ridgeGap: 1.00,
  intraSlopeGap: 0.10,
  eaveSetback: 0.50,
  ridgeIgnore: false,
  orientationMode: 'roof-direction',
  ridgeAxisMode: 'auto',
}

/** 슬라이더/입력 제약 — UI 컴포넌트가 참조 */
export const GABLED_ROOF_LIMITS = {
  ridgeGap:      { min: 0.5,  max: 2.0,  step: 0.1 },
  intraSlopeGap: { min: 0.05, max: 0.30, step: 0.05 },
  eaveSetback:   { min: 0.3,  max: 1.0,  step: 0.1 },
  rowsSouth:     { min: 1,    max: 20,   step: 1 },
  rowsNorth:     { min: 1,    max: 20,   step: 1 },
} as const
