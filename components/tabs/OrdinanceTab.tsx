'use client'

import { useState } from 'react'
import { STATIC_ORDINANCE } from '@/lib/staticData'

const REGIONS = Object.keys(STATIC_ORDINANCE)

function getSystemBadge(status: string) {
  if (status.includes('★★★')) return <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★★')) return <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★')) return <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '포화') return <span className="bg-orange-400 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '보통') return <span className="bg-yellow-400 text-gray-800 text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '여유') return <span className="bg-green-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  return <span className="text-xs">{status}</span>
}

export default function OrdinanceTab() {
  const [selectedRegion, setSelectedRegion] = useState<string>('')
  const [result, setResult] = useState<typeof STATIC_ORDINANCE[string] | null>(null)
  const [loading, setLoading] = useState(false)
  const [apiResult, setApiResult] = useState<{ updated: boolean; date?: string } | null>(null)

  const handleSearch = async () => {
    if (!selectedRegion) return
    const data = STATIC_ORDINANCE[selectedRegion]
    setResult(data)

    // Try API in background
    setLoading(true)
    try {
      const res = await fetch(`/api/ordinance?region=${encodeURIComponent(selectedRegion)}`)
      if (res.ok) {
        const json = await res.json()
        const ordin = json?.OrdinSearch?.ordin
        if (ordin && ordin.length > 0) {
          setApiResult({ updated: true, date: ordin[0]?.공포일자 })
        }
      }
    } catch {
      // API not available, use static data
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <span className="text-lg">⚖️</span> 지역 조례 비교
          <span className="text-xs text-gray-400 font-normal ml-2">법제처 API + 정적 데이터 하이브리드</span>
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <select
            value={selectedRegion}
            onChange={e => setSelectedRegion(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">지역 선택</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button
            onClick={handleSearch}
            disabled={!selectedRegion}
            className="px-6 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg font-semibold text-sm transition-colors"
          >
            조회
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h3 className="font-semibold text-gray-800 text-lg">
              {selectedRegion} 태양광 조례 현황
            </h3>
            <div className="flex items-center gap-2">
              {loading && <span className="text-xs text-gray-400 animate-pulse">API 조회 중...</span>}
              {apiResult?.updated && (
                <button className="flex items-center gap-1 bg-orange-100 border border-orange-300 text-orange-700 text-xs px-3 py-1 rounded-full font-semibold hover:bg-orange-200 transition-colors">
                  <span>⚠</span> 최근 개정 ({apiResult.date}) — 법제처 원문 확인
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">주거 이격거리</div>
              <div className={`text-2xl font-bold ${result.주거이격 === '규정없음' ? 'text-green-600' : 'text-red-600'}`}>
                {result.주거이격}
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">농지 설치</div>
              <div className={`text-2xl font-bold ${result.농지설치 === '허용' ? 'text-green-600' : 'text-red-600'}`}>
                {result.농지설치}
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">소음 기준</div>
              <div className="text-2xl font-bold text-gray-800">{result.소음}</div>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">지붕 보조금</div>
              <div className="text-xl font-bold text-blue-600">{result.지붕보조금}</div>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">계통 상태</div>
              <div className="mt-1">{getSystemBadge(result.계통)}</div>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">비고</div>
              <div className="text-sm font-medium text-gray-700">{result.비고}</div>
            </div>
          </div>

          {/* Warning for saturated grid */}
          {result.계통.includes('포화') && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
              <span className="text-red-500 text-lg mt-0.5">⚠</span>
              <div>
                <div className="font-semibold text-red-700 text-sm">계통 포화 지역 주의</div>
                <div className="text-xs text-red-600 mt-1">
                  이 지역은 계통 포화 상태입니다. 발전사업허가 신청 전 한전(☎ 123) 또는 한전ON에서 계통 연계 가능 용량을 반드시 사전 확인하십시오.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* All regions table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">전국 조례 현황 요약</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-4 py-2.5 text-left font-semibold text-gray-600">지역</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">주거이격</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">농지설치</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">소음기준</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">지붕보조금</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">계통상태</th>
                <th className="px-4 py-2.5 text-left font-semibold text-gray-600">비고</th>
              </tr>
            </thead>
            <tbody>
              {REGIONS.map(region => {
                const d = STATIC_ORDINANCE[region]
                return (
                  <tr key={region}
                    className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer ${selectedRegion === region ? 'bg-blue-50' : ''}`}
                    onClick={() => { setSelectedRegion(region); setResult(d) }}
                  >
                    <td className="px-4 py-2.5 font-semibold text-gray-800">{region}</td>
                    <td className={`px-4 py-2.5 text-center font-medium ${d.주거이격 === '규정없음' ? 'text-green-600' : 'text-red-600'}`}>{d.주거이격}</td>
                    <td className={`px-4 py-2.5 text-center font-medium ${d.농지설치 === '허용' ? 'text-green-600' : 'text-red-600'}`}>{d.농지설치}</td>
                    <td className="px-4 py-2.5 text-center text-gray-600">{d.소음}</td>
                    <td className="px-4 py-2.5 text-center text-blue-600 font-medium">{d.지붕보조금}</td>
                    <td className="px-4 py-2.5 text-center">{getSystemBadge(d.계통)}</td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs">{d.비고}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
