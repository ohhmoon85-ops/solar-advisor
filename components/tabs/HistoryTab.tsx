'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSolarStore } from '@/store/useStore'
import {
  getHistory,
  deleteHistory,
  updateMemo,
  clearHistory,
  type HistoryEntry,
} from '@/lib/historyManager'
import { MODULES } from '@/lib/constants'

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

const INSTALL_TYPE_COLOR: Record<string, string> = {
  '건물지붕형': 'bg-blue-100 text-blue-700',
  '일반토지형': 'bg-green-100 text-green-700',
  '영농형농지': 'bg-amber-100 text-amber-700',
  '임야형': 'bg-emerald-100 text-emerald-700',
}

export default function HistoryTab() {
  const { setActiveTab, setPendingHistoryLoad } = useSolarStore()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [editingMemo, setEditingMemo] = useState<string | null>(null)
  const [memoValue, setMemoValue] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = useCallback(() => {
    setEntries(getHistory())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleLoad = (entry: HistoryEntry) => {
    setPendingHistoryLoad(entry)
    setActiveTab('map')
  }

  const handleDelete = (id: string) => {
    deleteHistory(id)
    reload()
  }

  const handleMemoEdit = (entry: HistoryEntry) => {
    setEditingMemo(entry.id)
    setMemoValue(entry.memo)
  }

  const handleMemoSave = (id: string) => {
    updateMemo(id, memoValue)
    setEditingMemo(null)
    reload()
  }

  const handleClearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    clearHistory()
    setConfirmClear(false)
    reload()
  }

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-900">현장 분석 이력</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            수익성 분석으로 보낸 현장이 자동 저장됩니다. 최대 50건 보관.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 font-medium">{entries.length}건</span>
          {entries.length > 0 && (
            <button
              onClick={handleClearAll}
              onBlur={() => setConfirmClear(false)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                confirmClear
                  ? 'bg-red-500 text-white border-red-500'
                  : 'text-red-500 border-red-200 hover:bg-red-50'
              }`}
            >
              {confirmClear ? '정말 삭제?' : '전체 삭제'}
            </button>
          )}
        </div>
      </div>

      {/* 비어 있을 때 */}
      {entries.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-3">📋</div>
          <div className="text-gray-500 font-medium mb-1">저장된 이력이 없습니다</div>
          <div className="text-xs text-gray-400">
            지도 탭에서 분석 후 &quot;수익성 분석으로 이동&quot;을 누르면 자동 저장됩니다
          </div>
        </div>
      )}

      {/* 이력 카드 목록 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {entries.map((entry) => {
          const moduleName = MODULES[entry.moduleIndex]?.name ?? `모듈 #${entry.moduleIndex}`
          const typeColor = INSTALL_TYPE_COLOR[entry.installType] ?? 'bg-gray-100 text-gray-700'
          const isEditingThis = editingMemo === entry.id

          return (
            <div
              key={entry.id}
              className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
            >
              {/* 상단 컬러 바 */}
              <div className="h-1 bg-gradient-to-r from-blue-500 to-indigo-500" />

              <div className="p-4">
                {/* 주소 + 날짜 */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 text-sm truncate leading-tight">
                      {entry.addresses.filter(Boolean).join(', ') || '주소 없음'}
                    </div>
                    {entry.parcelLabel && entry.parcelLabel !== entry.addresses.filter(Boolean).join(', ') && (
                      <div className="text-[11px] text-gray-400 mt-0.5 truncate">{entry.parcelLabel}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors"
                    title="이력 삭제"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                {/* 뱃지 */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${typeColor}`}>
                    {entry.installType}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">
                    경사 {entry.tiltAngle}°
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700 max-w-[160px] truncate">
                    {moduleName}
                  </span>
                </div>

                {/* 핵심 수치 */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="text-center bg-blue-50 rounded-lg py-2">
                    <div className="text-xs text-blue-500 font-medium leading-tight">패널</div>
                    <div className="text-sm font-bold text-blue-700">{entry.panelCount.toLocaleString()}장</div>
                  </div>
                  <div className="text-center bg-indigo-50 rounded-lg py-2">
                    <div className="text-xs text-indigo-500 font-medium leading-tight">용량</div>
                    <div className="text-sm font-bold text-indigo-700">{entry.capacityKwp.toFixed(1)} kWp</div>
                  </div>
                  <div className="text-center bg-amber-50 rounded-lg py-2">
                    <div className="text-xs text-amber-500 font-medium leading-tight">연발전</div>
                    <div className="text-sm font-bold text-amber-700">{(entry.annualKwh / 1000).toFixed(0)}MWh</div>
                  </div>
                </div>

                {/* 부지 면적 + 저장 시각 */}
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-3">
                  <span>부지 {entry.areaSqm.toFixed(0)} m²</span>
                  <span>{formatDate(entry.savedAt)}</span>
                </div>

                {/* 메모 */}
                {isEditingThis ? (
                  <div className="mb-3">
                    <textarea
                      value={memoValue}
                      onChange={e => setMemoValue(e.target.value)}
                      rows={2}
                      placeholder="현장 메모를 입력하세요..."
                      className="w-full text-xs border border-blue-300 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
                      autoFocus
                    />
                    <div className="flex gap-1.5 mt-1">
                      <button
                        onClick={() => handleMemoSave(entry.id)}
                        className="flex-1 text-[11px] py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                      >
                        저장
                      </button>
                      <button
                        onClick={() => setEditingMemo(null)}
                        className="flex-1 text-[11px] py-1 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => handleMemoEdit(entry)}
                    className="w-full text-left text-[11px] px-2.5 py-1.5 rounded-lg border border-dashed border-gray-200 text-gray-400 hover:border-blue-300 hover:text-blue-400 transition-colors mb-3 min-h-[32px]"
                  >
                    {entry.memo || '+ 메모 추가'}
                  </button>
                )}

                {/* 불러오기 버튼 */}
                <button
                  onClick={() => handleLoad(entry)}
                  className="w-full py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <path d="M6.5 2v9M2 6.5l4.5-4.5 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  지도에서 불러오기
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
