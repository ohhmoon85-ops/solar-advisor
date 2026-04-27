'use client'

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
  const smpPrice = smp ?? 121.07
  const annualRevenue = annualKwh && annualKwh > 0
    ? Math.round(annualKwh * smpPrice / 10000)
    : null

  const pnu = landInfo.pnu
  const toiEumUrl = pnu
    ? `https://www.eum.go.kr/web/ar/lu/luLandDtlInfo.jsp?pnu=${pnu}`
    : 'https://www.eum.go.kr'

  const hasZone = !!(landInfo.zoneDetail || landInfo.jimok)
  const hasStats = (panelCount && panelCount > 0) || (capacityKwp && capacityKwp > 0) || (annualRevenue !== null)

  return (
    <div className={`rounded-xl border-2 p-3 ${ci.bg} ${ci.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700">토지 정보</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ci.badge}`}>
          {ci.label}
        </span>
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