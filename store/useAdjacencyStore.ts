// store/useAdjacencyStore.ts
// 인접 시설 체크 상태 — localStorage 영속화 + pnu 변경 시 자동 reset
// 별도 store로 분리: useSolarStore의 비영속 상태와 책임 격리

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ADJACENCY_RULES } from '@/lib/adjacencyRules'

const defaultDistances: Record<string, number> = Object.fromEntries(
  ADJACENCY_RULES.map(r => [r.id, r.defaultDistance]),
)

interface AdjacencyState {
  /** 마지막으로 동기화된 PNU — 새 지번 검색 시 자동 reset 트리거 */
  lastPnu: string | null
  checked: Record<string, boolean>
  distances: Record<string, number>

  setChecked: (id: string, value: boolean) => void
  setDistance: (id: string, value: number) => void
  /** pnu 변경 감지 — 다르면 체크/거리 초기화 */
  syncWithPnu: (pnu: string | null | undefined) => void
  reset: () => void
}

export const useAdjacencyStore = create<AdjacencyState>()(
  persist(
    (set, get) => ({
      lastPnu: null,
      checked: {},
      distances: defaultDistances,

      setChecked: (id, value) =>
        set(s => ({ checked: { ...s.checked, [id]: value } })),

      setDistance: (id, value) =>
        set(s => ({ distances: { ...s.distances, [id]: value } })),

      syncWithPnu: (pnu) => {
        const next = pnu ?? null
        if (next !== get().lastPnu) {
          set({
            lastPnu: next,
            checked: {},
            distances: { ...defaultDistances },
          })
        }
      },

      reset: () =>
        set({
          checked: {},
          distances: { ...defaultDistances },
        }),
    }),
    {
      name: 'solar-advisor-adjacency',
      version: 1,
    },
  ),
)

/** 헬퍼: 체크된 항목 개수 (PDF·헤더 등 외부에서 빠르게 호출) */
export function getCheckedCount(checked: Record<string, boolean>): number {
  return Object.values(checked).filter(Boolean).length
}
