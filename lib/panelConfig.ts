// lib/panelConfig.ts — 실측 패널 사양 단일 진실 공급원 (v5.2)
// 이 파일의 수치는 실측값 기준이며 변경 시 전체 계산 모듈에 영향을 줍니다

export interface PanelSpec {
  /** 패널 고유 ID */
  id: string
  /** 경사 방향 길이 (m) — 그림자 이격 계산 기준 */
  lengthM: number
  /** 횡방향 폭 (m) — 열 배치 기준 */
  widthM: number
  /** 최소 출력 (W) */
  wattMin: number
  /** 최대 출력 (W) */
  wattMax: number
  /** 공칭 출력 (W) — 수익 계산 기준 */
  wattNominal: number
  /** 화면 표시 라벨 */
  label: string
  /** 지면 이격 거리 (m) — 하단 고정 프레임 기준, 기본 0.98m */
  groundClearanceM: number
  /** 패널 상단 오프셋 (m) — 프레임 상단~패널 셀 상단, 기본 0.56m */
  topOffsetM: number
}

// ── 프리셋 패널 목록 (실증 사례 기반) ─────────────────────────────

/**
 * PRESET_PANELS — 모든 사용 가능 패널 프리셋
 * KEY: 드롭다운 value, value: PanelSpec
 */
export const PRESET_PANELS: Record<string, PanelSpec> = {
  /** 사례 1 기준: TOPCon 590W (2,278×1,134mm) */
  REF_590: {
    id: 'REF_590',
    lengthM: 2.278,
    widthM: 1.134,
    wattMin: 580,
    wattMax: 595,
    wattNominal: 590,
    label: 'REF 590W (2,278×1,134mm) · 사례1 기준',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** 사례 2 기준: TOPCon 595W */
  REF_595: {
    id: 'REF_595',
    lengthM: 2.278,
    widthM: 1.134,
    wattMin: 585,
    wattMax: 600,
    wattNominal: 595,
    label: 'REF 595W (2,278×1,134mm) · 사례2 기준',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** 사례 3 기준: TOPCon 625W */
  REF_625: {
    id: 'REF_625',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 615,
    wattMax: 635,
    wattNominal: 625,
    label: 'REF 625W (2,382×1,134mm) · 사례3 기준',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** 사례 4 기준: TOPCon 645W */
  REF_645: {
    id: 'REF_645',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 635,
    wattMax: 655,
    wattNominal: 645,
    label: 'REF 645W (2,382×1,134mm) · 사례4 기준',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** TYPE A: 단결정 계열 640~665W 표준형 */
  TYPE_A: {
    id: 'TYPE_A',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 640,
    wattMax: 665,
    wattNominal: 652.5,
    label: 'TYPE A (640~665W · 2,382×1,134mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** TYPE B: TOPCon 계열 700~730W 고출력형 */
  TYPE_B: {
    id: 'TYPE_B',
    lengthM: 2.384,
    widthM: 1.303,
    wattMin: 700,
    wattMax: 730,
    wattNominal: 715,
    label: 'TYPE B (700~730W · 2,384×1,303mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** GS710W: 사례 5·6 기준 */
  GS710: {
    id: 'GS710',
    lengthM: 2.384,
    widthM: 1.303,
    wattMin: 700,
    wattMax: 720,
    wattNominal: 710,
    label: 'GS710W (700~720W · 2,384×1,303mm) · 사례5·6',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** CUSTOM: 사용자 직접 입력 (createCustomPanel로 초기화) */
  CUSTOM: {
    id: 'CUSTOM',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 600,
    wattMax: 660,
    wattNominal: 630,
    label: '사용자 지정',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
}

/**
 * 하위 호환용 PANEL_TYPES (v4.x MapTab에서 그대로 import 가능)
 */
export const PANEL_TYPES: Record<'TYPE_A' | 'TYPE_B', PanelSpec> = {
  TYPE_A: PRESET_PANELS.TYPE_A,
  TYPE_B: PRESET_PANELS.TYPE_B,
}

export type PanelTypeKey = keyof typeof PANEL_TYPES

/**
 * 사용자 지정 패널 사양 생성
 */
export function createCustomPanel(
  lengthM: number,
  widthM: number,
  wattNominal: number,
  options?: { groundClearanceM?: number; topOffsetM?: number }
): PanelSpec {
  return {
    id: 'CUSTOM',
    lengthM,
    widthM,
    wattMin: Math.round(wattNominal * 0.97),
    wattMax: Math.round(wattNominal * 1.02),
    wattNominal,
    label: `사용자 지정 (${wattNominal}W · ${(lengthM * 1000).toFixed(0)}×${(widthM * 1000).toFixed(0)}mm)`,
    groundClearanceM: options?.groundClearanceM ?? 0.98,
    topOffsetM: options?.topOffsetM ?? 0.56,
  }
}

export default PANEL_TYPES
