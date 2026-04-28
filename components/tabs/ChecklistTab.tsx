'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSolarStore } from '@/store/useStore'

const STORAGE_KEY = 'solar-advisor-checklist'

type Stage = 'pre' | 'permit' | 'construction'

interface CheckItem {
  id: string
  text: string
  required: boolean
  link?: string
  stage: Stage
}

const CHECKLIST: CheckItem[] = [
  // 사전 검토
  { id: 'c1', text: '★ 한전ON 계통 연계 가능 용량 사전 조회', required: true, link: 'https://home.kepco.co.kr', stage: 'pre' },
  { id: 'c2', text: '★ 이음지도 탭 → 지번 입력 → 패널 배치도 자동 생성 (건물: 구조·방향 분석 포함)', required: true, stage: 'pre' },
  { id: 'c3', text: '★ 조례 탭 → "⚠ 최근 개정" 배지 확인 후 법제처 원문 검토', required: true, stage: 'pre' },
  { id: 'c4', text: '잔액증명서 준비 (사업비 15%, 100kW → 1,500만원 이상) — 거래은행 발급', required: false, stage: 'pre' },
  { id: 'c5', text: '수익성 시뮬레이터 계산 (SMP 110원, REC 105,000/70,000원 자동 반영)', required: false, stage: 'pre' },
  { id: 'c6', text: '에너지공단 정책자금 접수 일정 확인 (분기별) — ☎ 1588-2504', required: false, stage: 'pre' },

  // 인허가
  { id: 'c7', text: '★ 발전사업허가 신청 (18종 서류) — 시·군·구청', required: true, stage: 'permit' },
  { id: 'c8', text: '★ 개발행위허가 신청 — 토지 설치 필수', required: true, stage: 'permit' },
  { id: 'c9', text: '★ 에너지공단 정책자금 신청 (분기 공고)', required: true, stage: 'permit' },
  { id: 'c10', text: 'SolarAdvisor 패널 배치도 확정 → 시공 설계도면 기준 PDF 출력 (지도 축척 일치 확인)', required: false, stage: 'permit' },
  { id: 'c11', text: '★ 사용전검사 신청 — 한국전기안전공사', required: true, stage: 'construction' },
  { id: 'c12', text: '★ 에너지공단 REC 설비확인 등록 (22종) — 현장 확인 3~4주', required: true, stage: 'construction' },
  { id: 'c13', text: '★ 사업개시 신고 — 60일 이내 (벌금 60만원) — 에너지과', required: true, stage: 'construction' },
]

const STAGE_INFO: Record<Stage, { label: string; icon: string; color: string }> = {
  pre: { label: '사전 검토', icon: '🔍', color: 'blue' },
  permit: { label: '인허가 단계', icon: '📄', color: 'orange' },
  construction: { label: '시공·완료 단계', icon: '🏗️', color: 'green' },
}

export default function ChecklistTab() {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [activeStage, setActiveStage] = useState<Stage>('pre')
  const { liveSmp, priceOverride } = useSolarStore()
  const smpDisplay = liveSmp ?? priceOverride.smp

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) setChecked(JSON.parse(saved))
    } catch {}
  }, [])

  // c5 안내 문구를 실시간 SMP/REC 값으로 동기화
  const checklist = useMemo<CheckItem[]>(
    () =>
      CHECKLIST.map(item =>
        item.id === 'c5'
          ? {
              ...item,
              text: `수익성 시뮬레이터 계산 (SMP ${smpDisplay.toFixed(2)}원${liveSmp != null ? ' KPX 실시간' : ''}, REC ${priceOverride.recBuilding.toLocaleString()}/${priceOverride.recLand.toLocaleString()}원 자동 반영)`,
            }
          : item,
      ),
    [smpDisplay, liveSmp, priceOverride.recBuilding, priceOverride.recLand],
  )

  const toggle = (id: string) => {
    const next = { ...checked, [id]: !checked[id] }
    setChecked(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
  }

  const totalItems = checklist.length
  const checkedCount = checklist.filter(i => checked[i.id]).length
  const progress = Math.round((checkedCount / totalItems) * 100)
  const requiredUnchecked = checklist.filter(i => i.required && !checked[i.id])

  const stageItems = (stage: Stage) => checklist.filter(i => i.stage === stage)
  const stageProgress = (stage: Stage) => {
    const items = stageItems(stage)
    const done = items.filter(i => checked[i.id]).length
    return { done, total: items.length, pct: Math.round((done / items.length) * 100) }
  }

  return (
    <div className="space-y-4">
      {/* Required warning */}
      {requiredUnchecked.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-3">
          <span className="text-red-500 text-xl flex-shrink-0">⚠</span>
          <span className="text-sm font-semibold text-red-700">
            필수 항목 {requiredUnchecked.length}개 미완료 — 완료 전 다음 단계 진행 주의
          </span>
        </div>
      )}

      {/* Overall progress */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <span>✅</span> 실무 체크리스트
          </h3>
          <div className="text-right">
            <div className="text-2xl font-bold text-blue-600">{progress}%</div>
            <div className="text-xs text-gray-500">{checkedCount}/{totalItems}개 완료</div>
          </div>
        </div>

        {/* Circular-style progress */}
        <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-green-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Stage overview */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          {(Object.keys(STAGE_INFO) as Stage[]).map(stage => {
            const { done, total, pct } = stageProgress(stage)
            const info = STAGE_INFO[stage]
            const colorMap: Record<string, string> = {
              blue: 'bg-blue-50 border-blue-200 text-blue-700',
              orange: 'bg-orange-50 border-orange-200 text-orange-700',
              green: 'bg-green-50 border-green-200 text-green-700',
            }
            return (
              <button
                key={stage}
                onClick={() => setActiveStage(stage)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  activeStage === stage
                    ? colorMap[info.color] + ' shadow-sm'
                    : 'bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                <div className="text-lg mb-1">{info.icon}</div>
                <div className="text-xs font-semibold">{info.label}</div>
                <div className="text-lg font-bold mt-1">{pct}%</div>
                <div className="text-xs opacity-70">{done}/{total}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Stage tabs */}
      <div className="flex gap-2">
        {(Object.keys(STAGE_INFO) as Stage[]).map(stage => {
          const info = STAGE_INFO[stage]
          return (
            <button
              key={stage}
              onClick={() => setActiveStage(stage)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border-2 transition-colors ${
                activeStage === stage
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
              }`}
            >
              {info.icon} {info.label}
            </button>
          )
        })}
      </div>

      {/* Items */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
          <h3 className="font-semibold text-gray-700">
            {STAGE_INFO[activeStage].icon} {STAGE_INFO[activeStage].label}
          </h3>
        </div>
        <div className="p-4 space-y-2">
          {stageItems(activeStage).map(item => {
            const isChecked = checked[item.id] ?? false
            return (
              <div
                key={item.id}
                className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                  isChecked
                    ? 'bg-green-50 border-green-200'
                    : item.required
                    ? 'bg-white border-red-200 hover:border-red-300'
                    : 'bg-white border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => toggle(item.id)}
              >
                <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                  isChecked ? 'bg-green-500 border-green-500' : item.required ? 'border-red-400' : 'border-gray-400'
                }`}>
                  {isChecked && <span className="text-white text-xs font-bold">✓</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <span className={`text-sm leading-relaxed ${isChecked ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                    {item.text}
                  </span>
                  {item.link && !isChecked && (
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="ml-2 text-xs text-blue-500 underline hover:text-blue-700"
                    >
                      바로가기 →
                    </a>
                  )}
                </div>
                {item.required && !isChecked && (
                  <span className="flex-shrink-0 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-semibold">필수</span>
                )}
                {isChecked && (
                  <span className="flex-shrink-0 text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded font-semibold">완료</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 text-sm text-blue-700">
        <span className="font-semibold">💾 자동 저장:</span> 체크 완료 항목은 브라우저 로컬스토리지에 자동 저장됩니다. 재방문 시에도 진행 상황이 유지됩니다.
      </div>
    </div>
  )
}
