// lib/constants.ts — 이 파일의 수치는 절대 변경 금지

export const SMP = 110 // 원/kWh (건물형/토지형 동일)

export const REC_PRICE = {
  건물지붕형: 105000, // 원/MWh
  일반토지형: 70000,
  영농형농지: 70000,
  임야형: 70000,
  수상형: 70000,
} as const

export const REC_WEIGHT = {
  수상형: 1.6,
  건물지붕형: 1.5,
  공장창고: 1.5,
  산업단지: 1.5,
  일반토지형: 1.2,
  영농형농지: 1.2,
  일반: 1.0,
  임야형: 0.7,
} as const

export const GENERATION_HOURS = 3.5 // h/일 (건물형/토지형 동일)
export const DEGRADATION_RATE = 0.005 // 연간 0.5% 열화
export const OP_COST_RATE = 0.02 // 운영비 총수익의 2%

// 검증값 (100kW 건물지붕형)
// 연간발전량: 127,750 kWh
// SMP수익: 1,405만원, REC수익: 2,012만원, 총수익: 3,417만원

export type InstallationType = '건물지붕형' | '일반토지형' | '영농형농지' | '임야형' | '수상형'

export const INSTALLATION_TYPES: InstallationType[] = [
  '건물지붕형',
  '일반토지형',
  '영농형농지',
  '임야형',
  '수상형',
]

export const MODULES = [
  { name: '단결정 PERC 550W', watt: 550, w: 1.134, h: 2.278 },
  { name: 'TOPCon GS710W', watt: 710, w: 1.303, h: 2.384 },
  { name: '양면형 Bifacial 580W', watt: 580, w: 1.134, h: 2.278 },
]
