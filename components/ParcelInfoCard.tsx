'use client'

import { useState, useEffect } from 'react'
import { useSolarStore } from '@/store/useStore'
import { ADJACENCY_RULES, ADJACENCY_DISCLAIMER, getRiskLevel } from '@/lib/adjacencyRules'

export interface LandInfoData {
  pnu?: string
  jibun?: string
  jimok?: string
  zoneCode?: string
  zoneDetail?: string
  canInstall?: 'possible' | 'conditional' | 'impossible'
  restrictions?: string[]
  lon?: string | number
  lat?: string | number
}

interface Props {
  landInfo: LandInfoData
  smp?: number | null
  panelCount?: number
  capacityKwp?: number
  annualKwh?: number
}

const CI_CONFIG = {
  possible:    { label: '설치 가능',   bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-700', badge: 'bg-green-100 text-green-800' },
  conditional: { label: '조건부 가능', bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800' },
  impossible:  { label: '설치 불가',   bg: 'bg-red-50',   border: 'border-red-300',   text: 'text-red-700',   badge: 'bg-red-100 text-red-800' },
}

export default function ParcelInfoCard({ landInfo, smp, panelCount, capacityKwp, annualKwh }: Props) {
  const ci = CI_CONFIG[landInfo.canInstall ?? 'possible']
  const setActiveTab = useSolarStore(s => s.setActiveTab)
  const smpPrice = smp ?? 121.07
  const annualRevenue = annualKwh && annualKwh > 0
    ? Math.round(annualKwh * smpPrice / 10000)
    : null

  // ── 인접 시설 체크리스트 (자가 점검) ──
  // PNU가 바뀌면 자동 초기화 — 새 지번에 이전 체크가 남지 않도록
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [distances, setDistances] = useState<Record<string, number>>(() =>
    Object.fromEntries(ADJACENCY_RULES.map(r => [r.id, r.defaultDistance])),
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  useEffect(() => {
    setChecked({})
    setShowAdvanced(false)
    setDistances(Object.fromEntries(ADJACENCY_RULES.map(r => [r.id, r.defaultDistance])))
  }, [landInfo.pnu])

  const checkedCount = Object.values(checked).filter(Boolean).length
  const risk = getRiskLevel(checkedCount)

  const pnu = landInfo.pnu
  const toiEumUrl = pnu
    ? `https://www.eum.go.kr/web/ar/lu/luLandDtlInfo.jsp?pnu=${pnu}`
    : 'https://www.eum.go.kr'

  const hasZone = !!(landInfo.zoneDetail || landInfo.jimok)
  const hasStats = (panelCount && panelCount > 0) || (capacityKwp && capacityKwp > 0) || (annualRevenue !== null)

  return (
    <div className={`rounded-xl border-2 p-3 ${ci.bg} ${ci.border}`}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-xs font-semibold text-gray-700">토지 정보</span>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {checkedCount > 0 && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${risk.badge}`}
              title="인접 시설 체크 결과"
            >
              {risk.label}
            </span>
          )}
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ci.badge}`}>
            {ci.label}
          </span>
        </div>
      </div>

      {hasZone && (
        <div className="space-y-1 text-xs mb-2">
          {landInfo.zoneDetail && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-gray-400 flex-shrink-0 w-12">용도지역</span>
              <span className={`font-semibold ${ci.text}`}>{landInfo.zoneDetail}</span>
            </div>
          )}
          {landInfo.jimok && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-gray-400 flex-shrink-0 w-12">지목</span>
              <span className="font-medium text-gray-700">{landInfo.jimok}</span>
            </div>
          )}
        </div>
      )}

      {landInfo.restrictions && landInfo.restrictions.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {landInfo.restrictions.map((r, i) => (
            <div key={i} className="text-[10px] text-amber-700 flex items-start gap-1 bg-amber-100 rounded px-1.5 py-0.5">
              <span className="flex-shrink-0">⚠</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}

      {!hasZone && !landInfo.restrictions?.length && (
        <div className="text-[10px] text-gray-400 mb-2">토지 정보를 불러오는 중...</div>
      )}

      {hasStats && (
        <div className="mb-2 pt-2 border-t border-gray-200 grid grid-cols-3 gap-1 text-center">
          {panelCount && panelCount > 0 ? (
            <div>
              <div className="text-sm font-bold text-gray-800">{panelCount.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">패널 수</div>
            </div>
          ) : <div />}
          {capacityKwp && capacityKwp > 0 ? (
            <div>
              <div className="text-sm font-bold text-gray-800">{capacityKwp}</div>
              <div className="text-[10px] text-gray-500">kWp</div>
            </div>
          ) : <div />}
          {annualRevenue !== null ? (
            <div>
              <div className="text-sm font-bold text-blue-700">{annualRevenue.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">만원/년</div>
            </div>
          ) : <div />}
        </div>
      )}

      {hasStats && smp && (
        <div className="text-center text-[10px] text-gray-400 mb-2">
          SMP {smpPrice.toFixed(2)} 원/kWh 적용
        </div>
      )}

      {/* ── 인접 시설 체크 (자가 점검) ── */}
      <div className="mb-2 pt-2 border-t border-gray-200">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-gray-700">🚧 인접 시설 체크</span>
          <button
            onClick={() => setShowAdvanced(v => !v)}
            className="text-[10px] text-gray-400 hover:text-gray-600"
            title="거리 기준 직접 조정"
          >
            {showAdvanced ? '─ 접기' : '⚙ 조정'}
          </button>
        </div>
        <div className="space-y-1">
          {ADJACENCY_RULES.map(rule => {
            const isChecked = !!checked[rule.id]
            return (
              <div
                key={rule.id}
                className={[
                  'rounded px-2 py-1 transition-colors',
                  isChecked ? 'bg-amber-100' : 'bg-white/70',
                ].join(' ')}
                title={rule.reason}
              >
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={e =>
                      setChecked(prev => ({ ...prev, [rule.id]: e.target.checked }))
                    }
                    className="w-3.5 h-3.5 accent-amber-500 flex-shrink-0"
                  />
                  <span className="flex-shrink-0">{rule.icon}</span>
                  <span className="flex-1 text-[11px] text-gray-700">{rule.label}</span>
                  <span
                    className={[
                      'text-[10px] font-bold flex-shrink-0',
                      isChecked ? 'text-amber-700' : 'text-gray-500',
                    ].join(' ')}
                  >
                    {distances[rule.id]}m
                  </span>
                </label>
                {showAdvanced && (
                  <div className="flex items-center gap-1.5 mt-1 pl-5">
                    <input
                      type="range"
                      min={rule.minDistance}
                      max={rule.maxDistance}
                      step={5}
                      value={distances[rule.id]}
                      onChange={e =>
                        setDistances(prev => ({
                          ...prev,
                          [rule.id]: Number(e.target.value),
                        }))
                      }
                      className="flex-1 accent-amber-500"
                    />
                    <span className="text-[9px] text-gray-400 w-14 text-right">
                      {rule.minDistance}~{rule.maxDistance}m
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {checkedCount === 0 && (
          <div className="text-[10px] text-gray-400 mt-1.5 text-center">
            해당 시설 인접 시 체크하세요
          </div>
        )}
        <button
          onClick={() => setActiveTab('ordinance')}
          className="w-full mt-1.5 text-[10px] text-blue-600 hover:text-blue-700 hover:underline text-left"
        >
          자세히 검토 → 조례 비교 탭
        </button>
        <div className="text-[9px] text-gray-400 mt-1 leading-tight">
          ⓘ {ADJACENCY_DISCLAIMER}
        </div>
      </div>

      <div className="flex gap-1.5">
        <a
          href={toiEumUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-center py-1 text-[10px] font-semibold bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors"
        >
          🗺 토지이음
        </a>
        <a
          href="https://on.kepco.co.kr"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-center py-1 text-[10px] font-semibold bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors"
        >
          ⚡ 한전ON
        </a>
      </div>
    </div>
  )
}