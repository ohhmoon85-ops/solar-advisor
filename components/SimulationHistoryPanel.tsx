'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSolarStore } from '@/store/useStore'
import {
  getAllSimulations,
  searchSimulations,
  filterSimulations,
  deleteSimulation,
  deleteAllSimulations,
  updateSimulation,
  exportToJson,
  exportToCsv,
  importFromJson,
  getStatsSummary,
  isLocalStorageAvailable,
  type SimulationRecord,
  type FilterOptions,
} from '@/lib/simulationHistory'

// ── 헬퍼 ───────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

const PLOT_TYPE_LABEL: Record<string, string> = {
  land: '일반토지형', roof: '건물지붕형',
  farmland: '영농형농지', forest: '임야형',
  land_change_planned: '지목변경예정',
}

const BORDER_COLOR: Record<string, string> = {
  green: 'border-l-green-500',
  blue: 'border-l-blue-500',
  gray: 'border-l-gray-400',
  default: 'border-l-transparent',
}

// ── 컴포넌트 ────────────────────────────────────────────────────────

export default function SimulationHistoryPanel() {
  const {
    historyPanelOpen, setHistoryPanelOpen,
    setPendingRestore, setActiveTab,
    setHistoryCount,
  } = useSolarStore()

  const [records, setRecords] = useState<SimulationRecord[]>([])
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<FilterOptions>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editMemo, setEditMemo] = useState('')
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [storageAvailable] = useState(() => isLocalStorageAvailable())
  const importRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 이력 로드
  const reload = useCallback(() => {
    let list: SimulationRecord[]
    if (query.trim()) {
      list = searchSimulations(query)
    } else if (Object.keys(filters).some(k => filters[k as keyof FilterOptions] !== undefined)) {
      list = filterSimulations(filters)
    } else {
      list = getAllSimulations()
    }
    setRecords(list)
    setHistoryCount(getAllSimulations().length)
  }, [query, filters, setHistoryCount])

  useEffect(() => {
    if (historyPanelOpen) reload()
  }, [historyPanelOpen, reload])

  // 검색 debounce
  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => reload(), 200)
  }

  // 불러오기
  const handleLoad = (record: SimulationRecord) => {
    setPendingRestore(record)
    setActiveTab('map')
    setHistoryPanelOpen(false)
    showToast('이전 결과를 불러왔습니다')
  }

  // 삭제
  const handleDelete = (id: string) => {
    deleteSimulation(id)
    reload()
  }

  // 편집 시작
  const startEdit = (r: SimulationRecord) => {
    setEditingId(r.id)
    setEditName(r.clientName ?? '')
    setEditMemo(r.clientMemo ?? '')
  }

  // 편집 저장
  const saveEdit = (id: string) => {
    updateSimulation(id, { clientName: editName || undefined, clientMemo: editMemo || undefined })
    setEditingId(null)
    reload()
  }

  // 전체 삭제
  const handleClearAll = () => {
    if (!confirmClearAll) { setConfirmClearAll(true); return }
    deleteAllSimulations()
    setConfirmClearAll(false)
    reload()
  }

  // JSON 가져오기
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const count = await importFromJson(file)
      reload()
      showToast(`${count}건 가져오기 완료`)
    } catch {
      showToast('가져오기 실패: 올바른 JSON 파일인지 확인하세요')
    } finally {
      e.target.value = ''
    }
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const stats = statsOpen ? getStatsSummary() : null

  if (!historyPanelOpen) return null

  return (
    <>
      <style>{`
        @keyframes panel-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .history-panel { animation: panel-slide-in 0.28s cubic-bezier(.22,.68,0,1.1) forwards; }
      `}</style>

      {/* 오버레이 */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={() => setHistoryPanelOpen(false)}
      />

      {/* 패널 */}
      <div className="history-panel fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[420px] bg-white shadow-2xl flex flex-col">

        {/* 상단 그라디언트 바 */}
        <div className="h-1 flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-500" />

        {/* 헤더 */}
        <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-gray-900">시뮬레이션 이력</span>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                총 {getAllSimulations().length}건
              </span>
            </div>
            <button
              onClick={() => setHistoryPanelOpen(false)}
              className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* 검색 */}
          <div className="relative mb-2">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="14" height="14" fill="none" viewBox="0 0 14 14">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={query}
              onChange={e => handleQueryChange(e.target.value)}
              placeholder="주소, 수요자명, 메모로 검색"
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* 필터 드롭다운 */}
          <div className="flex gap-1.5 mb-3">
            {[
              {
                label: '전체 지역', key: 'region' as keyof FilterOptions,
                options: [
                  { v: '', l: '전체 지역' },
                  { v: '강원/경기북부', l: '강원/경기북부' },
                  { v: '중부(서울/충청)', l: '중부' },
                  { v: '남부(경상/전라)', l: '남부' },
                  { v: '제주', l: '제주' },
                ],
              },
              {
                label: '전체 유형', key: 'plotType' as keyof FilterOptions,
                options: [
                  { v: '', l: '전체 유형' },
                  { v: 'land', l: '토지' },
                  { v: 'roof', l: '지붕' },
                  { v: 'farmland', l: '농지' },
                  { v: 'forest', l: '임야' },
                ],
              },
            ].map(({ label, key, options }) => (
              <select
                key={key}
                value={String(filters[key] ?? '')}
                onChange={e => {
                  setFilters(prev => ({ ...prev, [key]: e.target.value || undefined }))
                  setTimeout(reload, 0)
                }}
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300"
              >
                {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            ))}
          </div>

          {/* 버튼 행 */}
          {storageAvailable && (
            <div className="flex gap-1.5">
              <button
                onClick={() => importRef.current?.click()}
                className="flex-1 text-[11px] py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors"
              >
                📥 JSON 가져오기
              </button>
              <button
                onClick={exportToJson}
                className="flex-1 text-[11px] py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors"
              >
                📤 JSON 내보내기
              </button>
              <button
                onClick={exportToCsv}
                className="flex-1 text-[11px] py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors"
              >
                📊 CSV 내보내기
              </button>
              <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
            </div>
          )}
        </div>

        {/* 이력 목록 */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">

          {!storageAvailable && (
            <div className="text-center py-8 text-xs text-gray-400">
              이 브라우저에서는 이력 저장이 지원되지 않습니다
            </div>
          )}

          {storageAvailable && records.length === 0 && (
            <div className="text-center py-12">
              <div className="text-3xl mb-2">📋</div>
              <div className="text-sm text-gray-400">
                {query || Object.values(filters).some(Boolean) ? '검색 결과가 없습니다' : '저장된 이력이 없습니다'}
              </div>
              {!query && (
                <div className="text-xs text-gray-300 mt-1">수익성 탭에서 저장 버튼을 누르세요</div>
              )}
            </div>
          )}

          {records.map(r => {
            const borderCls = BORDER_COLOR[r.memoColor ?? 'default']
            const isExpanded = expandedId === r.id
            const isEditing = editingId === r.id

            return (
              <div
                key={r.id}
                className={`bg-white border border-gray-200 border-l-4 ${borderCls} rounded-xl shadow-sm hover:shadow-md transition-shadow overflow-hidden`}
              >
                <div className="p-3">
                  {/* 날짜 + 버튼 */}
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-gray-400">{formatDate(r.savedAt)}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => startEdit(r)}
                        className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                      >
                        수정
                      </button>
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50"
                      >
                        삭제
                      </button>
                    </div>
                  </div>

                  {/* 주소 */}
                  <div className="text-sm font-semibold text-gray-900 truncate mb-0.5">
                    📍 {r.address}
                  </div>

                  {/* 수요자 + 메모 */}
                  {isEditing ? (
                    <div className="space-y-1.5 my-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="수요자 이름"
                        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300"
                      />
                      <input
                        type="text"
                        value={editMemo}
                        onChange={e => setEditMemo(e.target.value)}
                        placeholder="메모"
                        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300"
                      />
                      <div className="flex gap-1">
                        <button onClick={() => saveEdit(r.id)} className="flex-1 text-[11px] py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600">저장</button>
                        <button onClick={() => setEditingId(null)} className="flex-1 text-[11px] py-1 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200">취소</button>
                      </div>
                    </div>
                  ) : (
                    (r.clientName || r.clientMemo) && (
                      <div className="text-xs text-gray-500 mb-1">
                        {r.clientName && <span>👤 {r.clientName}</span>}
                        {r.clientName && r.clientMemo && <span className="mx-1">·</span>}
                        {r.clientMemo && <span>📝 &ldquo;{r.clientMemo}&rdquo;</span>}
                      </div>
                    )
                  )}

                  {/* 핵심 수치 한줄 */}
                  <div className="text-xs text-gray-600 mb-2">
                    {r.panelLabel.split('·')[0].trim()} · {r.totalPanels.toLocaleString()}장 · {r.totalKwp.toFixed(1)} kWp · 경사 {r.tiltAngle}°
                  </div>

                  <div className="text-xs text-gray-600 mb-2">
                    투자회수 {r.paybackYears > 0 ? `${r.paybackYears.toFixed(1)}년` : '회수불가'} · 20년ROI {r.roi20yr.toFixed(0)}%
                  </div>

                  {/* 상세 펼침 */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : r.id)}
                    className="text-[11px] text-blue-500 hover:text-blue-700 mb-2"
                  >
                    {isExpanded ? '▲ 접기' : '▼ 상세 보기'}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-100 pt-2 mt-1 mb-2 space-y-1 text-xs text-gray-600">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                        <span className="text-gray-400">부지 유형</span><span>{PLOT_TYPE_LABEL[r.plotType] ?? r.plotType}</span>
                        <span className="text-gray-400">부지 면적</span><span>{r.plotAreaM2.toFixed(0)} m²</span>
                        <span className="text-gray-400">방위각</span><span>{r.azimuthDeg}°</span>
                        <span className="text-gray-400">이격 거리</span><span>{r.rowSpacing.toFixed(2)} m</span>
                        <span className="text-gray-400">이용률</span><span>{(r.utilizationRate * 100).toFixed(1)} %</span>
                        <span className="text-gray-400">구역 수</span><span>{r.zoneCount}구역</span>
                        <span className="text-gray-400">총 설치비</span><span>{Math.round(r.totalCostKrw / 10000).toLocaleString()}만원</span>
                        <span className="text-gray-400">연간 수익</span><span>{Math.round(r.annualRevenueKrw / 10000).toLocaleString()}만원</span>
                        <span className="text-gray-400">LCOE</span><span>{r.lcoe.toFixed(1)}원/kWh</span>
                        <span className="text-gray-400">권역</span><span>{r.region}</span>
                      </div>
                    </div>
                  )}

                  {/* 불러오기 버튼 */}
                  <button
                    onClick={() => handleLoad(r)}
                    className="w-full py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1"
                  >
                    ▶ 이 결과 불러오기
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* 하단 통계 + 전체 삭제 */}
        <div className="flex-shrink-0 border-t border-gray-100 px-4 py-3">
          <button
            onClick={() => setStatsOpen(v => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 mb-2 w-full text-left flex items-center gap-1"
          >
            <span>{statsOpen ? '▲' : '▼'}</span> 통계 요약
          </button>

          {statsOpen && stats && (
            <div className="text-xs text-gray-600 space-y-0.5 mb-3 bg-gray-50 rounded-xl p-3">
              <div className="flex justify-between"><span className="text-gray-400">전체 저장</span><span>{stats.totalCount}건</span></div>
              <div className="flex justify-between"><span className="text-gray-400">전체 설계 용량</span><span>{stats.totalKwpSum.toFixed(1)} kWp</span></div>
              <div className="flex justify-between"><span className="text-gray-400">평균 투자 회수</span><span>{stats.avgPaybackYears.toFixed(1)}년</span></div>
              <div className="flex justify-between"><span className="text-gray-400">가장 많이 쓴 패널</span><span className="max-w-[180px] text-right truncate">{stats.mostUsedPanelType}</span></div>
              {Object.entries(stats.regionDistribution).map(([region, count]) => (
                <div key={region} className="flex justify-between">
                  <span className="text-gray-400">{region}</span><span>{count}건</span>
                </div>
              ))}
            </div>
          )}

          {records.length > 0 && (
            <button
              onClick={handleClearAll}
              onBlur={() => setConfirmClearAll(false)}
              className={`w-full text-xs py-2 rounded-xl border transition-colors ${
                confirmClearAll
                  ? 'bg-red-500 text-white border-red-500'
                  : 'text-red-400 border-red-200 hover:bg-red-50'
              }`}
            >
              {confirmClearAll ? '정말 전체 삭제?' : '🗑 전체 삭제'}
            </button>
          )}
        </div>
      </div>

      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-gray-900 text-white text-xs px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
