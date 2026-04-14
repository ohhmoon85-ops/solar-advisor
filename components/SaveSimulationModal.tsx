'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSolarStore } from '@/store/useStore'
import {
  saveSimulation,
  isLocalStorageAvailable,
  type SimulationRecord,
} from '@/lib/simulationHistory'
import { PRESET_PANELS } from '@/lib/panelConfig'
import { getRegionByLatitude } from '@/lib/shadowCalculator'
import { isMultiZoneResult } from '@/lib/multiZoneLayout'
import type { FullAnalysisResult } from '@/lib/layoutEngine'
import type { MultiZoneResult } from '@/lib/multiZoneLayout'

const QUICK_MEMOS = ['계약 완료', '재상담 예정', '견적 발송', '보류', '참고용']
const AUTO_SAVE_KEY = 'solarAdvisor_autoSave'

function getAutoSave(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(AUTO_SAVE_KEY) === 'true'
}

interface Props {
  /** 저장 완료 콜백 */
  onSaved?: (record: SimulationRecord) => void
}

export default function SaveSimulationModal({ onSaved }: Props) {
  const {
    showSaveModal, setShowSaveModal,
    mapResult,
    lastFullAnalysisJson,
    installationType, totalCost,
    locationCoords,
    setHistoryCount,
  } = useSolarStore()

  const [clientName, setClientName] = useState('')
  const [clientMemo, setClientMemo] = useState('')
  const [memoColor, setMemoColor] = useState<SimulationRecord['memoColor']>('default')
  const [autoSave, setAutoSave] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [storageAvailable] = useState(() => isLocalStorageAvailable())

  // 자동 저장 설정 로드
  useEffect(() => {
    setAutoSave(getAutoSave())
  }, [])

  // 자동 저장 모드: 모달 없이 바로 저장
  const doSave = useCallback(async (name: string, memo: string, color: SimulationRecord['memoColor']) => {
    if (!mapResult) return
    setSaving(true)
    setError('')

    try {
      const analysis = lastFullAnalysisJson
        ? JSON.parse(lastFullAnalysisJson) as FullAnalysisResult | MultiZoneResult
        : null

      // 배치 결과 추출
      let totalPanels = mapResult.panelCount
      let totalKwp = mapResult.capacityKwp
      let rowSpacing = 0
      let utilizationRate = 0
      let tiltAngle = mapResult.tiltAngle
      let panelId = 'UNKNOWN'
      let panelLabel = `모듈 #${mapResult.moduleIndex}`
      let zoneCount = 1
      let plotAreaM2 = mapResult.area
      let plotType: SimulationRecord['plotType'] = 'land'

      if (analysis) {
        if (isMultiZoneResult(analysis)) {
          const mz = analysis as MultiZoneResult
          totalPanels = mz.totalCount
          totalKwp = mz.totalKwp
          rowSpacing = mz.zones[0]?.rowSpacing ?? 0
          tiltAngle = mz.zones[0]?.optimalTilt ?? tiltAngle
          utilizationRate = mz.totalUtilizationRate
          zoneCount = mz.zones.length
          plotAreaM2 = mz.totalAreaM2
          plotType = mz.zones[0]?.safeZone.plotType ?? 'land'
          panelId = mz.zones[0]?.panelType ?? panelId
        } else {
          const fa = analysis as FullAnalysisResult
          totalPanels = fa.layout.totalCount
          totalKwp = fa.layout.totalKwp
          rowSpacing = fa.rowSpacing
          utilizationRate = fa.safeZone.originalAreaM2 > 0
            ? fa.safeZone.safeAreaM2 / fa.safeZone.originalAreaM2
            : 0
          tiltAngle = fa.optimalTilt
          plotAreaM2 = fa.safeZone.originalAreaM2
          plotType = fa.safeZone.plotType
          panelId = fa.panelType
          zoneCount = 1
        }
        const spec = PRESET_PANELS[panelId]
        if (spec) panelLabel = spec.label
      }

      const lat = locationCoords?.lat ?? 37.5
      const region = getRegionByLatitude(lat)

      // 간략 ROI 계산
      const totalCostKrw = totalCost * 10000
      const annualKwh = mapResult.annualKwh
      // 단순 연간 수익: 건물지붕형 ~130원/kWh, 나머지 ~110원/kWh 기준
      const pricePerKwh = installationType === '건물지붕형' ? 130 : 110
      const annualRevenueKrw = annualKwh * pricePerKwh
      const paybackYears = annualRevenueKrw > 0
        ? Math.round((totalCostKrw / annualRevenueKrw) * 10) / 10
        : -1
      const roi20yr = totalCostKrw > 0
        ? Math.round(((annualRevenueKrw * 20 - totalCostKrw) / totalCostKrw) * 1000) / 10
        : 0
      const lcoe = annualKwh > 0
        ? Math.round((totalCostKrw / (annualKwh * 20)) * 10) / 10
        : 0

      const record = saveSimulation({
        clientName: name || undefined,
        clientMemo: memo || undefined,
        memoColor: color,
        address: mapResult.address,
        latitude: lat,
        region,
        plotAreaM2,
        plotType,
        jimokLabel: undefined,
        isJimokChangePlanned: false,
        hasRiverBoundary: false,
        hasRoadBoundary: false,
        panelId,
        panelLabel,
        azimuthDeg: 180,
        tiltAngle,
        rowSpacing,
        totalPanels,
        totalKwp,
        utilizationRate,
        layoutMode: 'balanced',
        isManuallyEdited: false,
        zoneCount,
        totalCostKrw,
        annualKwh,
        annualRevenueKrw,
        paybackYears,
        roi20yr,
        lcoe,
        fullAnalysisSnapshot: lastFullAnalysisJson ?? '',
      })

      // 이력 건수 갱신
      const { getAllSimulations } = await import('@/lib/simulationHistory')
      setHistoryCount(getAllSimulations().length)

      onSaved?.(record)
      setShowSaveModal(false)
      setClientName('')
      setClientMemo('')
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'QUOTA_EXCEEDED') {
        setError('저장 공간이 부족합니다. JSON 내보내기 후 오래된 이력을 삭제해주세요.')
      } else if (e instanceof Error && e.message === 'STORAGE_UNAVAILABLE') {
        setError('이 브라우저에서는 이력 저장이 지원되지 않습니다.')
      } else {
        setError('저장 중 오류가 발생했습니다.')
      }
    } finally {
      setSaving(false)
    }
  }, [mapResult, lastFullAnalysisJson, installationType, totalCost, locationCoords, setHistoryCount, onSaved, setShowSaveModal])

  // 자동 저장 모드에서 모달이 열리면 즉시 저장
  useEffect(() => {
    if (showSaveModal && autoSave) {
      doSave('', '', 'default')
    }
  }, [showSaveModal, autoSave, doSave])

  if (!showSaveModal) return null
  if (autoSave) return null  // 자동 저장 중엔 모달 없이 처리

  if (!storageAvailable) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
          <div className="text-amber-500 text-3xl mb-3 text-center">⚠</div>
          <p className="text-center text-gray-700 text-sm mb-4">이 브라우저에서는 이력 저장이 지원되지 않습니다.<br/>(시크릿 모드 또는 저장소 차단 상태)</p>
          <button onClick={() => setShowSaveModal(false)} className="w-full py-2 bg-gray-100 rounded-xl text-sm font-medium hover:bg-gray-200">닫기</button>
        </div>
      </div>
    )
  }

  const panels = mapResult?.panelCount ?? 0
  const kwp = mapResult?.capacityKwp ?? 0
  const annualKwh = mapResult?.annualKwh ?? 0
  const pricePerKwh = installationType === '건물지붕형' ? 130 : 110
  const annualRevenueKrw = annualKwh * pricePerKwh
  const paybackYears = annualRevenueKrw > 0
    ? ((totalCost * 10000) / annualRevenueKrw).toFixed(1)
    : '-'
  const roi20yr = (totalCost * 10000) > 0
    ? (((annualRevenueKrw * 20 - totalCost * 10000) / (totalCost * 10000)) * 100).toFixed(1)
    : '0'

  const MEMO_COLOR_OPTIONS: { value: SimulationRecord['memoColor']; label: string; cls: string }[] = [
    { value: 'default', label: '기본', cls: 'bg-gray-200 text-gray-700' },
    { value: 'green', label: '계약', cls: 'bg-green-100 text-green-700' },
    { value: 'blue', label: '재상담', cls: 'bg-blue-100 text-blue-700' },
    { value: 'gray', label: '보류', cls: 'bg-gray-100 text-gray-500' },
  ]

  return (
    <>
      <style>{`
        @keyframes modal-slide-up {
          from { opacity: 0; transform: translateY(24px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
        .save-modal { animation: modal-slide-up 0.3s cubic-bezier(.22,.68,0,1.2) forwards; }
      `}</style>

      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
        onClick={() => setShowSaveModal(false)}
      >
        <div
          className="save-modal w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* 상단 그라디언트 바 */}
          <div className="h-1 w-full bg-gradient-to-r from-blue-500 to-indigo-500" />

          <div className="p-5">
            {/* 헤더 */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-gray-900">시뮬레이션 저장</h2>
                <p className="text-xs text-gray-400 mt-0.5">{mapResult?.address ?? '주소 없음'}</p>
              </div>
              <button
                onClick={() => setShowSaveModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            {/* 요약 수치 (읽기 전용) */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[
                { label: '설치 장수', value: `${panels.toLocaleString()}장` },
                { label: '설비 용량', value: `${kwp.toFixed(1)} kWp` },
                { label: '투자 회수', value: `${paybackYears}년` },
                { label: '20년 ROI', value: `${roi20yr}%` },
              ].map(item => (
                <div key={item.label} className="text-center bg-gray-50 rounded-xl py-2">
                  <div className="text-[10px] text-gray-400 font-medium leading-tight">{item.label}</div>
                  <div className="text-xs font-bold text-gray-800 mt-0.5">{item.value}</div>
                </div>
              ))}
            </div>

            {/* 수요자 이름 */}
            <div className="mb-3">
              <label className="text-xs font-medium text-gray-600 mb-1 block">수요자 이름 (선택)</label>
              <input
                type="text"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                placeholder="예: 홍길동"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>

            {/* 메모 */}
            <div className="mb-3">
              <label className="text-xs font-medium text-gray-600 mb-1 block">메모 (선택)</label>
              {/* 빠른 선택 */}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {QUICK_MEMOS.map(m => (
                  <button
                    key={m}
                    onClick={() => setClientMemo(m)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                      clientMemo === m
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-gray-50 text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={clientMemo}
                onChange={e => setClientMemo(e.target.value)}
                placeholder="직접 입력..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>

            {/* 카드 색상 */}
            <div className="mb-4">
              <label className="text-xs font-medium text-gray-600 mb-1.5 block">카드 색상</label>
              <div className="flex gap-2">
                {MEMO_COLOR_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setMemoColor(opt.value)}
                    className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border-2 transition-all ${opt.cls} ${
                      memoColor === opt.value ? 'border-blue-400 ring-1 ring-blue-300' : 'border-transparent'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 에러 */}
            {error && (
              <div className="mb-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">⚠ {error}</div>
            )}

            {/* 버튼 */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => doSave(clientName, clientMemo, memoColor)}
                disabled={saving}
                className="flex-1 py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60"
              >
                {saving ? '저장 중...' : '💾 저장하기'}
              </button>
              <button
                onClick={() => setShowSaveModal(false)}
                className="flex-none px-4 py-2.5 bg-gray-100 text-gray-600 text-sm rounded-xl hover:bg-gray-200 transition-colors"
              >
                나중에
              </button>
            </div>

            {/* 자동 저장 옵션 */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoSave}
                onChange={e => {
                  setAutoSave(e.target.checked)
                  try { localStorage.setItem(AUTO_SAVE_KEY, String(e.target.checked)) } catch { /* ignore */ }
                }}
                className="w-4 h-4 rounded accent-blue-500"
              />
              <span className="text-xs text-gray-400">매번 묻지 않고 자동으로 저장</span>
            </label>
          </div>
        </div>
      </div>
    </>
  )
}
