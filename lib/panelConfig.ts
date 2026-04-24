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

// ── 프리셋 패널 목록 (실측 사양 기반) ─────────────────────────────

/**
 * PRESET_PANELS — 사용 가능한 5종 패널 프리셋
 * KEY: 드롭다운 value, value: PanelSpec
 */
export const PRESET_PANELS: Record<string, PanelSpec> = {
  /** S645: 2,382×1,134mm */
  S645: {
    id: 'S645',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 635,
    wattMax: 655,
    wattNominal: 645,
    label: 'S645 (645W · 2,382×1,134mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** S650: 2,382×1,134mm */
  S650: {
    id: 'S650',
    lengthM: 2.382,
    widthM: 1.134,
    wattMin: 640,
    wattMax: 660,
    wattNominal: 650,
    label: 'S650 (650W · 2,382×1,134mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** GS710wp: 실제 현장 기준 (2,384×1,303mm) */
  GS710wp: {
    id: 'GS710wp',
    lengthM: 2.384,
    widthM: 1.303,
    wattMin: 700,
    wattMax: 720,
    wattNominal: 710,
    label: 'GS710wp (710W · 2,384×1,303mm) ⭐ 실제현장',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** S700: 2,384×1,303mm */
  S700: {
    id: 'S700',
    lengthM: 2.384,
    widthM: 1.303,
    wattMin: 690,
    wattMax: 710,
    wattNominal: 700,
    label: 'S700 (700W · 2,384×1,303mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
  /** S730: 2,384×1,303mm */
  S730: {
    id: 'S730',
    lengthM: 2.384,
    widthM: 1.303,
    wattMin: 720,
    wattMax: 740,
    wattNominal: 730,
    label: 'S730 (730W · 2,384×1,303mm)',
    groundClearanceM: 0.98,
    topOffsetM: 0.56,
  },
}

export default PRESET_PANELS
