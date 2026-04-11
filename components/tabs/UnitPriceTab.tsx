'use client'

import { useState, useEffect } from 'react'
import { useSolarStore } from '@/store/useStore'
import { SMP, REC_PRICE } from '@/lib/constants'
import { DEFAULT_POLICY_LOANS } from '@/lib/staticData'
import type { PolicyLoanRate } from '@/lib/staticData'

const LS_LOAN_KEY = 'solar_policy_loans'

// 분기 공시 일정 계산
function getNextQuarterAnnouncement(): string {
  const now = new Date()
  const m = now.getMonth() + 1 // 1-12
  let nextYear = now.getFullYear()
  let nextMonth: number
  if (m <= 3) nextMonth = 4
  else if (m <= 6) nextMonth = 7
  else if (m <= 9) nextMonth = 10
  else { nextMonth = 1; nextYear++ }
  return `${nextYear}년 ${nextMonth}월 초`
}

function getDaysSince(dateStr: string): number {
  if (!dateStr) return 0
  const ms = Date.now() - new Date(dateStr).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function fmt(n: number) { return n.toLocaleString() }

export default function UnitPriceTab() {
  const { priceOverride, setPriceOverride } = useSolarStore()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...priceOverride })
  const [copied, setCopied] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [alertDismissed, setAlertDismissed] = useState(false)
  const [smpFetching, setSmpFetching] = useState(false)
  const [smpFetchMsg, setSmpFetchMsg] = useState('')
  const [loans, setLoans] = useState<PolicyLoanRate[]>(DEFAULT_POLICY_LOANS)
  const [loanEditing, setLoanEditing] = useState<string | null>(null)
  const [loanForm, setLoanForm] = useState<PolicyLoanRate | null>(null)

  // 정책금리 localStorage 로드
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_LOAN_KEY)
      if (raw) setLoans(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  const saveLoanItem = (item: PolicyLoanRate) => {
    const next = loans.map(l => l.id === item.id ? item : l)
    setLoans(next)
    try { localStorage.setItem(LS_LOAN_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    setLoanEditing(null)
    setLoanForm(null)
  }

  const resetLoans = () => {
    setLoans(DEFAULT_POLICY_LOANS)
    try { localStorage.removeItem(LS_LOAN_KEY) } catch { /* ignore */ }
  }

  // 페이지 로드 시 localStorage에서 단가 초기화
  useEffect(() => {
    const raw = localStorage.getItem('solar_price_overrides')
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        setPriceOverride({ ...priceOverride, ...parsed })
      } catch { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const daysSince = getDaysSince(priceOverride.lastUpdated)
  const needsUpdate = daysSince > 90 && !alertDismissed

  const isDefaultSmp = priceOverride.smp === SMP
  const isDefaultRecBuilding = priceOverride.recBuilding === REC_PRICE.건물지붕형
  const isDefaultRecLand = priceOverride.recLand === REC_PRICE.일반토지형
  const isAllDefault = isDefaultSmp && isDefaultRecBuilding && isDefaultRecLand


  const fetchLatestSmp = async () => {
    setSmpFetching(true)
    setSmpFetchMsg('')
    try {
      const res = await fetch('/api/smp')
      const json = await res.json()
      if (res.status === 503) {
        setSmpFetchMsg('KPX_SMP_API_KEY 미설정. data.go.kr에서 한국전력거래소 SMP 서비스를 신청하고 환경변수를 추가하세요.')
        return
      }
      if (json.fallback || res.status !== 200) {
        setSmpFetchMsg('SMP 조회 실패: ' + (json.error ?? 'unknown'))
        return
      }
      // 조회 성공: 자동으로 단가 업데이트
      const today = new Date().toISOString().slice(0, 10)
      const updated = { ...priceOverride, smp: json.smp, lastUpdated: today }
      setPriceOverride(updated)
      setSmpFetchMsg('SMP 자동 업데이트 완료! ' + json.smp + '원/kWh (' + json.period + ' 기준, 출처: ' + json.source + ')')
      setAlertDismissed(true)
    } catch (err) {
      setSmpFetchMsg('네트워크 오류: ' + (err instanceof Error ? err.message : 'unknown'))
    } finally {
      setSmpFetching(false)
    }
  }

  const openEdit = () => {
    setForm({ ...priceOverride })
    setEditing(true)
    setSaveMsg('')
  }

  const handleSave = () => {
    const today = new Date().toISOString().slice(0, 10)
    const updated = { ...form, lastUpdated: today }
    setPriceOverride(updated)
    setEditing(false)
    setAlertDismissed(true)
    setSaveMsg(`저장 완료! (${today} 기준) 수익성 탭의 계산값이 즉시 반영됩니다.`)
  }

  const handleReset = () => {
    const reset = {
      smp: SMP,
      recBuilding: REC_PRICE.건물지붕형,
      recLand: REC_PRICE.일반토지형,
      lastUpdated: priceOverride.lastUpdated,
    }
    setPriceOverride(reset)
    setEditing(false)
    setSaveMsg('기본값으로 복원되었습니다.')
  }

  const getCodeSnippet = () => `// lib/constants.ts 에서 아래 값으로 교체하세요:
export const SMP = ${priceOverride.smp} // 원/kWh

export const REC_PRICE = {
  건물지붕형: ${priceOverride.recBuilding}, // 원/MWh
  일반토지형: ${priceOverride.recLand},
  영농형농지: ${priceOverride.recLand},
  임야형: ${priceOverride.recLand},
  수상형: ${priceOverride.recLand},
} as const`

  const handleCopy = () => {
    navigator.clipboard.writeText(getCodeSnippet()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="space-y-4">
      {/* 분기 갱신 경고 */}
      {needsUpdate && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-amber-500 text-2xl flex-shrink-0">⚠</span>
            <div className="flex-1">
              <div className="font-bold text-amber-800">분기 단가 갱신 시점 도달!</div>
              <div className="text-sm text-amber-700 mt-1">
                마지막 업데이트({priceOverride.lastUpdated})로부터 <strong>{daysSince}일</strong>이 경과했습니다.
                SMP는 분기(약 90일)마다 한전이 고시합니다. 최신 단가를 확인하여 반영해주세요.
              </div>
              <div className="text-xs text-amber-600 mt-1">다음 분기 공시 예정: {getNextQuarterAnnouncement()}</div>
              <div className="flex gap-2 mt-3 flex-wrap">
                <button onClick={openEdit}
                  className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition-colors">
                  지금 바로 수정하기
                </button>
                <a href="https://home.kepco.co.kr/kepco/main.do" target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-white border border-amber-400 text-amber-700 text-xs font-semibold rounded-lg hover:bg-amber-50 transition-colors">
                  한전 홈페이지 확인
                </a>
                <a href="https://www.epsis.co.kr" target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-white border border-amber-400 text-amber-700 text-xs font-semibold rounded-lg hover:bg-amber-50 transition-colors">
                  KPX 전력거래소
                </a>
                <button onClick={() => setAlertDismissed(true)}
                  className="px-3 py-1.5 bg-white border border-gray-300 text-gray-500 text-xs rounded-lg hover:bg-gray-50 transition-colors ml-auto">
                  이미 확인함
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {smpFetchMsg && (
        <div className={smpFetchMsg.includes('완료') ? "bg-green-50 border border-green-300 rounded-xl p-3 text-sm text-green-700" : "bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700"}>
          {smpFetchMsg}
        </div>
      )}

      {/* 현재 단가 현황 카드 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <span className="text-lg">💰</span> 현재 적용 단가
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              기준일: {priceOverride.lastUpdated}
              {isAllDefault && <span className="ml-2 text-blue-500">(기본값 사용 중)</span>}
              {!isAllDefault && <span className="ml-2 text-purple-500 font-semibold">✏️ 수정본 적용 중</span>}
            </p>
          </div>
          <div className="flex gap-2">
            {!isAllDefault && (
              <button onClick={handleReset}
                className="px-3 py-1.5 text-xs border border-gray-300 text-gray-500 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-300 transition-colors">
                기본값 복원
              </button>
            )}
            <button onClick={fetchLatestSmp} disabled={smpFetching}
              className="px-3 py-1.5 text-xs bg-emerald-500 text-white font-semibold rounded-lg hover:bg-emerald-600 transition-colors disabled:opacity-60">
              {smpFetching ? '조회 중...' : 'SMP 자동 조회'}
            </button>
            <button onClick={openEdit}
              className="px-3 py-1.5 text-xs bg-blue-500 text-white font-semibold rounded-lg hover:bg-blue-600 transition-colors">
              수동 수정
            </button>
          </div>
        </div>

        {/* SMP/REC 단가 테이블 (스크린샷 참조) */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead>
              <tr className="bg-slate-700 text-white">
                <th className="px-4 py-3 text-left font-semibold">구분</th>
                <th className="px-4 py-3 text-center font-semibold">100kW 미만</th>
                <th className="px-4 py-3 text-center font-semibold">100kW~1MW</th>
                <th className="px-4 py-3 text-center font-semibold">1MW 이상</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-gray-200 bg-green-50">
                <td className="px-4 py-3 font-semibold text-gray-800">SMP 적용</td>
                <td className="px-4 py-3 text-center">
                  <div className="text-xs text-gray-500 mb-0.5">한전 고시 SMP (분기 공시)</div>
                  <div className="font-bold text-green-700">
                    현재 참조값: <span className={`text-lg ${!isDefaultSmp ? 'text-purple-600' : ''}`}>{fmt(priceOverride.smp)}원/kWh</span>
                  </div>
                  {!isDefaultSmp && <div className="text-xs text-purple-500">* 수정됨 (기본: {SMP}원)</div>}
                </td>
                <td className="px-4 py-3 text-center text-gray-600 text-xs">한전 고시</td>
                <td className="px-4 py-3 text-center text-gray-600 text-xs">KPX 전력시장 정산<br/><span className="text-gray-400">(한국전력거래소)</span></td>
              </tr>
              <tr className="border-t border-gray-200">
                <td className="px-4 py-3 font-semibold text-gray-800">REC 단가<br /><span className="text-xs font-normal text-gray-500">(건물지붕형)</span></td>
                <td className="px-4 py-3 text-center">
                  <div className="text-xs text-gray-500 mb-0.5">에너지공단 현물시장 자동 조회</div>
                  <div className="font-bold text-blue-700">
                    <span className={`text-lg ${!isDefaultRecBuilding ? 'text-purple-600' : ''}`}>{fmt(priceOverride.recBuilding)}원/MWh</span>
                  </div>
                  {!isDefaultRecBuilding && <div className="text-xs text-purple-500">* 수정됨 (기본: {fmt(REC_PRICE.건물지붕형)}원)</div>}
                </td>
                <td className="px-4 py-3 text-center text-gray-500 text-xs">동일</td>
                <td className="px-4 py-3 text-center text-gray-500 text-xs">동일</td>
              </tr>
              <tr className="border-t border-gray-200 bg-gray-50">
                <td className="px-4 py-3 font-semibold text-gray-800">REC 단가<br /><span className="text-xs font-normal text-gray-500">(토지/기타형)</span></td>
                <td className="px-4 py-3 text-center">
                  <div className="text-xs text-gray-500 mb-0.5">에너지공단 현물시장 자동 조회</div>
                  <div className="font-bold text-orange-700">
                    <span className={`text-lg ${!isDefaultRecLand ? 'text-purple-600' : ''}`}>{fmt(priceOverride.recLand)}원/MWh</span>
                  </div>
                  {!isDefaultRecLand && <div className="text-xs text-purple-500">* 수정됨 (기본: {fmt(REC_PRICE.일반토지형)}원)</div>}
                </td>
                <td className="px-4 py-3 text-center text-gray-500 text-xs">동일</td>
                <td className="px-4 py-3 text-center text-gray-500 text-xs">동일</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-xs text-gray-400 space-y-0.5">
          <p>* SMP(계통한계가격): 분기별로 한전이 고시. 100kW 이상은 KPX 실시간 정산 방식.</p>
          <p>* REC: 신재생에너지공급인증서. 에너지공단 현물시장 낙찰가 기준. 가중치는 설치유형에 따라 0.7~1.6 적용.</p>
        </div>
      </div>

      {/* REC 가중치 참조표 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <span>📊</span> REC 가중치 참조표
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-3 py-2 text-left font-semibold text-gray-600">설치 유형</th>
                <th className="px-3 py-2 text-center font-semibold text-gray-600">가중치</th>
                <th className="px-3 py-2 text-center font-semibold text-gray-600">REC 적용 단가</th>
                <th className="px-3 py-2 text-center font-semibold text-gray-600">연간 REC 수익 (100kW 기준)</th>
              </tr>
            </thead>
            <tbody>
              {[
                { type: '수상형 (저수지·댐)', weight: 1.6, priceKey: 'land' },
                { type: '건물지붕형 / 공장·창고', weight: 1.5, priceKey: 'building' },
                { type: '일반토지형', weight: 1.2, priceKey: 'land' },
                { type: '영농형농지', weight: 1.2, priceKey: 'land' },
                { type: '임야형', weight: 0.7, priceKey: 'land' },
              ].map(row => {
                const unitPrice = row.priceKey === 'building' ? priceOverride.recBuilding : priceOverride.recLand
                const annualKwh = 100 * 3.5 * 365  // 100kW * 3.5h * 365일
                const recRevenue = Math.round((annualKwh / 1000) * unitPrice * row.weight / 10000)
                return (
                  <tr key={row.type} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-800">{row.type}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`font-bold text-base ${row.weight >= 1.5 ? 'text-green-600' : row.weight <= 0.7 ? 'text-red-500' : 'text-blue-600'}`}>
                        ×{row.weight}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-gray-600 text-xs">{fmt(unitPrice)}원/MWh</td>
                    <td className="px-3 py-2 text-center font-semibold text-blue-700">{fmt(recRevenue)}만원</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 인라인 수정 폼 */}
      {editing && (
        <div className="bg-white rounded-xl border-2 border-blue-400 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-blue-800 flex items-center gap-2">
              <span>✏️</span> 단가 수정
              <span className="text-xs font-normal text-blue-500">— 저장 즉시 수익성 탭 계산값에 반영됩니다</span>
            </h3>
            <button onClick={() => setEditing(false)}
              className="text-xs px-2 py-1 bg-gray-100 border border-gray-300 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors">
              취소
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                SMP (원/kWh)
                <span className="ml-1 text-gray-400 font-normal">기본: {SMP}원</span>
              </label>
              <input type="number" step="1" min="0"
                value={form.smp}
                onChange={e => setForm(f => ({ ...f, smp: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400 mt-1">한전 분기 고시값 (KPX → 한전ON에서 확인)</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                REC 건물지붕형 (원/MWh)
                <span className="ml-1 text-gray-400 font-normal">기본: {fmt(REC_PRICE.건물지붕형)}원</span>
              </label>
              <input type="number" step="1000" min="0"
                value={form.recBuilding}
                onChange={e => setForm(f => ({ ...f, recBuilding: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400 mt-1">에너지공단 현물시장 낙찰가 기준</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                REC 토지/영농/임야/수상형 (원/MWh)
                <span className="ml-1 text-gray-400 font-normal">기본: {fmt(REC_PRICE.일반토지형)}원</span>
              </label>
              <input type="number" step="1000" min="0"
                value={form.recLand}
                onChange={e => setForm(f => ({ ...f, recLand: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400 mt-1">에너지공단 현물시장 낙찰가 기준</p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={handleSave}
              className="px-4 py-2 bg-blue-500 text-white text-sm font-semibold rounded-lg hover:bg-blue-600 transition-colors">
              저장 및 즉시 반영
            </button>
            <button onClick={() => setEditing(false)}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition-colors">
              취소
            </button>
          </div>
        </div>
      )}

      {/* 저장 완료 + 코드 스니펫 */}
      {saveMsg && !editing && (
        <div className="bg-green-50 border border-green-300 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <span className="text-sm font-semibold text-green-700">✓ {saveMsg}</span>
            <button onClick={handleCopy}
              className={`text-xs px-3 py-1 rounded-lg font-semibold border transition-colors ${copied ? 'bg-green-500 text-white border-green-500' : 'bg-white border-green-400 text-green-700 hover:bg-green-100'}`}>
              {copied ? '복사됨!' : '코드 복사'}
            </button>
          </div>
          <pre className="bg-gray-900 text-green-300 text-xs rounded-lg p-3 overflow-x-auto">
            {getCodeSnippet()}
          </pre>
          <p className="text-xs text-green-600 mt-2">
            위 코드를 <code className="bg-green-100 px-1 rounded">lib/constants.ts</code>에 붙여넣고 git push하면 영구 반영됩니다.
            현재는 이 브라우저 세션에서만 반영됩니다.
          </p>
        </div>
      )}

      {/* 단가 확인처 안내 */}
      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
        <h4 className="font-semibold text-blue-800 mb-2 flex items-center gap-2">
          <span>📌</span> 단가 확인처 안내
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className="bg-white rounded-lg p-3 border border-blue-100">
            <div className="font-semibold text-gray-700 mb-1">SMP (계통한계가격)</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              <li>• 한전ON (home.kepco.co.kr) → 사업안내 → SMP 정보</li>
              <li>• KPX 전력거래소 (epsis.co.kr)</li>
              <li>• 분기별 공시: 1/4/7/10월 초</li>
              <li>• 소규모(100kW↓): 전년도 분기 평균 고정 적용</li>
            </ul>
          </div>
          <div className="bg-white rounded-lg p-3 border border-blue-100">
            <div className="font-semibold text-gray-700 mb-1">REC (신재생에너지공급인증서)</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              <li>• 에너지공단 RPS 포털 (kremc.or.kr)</li>
              <li>• 현물시장: 매월 낙찰, 수시 변동</li>
              <li>• 고정가격계약(FIT): 20년 확정 — 초기 계약 시 유리</li>
              <li>• 계약 전 현물시장 평균 3개월치 확인 권장</li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── 정책금리 섹션 ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-gray-800 flex items-center gap-2">
              <span>🏦</span> 태양광 정책금융 금리 현황
            </h4>
            <p className="text-xs text-gray-500 mt-0.5">매년 변경되는 정책금리를 수정할 수 있습니다. 한도 초과분은 일반 은행 대출 금리를 적용하세요.</p>
          </div>
          <button onClick={resetLoans} className="text-xs text-gray-400 hover:text-red-500 border border-gray-200 px-2 py-1 rounded">
            기본값 복원
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-600">
                <th className="text-left p-2 border border-gray-200">기관</th>
                <th className="text-left p-2 border border-gray-200">사업명</th>
                <th className="text-center p-2 border border-gray-200">금리</th>
                <th className="text-center p-2 border border-gray-200">융자비율</th>
                <th className="text-center p-2 border border-gray-200">한도(만원)</th>
                <th className="text-left p-2 border border-gray-200">대상</th>
                <th className="text-center p-2 border border-gray-200">기준연도</th>
                <th className="text-center p-2 border border-gray-200">수정</th>
              </tr>
            </thead>
            <tbody>
              {loans.map(loan => (
                loanEditing === loan.id && loanForm ? (
                  <tr key={loan.id} className="bg-blue-50">
                    <td className="p-1 border border-gray-200"><input className="w-full border rounded px-1 py-0.5 text-xs" value={loanForm.institution} onChange={e => setLoanForm({...loanForm, institution: e.target.value})} /></td>
                    <td className="p-1 border border-gray-200"><input className="w-full border rounded px-1 py-0.5 text-xs" value={loanForm.program} onChange={e => setLoanForm({...loanForm, program: e.target.value})} /></td>
                    <td className="p-1 border border-gray-200"><input type="number" step="0.1" className="w-16 border rounded px-1 py-0.5 text-xs text-center" value={loanForm.rate} onChange={e => setLoanForm({...loanForm, rate: parseFloat(e.target.value)})} /></td>
                    <td className="p-1 border border-gray-200"><input type="number" className="w-16 border rounded px-1 py-0.5 text-xs text-center" value={loanForm.limitRatio} onChange={e => setLoanForm({...loanForm, limitRatio: parseInt(e.target.value)})} /></td>
                    <td className="p-1 border border-gray-200"><input type="number" className="w-20 border rounded px-1 py-0.5 text-xs text-center" value={loanForm.limitAmountMan} onChange={e => setLoanForm({...loanForm, limitAmountMan: parseInt(e.target.value)})} /></td>
                    <td className="p-1 border border-gray-200"><input className="w-full border rounded px-1 py-0.5 text-xs" value={loanForm.target} onChange={e => setLoanForm({...loanForm, target: e.target.value})} /></td>
                    <td className="p-1 border border-gray-200"><input type="number" className="w-16 border rounded px-1 py-0.5 text-xs text-center" value={loanForm.year} onChange={e => setLoanForm({...loanForm, year: parseInt(e.target.value)})} /></td>
                    <td className="p-1 border border-gray-200 text-center">
                      <button onClick={() => saveLoanItem(loanForm)} className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded mr-1">저장</button>
                      <button onClick={() => { setLoanEditing(null); setLoanForm(null) }} className="text-xs bg-gray-200 px-2 py-0.5 rounded">취소</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={loan.id} className="hover:bg-gray-50">
                    <td className="p-2 border border-gray-200 font-medium text-gray-800">{loan.institution}</td>
                    <td className="p-2 border border-gray-200 text-gray-700">{loan.program}</td>
                    <td className="p-2 border border-gray-200 text-center font-bold text-blue-600">{loan.rate}%</td>
                    <td className="p-2 border border-gray-200 text-center text-gray-600">최대 {loan.limitRatio}%</td>
                    <td className="p-2 border border-gray-200 text-center text-gray-600">{loan.limitAmountMan === 0 ? '제한없음' : fmt(loan.limitAmountMan)}</td>
                    <td className="p-2 border border-gray-200 text-gray-600">{loan.target}</td>
                    <td className="p-2 border border-gray-200 text-center text-gray-500">{loan.year}년</td>
                    <td className="p-2 border border-gray-200 text-center">
                      <button onClick={() => { setLoanEditing(loan.id); setLoanForm({...loan}) }} className="text-xs text-blue-500 hover:underline">수정</button>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          <span className="font-semibold">💡 한도 초과분 안내:</span> 정책금융 한도를 초과하는 금액은 시중은행 일반대출(연 3.5~6%)을 별도 적용해야 합니다.
          수익성 탭에서 대출금리를 직접 입력할 수 있습니다.
        </div>
      </div>
    </div>
  )
}
