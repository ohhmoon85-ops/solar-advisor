'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
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

export default function HistoryPage() {
  const [all, setAll] = useState<SimulationRecord[]>([])
  const [filtered, setFiltered] = useState<SimulationRecord[]>([])
  const [selected, setSelected] = useState<SimulationRecord | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<FilterOptions>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editMemo, setEditMemo] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [toast, setToast] = useState('')
  const [storageAvailable] = useState(() => isLocalStorageAvailable())
  const importRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stats = getStatsSummary()

  const reload = useCallback(() => {
    const base = getAllSimulations()
    setAll(base)

    let list: SimulationRecord[]
    if (query.trim()) {
      list = searchSimulations(query)
    } else if (Object.keys(filters).some(k => filters[k as keyof FilterOptions] !== undefined)) {
      list = filterSimulations(filters)
    } else {
      list = base
    }
    setFiltered(list)
    if (selected && !list.find(r => r.id === selected.id)) setSelected(null)
  }, [query, filters, selected])

  useEffect(() => { reload() }, [reload])

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => reload(), 200)
  }

  const handleDelete = (id: string) => {
    deleteSimulation(id)
    if (selected?.id === id) setSelected(null)
    reload()
  }

  const handleDeleteSelected = () => {
    checkedIds.forEach(id => deleteSimulation(id))
    setCheckedIds(new Set())
    reload()
  }

  const handleClearAll = () => {
    if (!confirmClear) { setConfirmClear(true); return }
    deleteAllSimulations()
    setConfirmClear(false)
    setSelected(null)
    reload()
  }

  const saveEdit = (id: string) => {
    updateSimulation(id, { clientName: editName || undefined, clientMemo: editMemo || undefined })
    setEditingId(null)
    reload()
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const count = await importFromJson(file)
      reload()
      showToast(`${count}건 가져오기 완료`)
    } catch {
      showToast('가져오기 실패')
    } finally {
      e.target.value = ''
    }
  }

  const toggleCheck = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 네비 */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-xl flex items-center justify-center text-lg">☀️</div>
            <span className="font-bold text-gray-900 hidden sm:block">SolarAdvisor</span>
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-gray-700 font-semibold text-sm">현장 이력 관리</span>
          <div className="ml-auto flex items-center gap-2">
            {storageAvailable && (
              <>
                <button onClick={() => importRef.current?.click()} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">📥 JSON 가져오기</button>
                <button onClick={exportToJson} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">📤 JSON 내보내기</button>
                <button onClick={exportToCsv} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">📊 CSV 내보내기</button>
                {checkedIds.size > 0 && (
                  <button onClick={handleDeleteSelected} className="text-xs px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600">선택 삭제 ({checkedIds.size})</button>
                )}
                <button
                  onClick={handleClearAll}
                  onBlur={() => setConfirmClear(false)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${confirmClear ? 'bg-red-500 text-white border-red-500' : 'text-red-400 border-red-200 hover:bg-red-50'}`}
                >
                  {confirmClear ? '정말 전체 삭제?' : '🗑 전체 삭제'}
                </button>
                <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
              </>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto px-4 py-4">
        {/* 통계 바 */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          {[
            { label: '전체 이력', value: `${stats.totalCount}건` },
            { label: '전체 설계 용량', value: `${stats.totalKwpSum.toFixed(0)} kWp` },
            { label: '평균 투자 회수', value: `${stats.avgPaybackYears.toFixed(1)}년` },
            { label: '가장 많이 쓴 패널', value: stats.mostUsedPanelType.split('(')[0].trim() || '-' },
            {
              label: '권역 분포',
              value: Object.entries(stats.regionDistribution)
                .map(([r, c]) => `${r.split('(')[0]} ${c}건`)
                .join(' / ') || '-',
            },
          ].map(item => (
            <div key={item.label} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
              <div className="text-[11px] text-gray-400">{item.label}</div>
              <div className="text-sm font-bold text-gray-800 mt-0.5 truncate">{item.value}</div>
            </div>
          ))}
        </div>

        {/* 검색 + 필터 */}
        <div className="flex flex-wrap gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
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
          {[
            {
              label: '전체 지역', key: 'region' as keyof FilterOptions,
              options: [{ v: '', l: '전체 지역' }, { v: '강원/경기북부', l: '강원' }, { v: '중부(서울/충청)', l: '중부' }, { v: '남부(경상/전라)', l: '남부' }, { v: '제주', l: '제주' }],
            },
            {
              label: '전체 유형', key: 'plotType' as keyof FilterOptions,
              options: [{ v: '', l: '전체 유형' }, { v: 'land', l: '토지' }, { v: 'roof', l: '지붕' }, { v: 'farmland', l: '농지' }, { v: 'forest', l: '임야' }],
            },
            {
              label: '전체 방식', key: 'layoutMode' as keyof FilterOptions,
              options: [{ v: '', l: '전체 방식' }, { v: 'dense', l: '밀집' }, { v: 'balanced', l: '균형' }, { v: 'efficiency', l: '효율' }],
            },
          ].map(({ key, options }) => (
            <select
              key={key}
              value={String(filters[key] ?? '')}
              onChange={e => {
                setFilters(prev => ({ ...prev, [key]: e.target.value || undefined }))
                setTimeout(reload, 0)
              }}
              className="text-xs border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300"
            >
              {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          ))}
        </div>

        {/* 메인 레이아웃: 목록 + 상세 */}
        <div className="flex gap-4 min-h-[60vh]">
          {/* 목록 */}
          <div className="flex-1 space-y-2 overflow-y-auto max-h-[calc(100vh-260px)]">
            {filtered.length === 0 && (
              <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-200">
                <div className="text-4xl mb-2">📋</div>
                <div className="text-sm">{query || Object.values(filters).some(Boolean) ? '검색 결과가 없습니다' : '저장된 이력이 없습니다'}</div>
              </div>
            )}
            {filtered.map(r => {
              const borderCls = BORDER_COLOR[r.memoColor ?? 'default']
              const isSelected = selected?.id === r.id
              const isEditing = editingId === r.id

              return (
                <div
                  key={r.id}
                  className={`bg-white border border-l-4 ${borderCls} rounded-xl shadow-sm transition-all cursor-pointer ${isSelected ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
                  onClick={() => setSelected(r)}
                >
                  <div className="p-3 flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={checkedIds.has(r.id)}
                      onChange={() => toggleCheck(r.id)}
                      onClick={e => e.stopPropagation()}
                      className="mt-0.5 accent-blue-500 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-gray-400">{formatDate(r.savedAt)}</span>
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                          <button onClick={() => { setEditingId(r.id); setEditName(r.clientName ?? ''); setEditMemo(r.clientMemo ?? '') }} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">수정</button>
                          <button onClick={() => handleDelete(r.id)} className="text-[10px] px-1.5 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50">삭제</button>
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-gray-900 truncate">📍 {r.address}</div>
                      {isEditing ? (
                        <div className="space-y-1 mt-1" onClick={e => e.stopPropagation()}>
                          <input type="text" value={editName} onChange={e => setEditName(e.target.value)} placeholder="수요자 이름" className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none" />
                          <input type="text" value={editMemo} onChange={e => setEditMemo(e.target.value)} placeholder="메모" className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none" />
                          <div className="flex gap-1">
                            <button onClick={() => saveEdit(r.id)} className="flex-1 text-[11px] py-0.5 bg-blue-500 text-white rounded-lg">저장</button>
                            <button onClick={() => setEditingId(null)} className="flex-1 text-[11px] py-0.5 bg-gray-100 rounded-lg">취소</button>
                          </div>
                        </div>
                      ) : (
                        (r.clientName || r.clientMemo) && (
                          <div className="text-xs text-gray-500">
                            {r.clientName && <span>👤 {r.clientName}</span>}
                            {r.clientName && r.clientMemo && ' · '}
                            {r.clientMemo && <span>📝 &ldquo;{r.clientMemo}&rdquo;</span>}
                          </div>
                        )
                      )}
                      <div className="text-xs text-gray-500 mt-0.5">
                        {r.panelLabel.split('·')[0].trim()} · {r.totalPanels.toLocaleString()}장 · {r.totalKwp.toFixed(1)} kWp · 회수 {r.paybackYears > 0 ? `${r.paybackYears.toFixed(1)}년` : '불가'} · ROI {r.roi20yr.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 상세 패널 */}
          <div className="hidden lg:block w-80 flex-shrink-0">
            {selected ? (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sticky top-4">
                <div className="h-1 w-full -mx-4 -mt-4 mb-4 rounded-t-xl bg-gradient-to-r from-blue-500 to-indigo-500" />
                <h3 className="font-bold text-gray-900 text-sm mb-1 truncate">{selected.address}</h3>
                <div className="text-xs text-gray-400 mb-3">{formatDate(selected.savedAt)}</div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  {[
                    { label: '패널 수', value: `${selected.totalPanels.toLocaleString()}장` },
                    { label: '설비 용량', value: `${selected.totalKwp.toFixed(1)} kWp` },
                    { label: '투자 회수', value: selected.paybackYears > 0 ? `${selected.paybackYears.toFixed(1)}년` : '불가' },
                    { label: '20년 ROI', value: `${selected.roi20yr.toFixed(0)}%` },
                    { label: '연간 수익', value: `${Math.round(selected.annualRevenueKrw / 10000).toLocaleString()}만원` },
                    { label: '총 설치비', value: `${Math.round(selected.totalCostKrw / 10000).toLocaleString()}만원` },
                  ].map(item => (
                    <div key={item.label} className="bg-gray-50 rounded-xl px-3 py-2">
                      <div className="text-[10px] text-gray-400">{item.label}</div>
                      <div className="text-sm font-bold text-gray-800">{item.value}</div>
                    </div>
                  ))}
                </div>

                <div className="space-y-1 text-xs text-gray-600 mb-4">
                  <div className="flex justify-between"><span className="text-gray-400">부지 유형</span><span>{PLOT_TYPE_LABEL[selected.plotType] ?? selected.plotType}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">부지 면적</span><span>{selected.plotAreaM2.toFixed(0)} m²</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">패널 모델</span><span className="text-right max-w-[150px] truncate">{selected.panelLabel}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">경사각</span><span>{selected.tiltAngle}°</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">방위각</span><span>{selected.azimuthDeg}°</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">이격 거리</span><span>{selected.rowSpacing.toFixed(2)} m</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">이용률</span><span>{(selected.utilizationRate * 100).toFixed(1)} %</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">구역 수</span><span>{selected.zoneCount}구역</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">LCOE</span><span>{selected.lcoe.toFixed(1)} 원/kWh</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">권역</span><span>{selected.region}</span></div>
                </div>

                <Link
                  href="/"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      sessionStorage.setItem('pendingRestore', JSON.stringify(selected))
                    }
                  }}
                  className="block w-full py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-xl text-center transition-colors"
                >
                  ▶ 메인에서 불러오기
                </Link>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-dashed border-gray-200 p-8 text-center text-gray-400 text-xs sticky top-4">
                이력을 클릭하면<br/>상세 정보가 표시됩니다
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-xs px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
