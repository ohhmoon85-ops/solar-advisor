'use client'

// components/GabledConfigPanel.tsx — 박공(경사) 지붕 패널 배치 설정 UI
// MapTab에서 roofType==='박공' 일 때 노출. 부모 컴포넌트가 config 상태와 onChange를 관리.

import {
  GABLED_ROOF_LIMITS,
  type GabledRoofConfig,
  type GabledOrientationMode,
  type GabledRidgeAxisMode,
} from '@/lib/roofGabledConfig'

interface Props {
  config: GabledRoofConfig
  onChange: (next: GabledRoofConfig) => void
}

export default function GabledConfigPanel({ config, onChange }: Props) {
  const set = <K extends keyof GabledRoofConfig>(key: K, value: GabledRoofConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div className="mt-1.5 space-y-2 rounded-lg border border-orange-200 bg-orange-50/60 p-2.5">
      {/* 용마루 무시 */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={config.ridgeIgnore}
          onChange={e => set('ridgeIgnore', e.target.checked)}
          className="accent-orange-500"
        />
        <span className="text-xs text-gray-700">쫙 올림 (용마루 무시 · 직선 배치)</span>
      </label>

      {/* ridgeIgnore=true 시 나머지 박공 전용 입력은 비활성 */}
      <fieldset disabled={config.ridgeIgnore} className="space-y-2 disabled:opacity-50">
        {/* 용마루 갭 */}
        <SliderRow
          label="용마루 갭"
          value={config.ridgeGap}
          unit="m"
          min={GABLED_ROOF_LIMITS.ridgeGap.min}
          max={GABLED_ROOF_LIMITS.ridgeGap.max}
          step={GABLED_ROOF_LIMITS.ridgeGap.step}
          onChange={v => set('ridgeGap', v)}
        />
        {/* 같은 사면 행간 */}
        <SliderRow
          label="사면 내 행간"
          value={config.intraSlopeGap}
          unit="m"
          min={GABLED_ROOF_LIMITS.intraSlopeGap.min}
          max={GABLED_ROOF_LIMITS.intraSlopeGap.max}
          step={GABLED_ROOF_LIMITS.intraSlopeGap.step}
          onChange={v => set('intraSlopeGap', v)}
        />
        {/* 처마 이격 */}
        <SliderRow
          label="처마 이격"
          value={config.eaveSetback}
          unit="m"
          min={GABLED_ROOF_LIMITS.eaveSetback.min}
          max={GABLED_ROOF_LIMITS.eaveSetback.max}
          step={GABLED_ROOF_LIMITS.eaveSetback.step}
          onChange={v => set('eaveSetback', v)}
        />

        {/* 방위각 모드 */}
        <div>
          <label className="text-xs text-gray-500 font-medium">패널 방위각</label>
          <div className="flex gap-1.5 mt-1">
            {(['roof-direction', 'true-south'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => set('orientationMode', m as GabledOrientationMode)}
                className={`flex-1 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                  config.orientationMode === m
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-orange-300'
                }`}
              >
                {m === 'roof-direction' ? '지붕방향 (시공 ↑)' : '정남향 (일사량 ↑)'}
              </button>
            ))}
          </div>
        </div>

        {/* 용마루 축 모드 */}
        <div>
          <label className="text-xs text-gray-500 font-medium">용마루 축</label>
          <div className="flex gap-1.5 mt-1">
            {(['auto', 'manual'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => set('ridgeAxisMode', m as GabledRidgeAxisMode)}
                className={`flex-1 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                  config.ridgeAxisMode === m
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-orange-300'
                }`}
              >
                {m === 'auto' ? '자동 (장축)' : '수동 입력'}
              </button>
            ))}
          </div>
          {config.ridgeAxisMode === 'manual' && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={179}
                step={1}
                value={config.manualRidgeAxisDeg ?? 0}
                onChange={e => set('manualRidgeAxisDeg', Number(e.target.value))}
                className="w-20 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <span className="text-[11px] text-gray-500">° (0=동서, 90=남북)</span>
            </div>
          )}
        </div>

        {/* 비대칭 행수 (남/북 각각 처마부터 행 수 제한) */}
        <div>
          <label className="text-xs text-gray-500 font-medium">슬로프별 행 수 (비대칭)</label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <RowsInput
              label="남향"
              value={config.rowsSouth}
              onChange={v => set('rowsSouth', v)}
            />
            <RowsInput
              label="북향"
              value={config.rowsNorth}
              onChange={v => set('rowsNorth', v)}
            />
          </div>
          <div className="mt-1 text-[10px] text-gray-400">비워두면 자동(공간 허용 전부 채움). 각 슬로프는 처마부터 행 수 적용</div>
        </div>
      </fieldset>

      <div className="bg-orange-100/60 border border-orange-200 rounded-md p-1.5 text-[11px] text-orange-700">
        박공 기준: 60평 ≈ 30kW · 용마루 갭 {config.ridgeGap.toFixed(1)}m · 처마 {config.eaveSetback.toFixed(1)}m
      </div>
    </div>
  )
}

// ── 슬라이더 + 값 표시 행 ────────────────────────────────────────
interface SliderRowProps {
  label: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}

function SliderRow({ label, value, unit, min, max, step, onChange }: SliderRowProps) {
  return (
    <div>
      <div className="flex justify-between items-center">
        <label className="text-xs text-gray-500 font-medium">{label}</label>
        <span className="text-xs font-bold text-orange-700">
          {value.toFixed(step < 0.1 ? 2 : 1)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="mt-0.5 w-full accent-orange-500"
      />
    </div>
  )
}

// ── 슬로프별 행수 입력 (빈 값 = undefined = 자동) ──────────────────
interface RowsInputProps {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
}

function RowsInput({ label, value, onChange }: RowsInputProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-gray-600 w-8">{label}</span>
      <input
        type="number"
        min={1}
        max={20}
        step={1}
        placeholder="자동"
        value={value ?? ''}
        onChange={e => {
          const raw = e.target.value
          onChange(raw === '' ? undefined : Number(raw))
        }}
        className="flex-1 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
      />
      <span className="text-[11px] text-gray-400">행</span>
    </div>
  )
}
