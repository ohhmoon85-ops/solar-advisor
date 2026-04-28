// lib/adjacencyRules.ts — 인접 시설 거리 가이드라인 (1차: 4종)
// 태양광 인허가 시 빛 반사·민원 방지를 위한 일반 권장 거리.
// 실제 인허가 기준은 시·군별 조례에 따라 다름 — 면책 안내 필수.

export interface AdjacencyRule {
  id: string
  label: string
  /** 권장 최소 이격 거리 (m) */
  defaultDistance: number
  /** 거리 조정 허용 범위 (보너스: 슬라이더용) */
  minDistance: number
  maxDistance: number
  /** 제한 사유 (툴팁 표시) */
  reason: string
  /** 시각 단서 */
  icon: string
}

// 표시 순서: 발생 빈도 + 실무 우선순위 기준 (사용자 요청, 2026-04 재배치)
//   고속도로/국도 → 주거지역 → 학교 → 철도
export const ADJACENCY_RULES: AdjacencyRule[] = [
  {
    id: 'highway',
    label: '고속도로/국도',
    defaultDistance: 100,
    minDistance: 30,
    maxDistance: 300,
    reason: '운전자 빛 반사 사고 위험 (도로법 시행령 제58조 관련)',
    icon: '🛣️',
  },
  {
    id: 'residential',
    label: '주거지역',
    defaultDistance: 100,
    minDistance: 50,
    maxDistance: 300,
    reason: '민원·일조권 분쟁 방지 (시·군 조례 일반 최소 기준)',
    icon: '🏘️',
  },
  {
    id: 'school',
    label: '학교',
    defaultDistance: 200,
    minDistance: 100,
    maxDistance: 500,
    reason: '학습 환경 보호 (교육환경 보호에 관한 법률 적용 권역)',
    icon: '🏫',
  },
  {
    id: 'railway',
    label: '철도',
    defaultDistance: 25,
    minDistance: 10,
    maxDistance: 100,
    reason: '빛 반사 → 기관사 시야 방해 (한국철도공사 안전관리 기준)',
    icon: '🚆',
  },
]

/** 체크된 항목 개수 → 위험도 등급 */
export function getRiskLevel(checkedCount: number): {
  level: 'safe' | 'caution' | 'critical'
  label: string
  /** Tailwind 배지 클래스 */
  badge: string
} {
  if (checkedCount === 0) {
    return { level: 'safe', label: '설치 가능', badge: 'bg-green-100 text-green-800 border-green-300' }
  }
  if (checkedCount <= 2) {
    return { level: 'caution', label: '⚠ 주의 검토', badge: 'bg-amber-100 text-amber-800 border-amber-300' }
  }
  return { level: 'critical', label: '⚠ 정밀 조사 필요', badge: 'bg-red-100 text-red-800 border-red-300' }
}

/** 면책 안내 — 카드 하단 표시용 */
export const ADJACENCY_DISCLAIMER =
  '제시된 거리는 일반 가이드라인입니다. 실제 인허가 기준은 시·군별 조례에 따라 다르므로 별도 확인이 필요합니다.'
