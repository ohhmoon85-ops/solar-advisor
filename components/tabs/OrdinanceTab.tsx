'use client'

import { useState, useMemo } from 'react'
import {
  ORDINANCE_RECORDS,
  SIDO_LIST,
  getSigunguList,
  findRecord,
  searchRecords,
  type OrdinanceRecord,
} from '@/lib/ordinanceData'

// ── 계통 상태 배지 ──────────────────────────────────────────────
function SystemBadge({ status }: { status: string }) {
  if (status.includes('★★★'))
    return <span className="bg-red-700 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★★'))
    return <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★'))
    return <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '포화')
    return <span className="bg-orange-400 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '보통')
    return <span className="bg-yellow-400 text-gray-800 text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '여유')
    return <span className="bg-green-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  return <span className="text-xs text-gray-600">{status}</span>
}

// ── 이격거리 표시 ───────────────────────────────────────────────
function IgeokText({ m }: { m: number }) {
  if (m === 0) return <span className="text-green-600 font-bold">규정없음</span>
  return <span className="text-red-600 font-bold">{m}m</span>
}

// ── 단일 비교 카드 ──────────────────────────────────────────────
function CompareCard({
  record,
  onRemove,
}: {
  record: OrdinanceRecord
  onRemove: () => void
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 relative flex-1 min-w-[220px]">
      <button
        onClick={onRemove}
        className="absolute top-2 right-2 text-gray-300 hover:text-red-400 text-lg leading-none"
        aria-label="제거"
      >
        ×
      </button>

      {/* 헤더 */}
      <div className="mb-3">
        <div className="text-xs text-gray-400 mb-0.5">{record.sido}</div>
        <div className="text-lg font-bold text-gray-900">{record.sigungu}</div>
        <div className="mt-1.5"><SystemBadge status={record.계통} /></div>
      </div>

      {/* 핵심 수치 그리드 */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">주거이격</div>
          <IgeokText m={record.주거이격} />
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">농지설치</div>
          <span className={`font-bold ${record.농지설치 ? 'text-green-600' : 'text-red-600'}`}>
            {record.농지설치 ? '허용' : '불허'}
          </span>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">소음기준</div>
          <span className="font-bold text-gray-800">
            {record.소음 === 0 ? '규정없음' : `${record.소음}dB`}
          </span>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">지붕보조금</div>
          <span className="font-bold text-blue-600">
            {record.지붕보조금율 === 0 ? '없음' : `${record.지붕보조금율}%`}
          </span>
          {record.지붕보조금한도kW > 0 && (
            <div className="text-[10px] text-gray-400">
              ~{record.지붕보조금한도kW}kW
            </div>
          )}
        </div>
      </div>

      {/* 비고 */}
      <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 leading-relaxed">
        {record.비고}
      </div>
      <div className="text-[10px] text-gray-300 text-right mt-2">기준일 {record.lastUpdated}</div>

      {/* 계통 포화 경고 */}
      {record.계통.includes('포화') && (
        <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600">
          계통 포화 — 발전사업허가 전 한전(☎ 123) 사전 협의 필수
        </div>
      )}
    </div>
  )
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────
export default function OrdinanceTab() {
  const [selectedSido, setSelectedSido] = useState<string>('')
  const [selectedSigungu, setSelectedSigungu] = useState<string>('')
  const [comparison, setComparison] = useState<OrdinanceRecord[]>([])
  const [searchText, setSearchText] = useState<string>('')
  const [tableExpanded, setTableExpanded] = useState<boolean>(false)

  const sigunguList = useMemo(() => getSigunguList(selectedSido), [selectedSido])

  const searchResults = useMemo(
    () => (searchText.trim().length >= 1 ? searchRecords(searchText) : []),
    [searchText]
  )

  const previewRecord = useMemo(
    () => findRecord(selectedSido, selectedSigungu),
    [selectedSido, selectedSigungu]
  )

  const handleSidoChange = (sido: string) => {
    setSelectedSido(sido)
    setSelectedSigungu('')
  }

  const handleAddComparison = (record: OrdinanceRecord) => {
    if (comparison.length >= 3) return
    const dup = comparison.some(c => c.sido === record.sido && c.sigungu === record.sigungu)
    if (dup) return
    setComparison(prev => [...prev, record])
  }

  const handleRemoveComparison = (idx: number) => {
    setComparison(prev => prev.filter((_, i) => i !== idx))
  }

  const handleAddFromDropdown = () => {
    if (!previewRecord) return
    handleAddComparison(previewRecord)
    setSelectedSido('')
    setSelectedSigungu('')
  }

  const handleAddFromSearch = (record: OrdinanceRecord) => {
    handleAddComparison(record)
    setSearchText('')
  }

  return (
    <div className="space-y-4">
      {/* ── 상단 설명 ───────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
          <span className="text-lg">⚖️</span> 지자체 조례 비교 <span className="text-xs font-normal text-gray-400">(최대 3개 시·군·구 동시 비교)</span>
        </h3>
        <p className="text-xs text-gray-400">
          아래 드롭다운 또는 검색창에서 시·군·구를 선택 후 <strong>비교 추가</strong>를 클릭하세요.
          계통·이격·농지·보조금을 한눈에 비교할 수 있습니다.
        </p>
      </div>

      {/* ── 지역 선택 (2-step 드롭다운) ─────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap gap-2 items-end">
          {/* 1단계: 시·도 */}
          <div className="flex-1 min-w-[130px]">
            <label className="block text-xs font-semibold text-gray-500 mb-1">시·도</label>
            <select
              value={selectedSido}
              onChange={e => handleSidoChange(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">시·도 선택...</option>
              {SIDO_LIST.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* 2단계: 시·군·구 */}
          <div className="flex-1 min-w-[130px]">
            <label className="block text-xs font-semibold text-gray-500 mb-1">시·군·구</label>
            <select
              value={selectedSigungu}
              onChange={e => setSelectedSigungu(e.target.value)}
              disabled={!selectedSido}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
            >
              <option value="">시·군·구 선택...</option>
              {sigunguList.map(sg => (
                <option key={sg} value={sg}>{sg}</option>
              ))}
            </select>
          </div>

          {/* 추가 버튼 */}
          <button
            onClick={handleAddFromDropdown}
            disabled={!previewRecord || comparison.length >= 3}
            className="px-4 py-2 bg-blue-500 text-white text-sm font-semibold rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-40 whitespace-nowrap self-end"
          >
            {comparison.length >= 3 ? '최대 3개' : '비교 추가'}
          </button>
        </div>

        {/* 미리보기 한 줄 */}
        {previewRecord && (
          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm flex items-center gap-3 flex-wrap">
            <span className="font-semibold text-blue-800">
              {previewRecord.sido} {previewRecord.sigungu}
            </span>
            <SystemBadge status={previewRecord.계통} />
            <span className="text-gray-600">이격 <IgeokText m={previewRecord.주거이격} /></span>
            <span className={previewRecord.농지설치 ? 'text-green-700' : 'text-red-600'}>
              농지 {previewRecord.농지설치 ? '허용' : '불허'}
            </span>
            {previewRecord.지붕보조금율 > 0 && (
              <span className="text-blue-700">보조금 {previewRecord.지붕보조금율}%</span>
            )}
          </div>
        )}
      </div>

      {/* ── 텍스트 검색 ─────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <label className="block text-xs font-semibold text-gray-500 mb-2">시·군·구 검색</label>
        <input
          type="text"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="예: 김제, 화성, 해남..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {searchResults.length > 0 && (
          <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden divide-y divide-gray-100">
            {searchResults.map(r => (
              <div
                key={`${r.sido}-${r.sigungu}`}
                className="flex items-center justify-between px-3 py-2 hover:bg-blue-50 cursor-pointer transition-colors"
                onClick={() => handleAddFromSearch(r)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{r.sido}</span>
                  <span className="font-medium text-gray-800">{r.sigungu}</span>
                  <SystemBadge status={r.계통} />
                </div>
                <button
                  disabled={comparison.length >= 3 || comparison.some(c => c.sido === r.sido && c.sigungu === r.sigungu)}
                  className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200 transition-colors disabled:opacity-40"
                >
                  {comparison.some(c => c.sido === r.sido && c.sigungu === r.sigungu) ? '추가됨' : '추가'}
                </button>
              </div>
            ))}
          </div>
        )}
        {searchText.trim().length > 0 && searchResults.length === 0 && (
          <div className="mt-2 text-sm text-gray-400 text-center py-3">검색 결과 없음</div>
        )}
      </div>

      {/* ── 비교 카드 (최대 3개) ─────────────────────────────────── */}
      {comparison.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-semibold text-gray-800">비교 중 ({comparison.length}/3)</h3>
            <button
              onClick={() => setComparison([])}
              className="text-xs px-2 py-0.5 bg-gray-100 border border-gray-200 text-gray-500 rounded-full hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-colors"
            >
              전체 지우기
            </button>
          </div>
          <div className="flex gap-3 flex-wrap">
            {comparison.map((record, idx) => (
              <CompareCard
                key={`${record.sido}-${record.sigungu}`}
                record={record}
                onRemove={() => handleRemoveComparison(idx)}
              />
            ))}
          </div>
        </div>
      )}

      {comparison.length === 0 && (
        <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-6 text-center text-sm text-gray-400">
          비교할 시·군·구를 1~3개 추가하세요
        </div>
      )}

      {/* ── 전체 목록 아코디언 테이블 ──────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
          onClick={() => setTableExpanded(v => !v)}
        >
          <div>
            <span className="font-semibold text-gray-800">전체 시·군·구 조례 목록</span>
            <span className="ml-2 text-xs text-gray-400">{ORDINANCE_RECORDS.length}개 지역</span>
          </div>
          <span className="text-gray-400 text-lg">{tableExpanded ? '▲' : '▼'}</span>
        </button>

        {tableExpanded && (
          <div className="overflow-x-auto border-t border-gray-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 whitespace-nowrap">시·도</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 whitespace-nowrap">시·군·구</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">주거이격</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">농지</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">소음</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">지붕보조금</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">계통</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600">비고</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 whitespace-nowrap">추가</th>
                </tr>
              </thead>
              <tbody>
                {ORDINANCE_RECORDS.map((r, i) => {
                  const inComparison = comparison.some(c => c.sido === r.sido && c.sigungu === r.sigungu)
                  return (
                    <tr
                      key={`${r.sido}-${r.sigungu}`}
                      className={`border-t border-gray-100 transition-colors ${inComparison ? 'bg-blue-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                    >
                      <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{r.sido}</td>
                      <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{r.sigungu}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <IgeokText m={r.주거이격} />
                      </td>
                      <td className={`px-3 py-2 text-center font-medium whitespace-nowrap ${r.농지설치 ? 'text-green-600' : 'text-red-500'}`}>
                        {r.농지설치 ? '허용' : '불허'}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-600 whitespace-nowrap">
                        {r.소음 === 0 ? '—' : `${r.소음}dB`}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.지붕보조금율 === 0 ? (
                          <span className="text-gray-400">—</span>
                        ) : (
                          <span className="text-blue-600 font-medium">{r.지붕보조금율}%</span>
                        )}
                        {r.지붕보조금한도kW > 0 && (
                          <span className="text-xs text-gray-400 ml-1">/{r.지붕보조금한도kW}kW</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <SystemBadge status={r.계통} />
                      </td>
                      <td className="px-3 py-2 text-gray-500 text-xs max-w-[200px] truncate" title={r.비고}>
                        {r.비고}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => inComparison ? handleRemoveComparison(comparison.findIndex(c => c.sido === r.sido && c.sigungu === r.sigungu)) : handleAddComparison(r)}
                          disabled={!inComparison && comparison.length >= 3}
                          className={`text-xs px-2 py-0.5 rounded-full border transition-colors disabled:opacity-30 ${inComparison ? 'bg-blue-100 text-blue-700 border-blue-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300' : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-blue-100 hover:text-blue-700 hover:border-blue-300'}`}
                        >
                          {inComparison ? '제거' : '추가'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 데이터 출처 안내 ────────────────────────────────────────── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-500 text-lg flex-shrink-0">ℹ️</span>
          <div className="text-xs text-amber-800 space-y-1">
            <div className="font-semibold">조례 데이터 안내</div>
            <div>
              이 데이터는 참고용 추정치입니다. 실제 인허가 전에 해당 시·군·구청 및{' '}
              <a
                href="https://www.law.go.kr/ordinSc.do?menuId=2&query=%ED%83%9C%EC%96%91%EA%B4%91"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-900"
              >
                법제처 법령정보센터
              </a>
              에서 최신 조례 원문을 반드시 확인하세요.
            </div>
            <div>계통 연계 가능 용량은 한전(☎ 123) 또는 <a href="https://home.kepco.co.kr" target="_blank" rel="noopener noreferrer" className="underline hover:text-amber-900">한전ON</a>에서 사전 확인 필수.</div>
          </div>
        </div>
      </div>
    </div>
  )
}
