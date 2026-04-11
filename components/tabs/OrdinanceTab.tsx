'use client'

import { useState, useEffect } from 'react'
import { STATIC_ORDINANCE, OrdinanceData } from '@/lib/staticData'

const REGIONS = Object.keys(STATIC_ORDINANCE)
const LS_KEY = 'solar_ordinance_overrides'

function parseKoreanDate(d: string): Date {
  const s = d.replace(/-/g, '')
  return new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8))
}

function getSystemBadge(status: string) {
  if (status.includes('★★★')) return <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★★')) return <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status.includes('★')) return <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '포화') return <span className="bg-orange-400 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '보통') return <span className="bg-yellow-400 text-gray-800 text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  if (status === '여유') return <span className="bg-green-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">{status}</span>
  return <span className="text-xs text-gray-600">{status}</span>
}

export default function OrdinanceTab() {
  const [selectedRegion, setSelectedRegion] = useState<string>('')
  const [result, setResult] = useState<OrdinanceData | null>(null)
  const [loading, setLoading] = useState(false)
  const [apiDate, setApiDate] = useState<string | null>(null)
  const [revised, setRevised] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<OrdinanceData | null>(null)
  const [overrides, setOverrides] = useState<Record<string, OrdinanceData>>({})
  const [copied, setCopied] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [kvStatus, setKvStatus] = useState<'ok' | 'no-kv' | null>(null)

  // localStorage에서 수정된 데이터 로드
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) setOverrides(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  // 지역 데이터: localStorage 수정본 우선, 없으면 staticData
  const getRegionData = (region: string): OrdinanceData =>
    overrides[region] ?? STATIC_ORDINANCE[region]

  const handleSearch = async (region = selectedRegion) => {
    if (!region) return
    const data = getRegionData(region)
    setResult(data)
    setApiDate(null)
    setRevised(false)
    setEditing(false)
    setSaveMsg('')
    setLoading(true)
    try {
      const res = await fetch(`/api/ordinance?region=${encodeURIComponent(region)}`)
      if (res.ok) {
        const json = await res.json()
        const ordin = json?.OrdinSearch?.ordin
        if (ordin && ordin.length > 0) {
          const promulgated: string = ordin[0]?.['공포일자'] ?? ''
          setApiDate(promulgated)
          if (promulgated) {
            setRevised(parseKoreanDate(promulgated) > parseKoreanDate(data.lastUpdated))
          }
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const openEdit = () => {
    if (!result) return
    setEditForm({ ...result })
    setEditing(true)
    setSaveMsg('')
  }

  const handleEditChange = (field: keyof OrdinanceData, value: string) => {
    setEditForm(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const handleSave = async () => {
    if (!editForm || !selectedRegion) return
    const today = new Date().toISOString().slice(0, 10)
    const updated: OrdinanceData = { ...editForm, lastUpdated: today }
    // 1차: KV 백엔드 저장 시도
    try {
      const res = await fetch('/api/admin/ordinance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: selectedRegion, data: updated }),
      })
      const json = await res.json()
      if (res.ok) {
        setKvStatus('ok')
        setSaveMsg('KV 백엔드에 저장 완료! 모든 사용자에게 즉시 반영됩니다. (staticData.ts 영구 반영은 아래 코드 사용)')
      } else if (json.code === 'KV_NOT_CONFIGURED') {
        setKvStatus('no-kv')
        // KV 미설정: localStorage 폴백
        const newOverrides = { ...overrides, [selectedRegion]: updated }
        setOverrides(newOverrides)
        try { localStorage.setItem(LS_KEY, JSON.stringify(newOverrides)) } catch { /* ignore */ }
        setSaveMsg('⚠ KV 미설정 — 브라우저에만 임시 저장됨. Vercel KV 설정 후 영구 저장 가능.')
      } else {
        throw new Error(json.error)
      }
    } catch {
      // 네트워크 오류 등: localStorage 폴백
      const newOverrides = { ...overrides, [selectedRegion]: updated }
      setOverrides(newOverrides)
      try { localStorage.setItem(LS_KEY, JSON.stringify(newOverrides)) } catch { /* ignore */ }
      setSaveMsg('오류 발생 — 브라우저에만 임시 저장됨.')
    }
    const newOverrides = { ...overrides, [selectedRegion]: updated }
    setOverrides(newOverrides)
    setResult(updated)
    setRevised(false)
    setEditing(false)
  }

  const getCodeSnippet = (region: string, data: OrdinanceData) =>
    `  ${region}: { 주거이격: '${data.주거이격}', 농지설치: '${data.농지설치}', 소음: '${data.소음}', 지붕보조금: '${data.지붕보조금}', 계통: '${data.계통}', 비고: '${data.비고}', lastUpdated: '${data.lastUpdated}' },`

  const handleCopy = () => {
    if (!result || !selectedRegion) return
    const code = getCodeSnippet(selectedRegion, result)
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleResetOverride = () => {
    if (!selectedRegion) return
    const newOverrides = { ...overrides }
    delete newOverrides[selectedRegion]
    setOverrides(newOverrides)
    try { localStorage.setItem(LS_KEY, JSON.stringify(newOverrides)) } catch { /* ignore */ }
    setResult(STATIC_ORDINANCE[selectedRegion])
    setEditing(false)
    setSaveMsg('')
    setRevised(false)
  }

  const hasOverride = !!selectedRegion && !!overrides[selectedRegion]

  return (
    <div className="space-y-4">
      {/* 지역 선택 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <span className="text-lg">📜</span> 지자체 조례 조회
        </h3>
        <div className="flex gap-2">
          <select
            value={selectedRegion}
            onChange={e => setSelectedRegion(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">지역 선택...</option>
            {REGIONS.map(r => (
              <option key={r} value={r}>
                {r}{overrides[r] ? ' ✏️' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={() => handleSearch()}
            disabled={!selectedRegion || loading}
            className="px-4 py-2 bg-blue-500 text-white text-sm font-semibold rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {loading ? '조회 중...' : '조회'}
          </button>
        </div>
      </div>

      {/* 조회 결과 */}
      {result && !editing && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h3 className="font-semibold text-gray-800 text-lg">{selectedRegion} 태양광 조례 현황</h3>
            <div className="flex items-center gap-2 flex-wrap">
              {loading && <span className="text-xs text-gray-400 animate-pulse">API 조회 중...</span>}
              {!loading && !revised && apiDate && (
                <span className="flex items-center gap-1 bg-green-100 border border-green-300 text-green-700 text-xs px-3 py-1 rounded-full font-semibold">
                  ✓ 최신 (공포일 {apiDate})
                </span>
              )}
              {!loading && revised && (
                <span className="flex items-center gap-1 bg-red-100 border border-red-300 text-red-700 text-xs px-3 py-1 rounded-full font-semibold animate-pulse">
                  ⚠ 조례 개정됨
                </span>
              )}
              {hasOverride && (
                <span className="flex items-center gap-1 bg-purple-100 border border-purple-300 text-purple-700 text-xs px-2 py-1 rounded-full font-semibold">
                  ✏️ 수정됨
                </span>
              )}
              {kvStatus === 'ok' && hasOverride && (
                <span className="flex items-center gap-1 bg-green-100 border border-green-300 text-green-700 text-xs px-2 py-0.5 rounded-full">
                  ☁ KV
                </span>
              )}
              {kvStatus === 'no-kv' && (
                <span className="flex items-center gap-1 bg-gray-100 border border-gray-300 text-gray-500 text-xs px-2 py-0.5 rounded-full" title="Vercel KV 미설정 — 브라우저에만 저장됨">
                  ⚠ KV 미설정
                </span>
              )}
              <span className="text-xs text-gray-400">기준일: {result.lastUpdated}</span>
              <button onClick={openEdit}
                className="text-xs px-2 py-1 bg-gray-100 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors">
                수정
              </button>
              {hasOverride && (
                <button onClick={handleResetOverride}
                  className="text-xs px-2 py-1 bg-white border border-gray-300 text-gray-500 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-300 transition-colors">
                  원본 복원
                </button>
              )}
            </div>
          </div>

          {/* 조례 개정 경고 배너 */}
          {revised && (
            <div className="mb-4 bg-red-50 border border-red-300 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <span className="text-red-500 text-xl flex-shrink-0">⚠</span>
                <div className="flex-1">
                  <div className="font-semibold text-red-700">조례 개정 감지!</div>
                  <div className="text-sm text-red-600 mt-1">
                    법제처 API에서 공포일자 <strong>{apiDate}</strong>를 확인했습니다.
                    현재 데이터 기준일({result.lastUpdated})보다 새로운 조례가 있을 수 있습니다.
                  </div>
                  <div className="flex gap-2 mt-3 flex-wrap">
                    <button onClick={openEdit}
                      className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors">
                      지금 바로 수정하기
                    </button>
                    <a
                      href={`https://www.law.go.kr/ordinSc.do?menuId=2&query=${encodeURIComponent(selectedRegion + ' 태양광')}`}
                      target="_blank" rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-white border border-red-300 text-red-600 text-xs font-semibold rounded-lg hover:bg-red-50 transition-colors">
                      법제처에서 확인
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 저장 완료 메시지 + 코드 스니펫 */}
          {saveMsg && (
            <div className="mb-4 bg-green-50 border border-green-300 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-green-700">✓ {saveMsg}</span>
                <button onClick={handleCopy}
                  className={`text-xs px-3 py-1 rounded-lg font-semibold border transition-colors ${copied ? 'bg-green-500 text-white border-green-500' : 'bg-white border-green-400 text-green-700 hover:bg-green-100'}`}>
                  {copied ? '복사됨!' : '코드 복사'}
                </button>
              </div>
              <pre className="bg-gray-900 text-green-300 text-xs rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                {getCodeSnippet(selectedRegion, result)}
              </pre>
              <p className="text-xs text-green-600 mt-2">
                위 코드를 <code className="bg-green-100 px-1 rounded">lib/staticData.ts</code>의 STATIC_ORDINANCE 해당 지역 항목에 붙여넣고 git push하면 영구 반영됩니다.
              </p>
            </div>
          )}

          {/* 데이터 카드 그리드 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">주거 이격거리</div>
              <div className={`text-2xl font-bold ${result.주거이격 === '규정없음' ? 'text-green-600' : 'text-red-600'}`}>{result.주거이격}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wide">농지 설치</div>
              <div className={`text-2xl font-bold ${result.농지설치 === '허용' ? 'text-green-600' : 'text-red-600'}`}>{result.농지설치}</div>
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

          {result.계통.includes('포화') && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
              <span className="text-red-500 text-lg mt-0.5">⚠</span>
              <div>
                <div className="font-semibold text-red-700 text-sm">계통 포화 지역 주의</div>
                <div className="text-xs text-red-600 mt-1">발전사업허가 신청 전 한전(☎ 123) 또는 한전ON에서 계통 연계 가능 용량을 반드시 사전 확인하십시오.</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 인라인 수정 폼 */}
      {editing && editForm && (
        <div className="bg-white rounded-xl border-2 border-blue-400 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-blue-800 flex items-center gap-2">
              <span>✏️</span> {selectedRegion} 조례 데이터 수정
            </h3>
            <button onClick={() => setEditing(false)}
              className="text-xs px-2 py-1 bg-gray-100 border border-gray-300 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors">
              취소
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {([
              { field: '주거이격', label: '주거 이격거리', placeholder: '예: 100m, 규정없음' },
              { field: '농지설치', label: '농지 설치', placeholder: '예: 허용, 금지' },
              { field: '소음', label: '소음 기준', placeholder: '예: 45dB 이하' },
              { field: '지붕보조금', label: '지붕 보조금', placeholder: '예: 50만원/kW' },
              { field: '계통', label: '계통 상태', placeholder: '예: 여유, 보통, 포화' },
              { field: '비고', label: '비고', placeholder: '기타 특이사항' },
            ] as { field: keyof OrdinanceData; label: string; placeholder: string }[]).map(({ field, label, placeholder }) => (
              <div key={field}>
                <label className="block text-xs font-semibold text-gray-600 mb-1">{label}</label>
                <input
                  type="text"
                  value={editForm[field] ?? ''}
                  onChange={e => handleEditChange(field, e.target.value)}
                  placeholder={placeholder}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave}
              className="px-4 py-2 bg-blue-500 text-white text-sm font-semibold rounded-lg hover:bg-blue-600 transition-colors">
              저장 (브라우저 임시 저장)
            </button>
            <button onClick={() => setEditing(false)}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition-colors">
              취소
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            * 저장 시 이 브라우저에만 반영됩니다. 영구 반영은 저장 후 표시되는 코드를 staticData.ts에 붙여넣고 git push하세요.
          </p>
        </div>
      )}

      {/* 전국 조례 현황 요약 테이블 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">전국 조례 현황 요약</h3>
          <p className="text-xs text-gray-400 mt-0.5">행 클릭 시 상세 조회 · ✏️ 표시는 브라우저 수정본 적용 중</p>
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
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">기준일</th>
              </tr>
            </thead>
            <tbody>
              {REGIONS.map(region => {
                const d = getRegionData(region)
                const isOverridden = !!overrides[region]
                return (
                  <tr key={region}
                    className={`border-t border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors ${selectedRegion === region ? 'bg-blue-50' : ''} ${isOverridden ? 'ring-1 ring-inset ring-purple-200' : ''}`}
                    onClick={() => { setSelectedRegion(region); handleSearch(region) }}>
                    <td className="px-4 py-2.5 font-semibold text-gray-800">
                      {region}{isOverridden && <span className="ml-1 text-purple-500 text-xs">✏️</span>}
                    </td>
                    <td className={`px-4 py-2.5 text-center font-medium ${d.주거이격 === '규정없음' ? 'text-green-600' : 'text-red-600'}`}>{d.주거이격}</td>
                    <td className={`px-4 py-2.5 text-center font-medium ${d.농지설치 === '허용' ? 'text-green-600' : 'text-red-600'}`}>{d.농지설치}</td>
                    <td className="px-4 py-2.5 text-center text-gray-600">{d.소음}</td>
                    <td className="px-4 py-2.5 text-center text-blue-600 font-medium">{d.지붕보조금}</td>
                    <td className="px-4 py-2.5 text-center">{getSystemBadge(d.계통)}</td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs">{d.비고}</td>
                    <td className="px-4 py-2.5 text-center text-gray-400 text-xs">{d.lastUpdated}</td>
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
