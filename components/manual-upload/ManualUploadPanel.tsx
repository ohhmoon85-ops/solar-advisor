'use client'

// ManualUploadPanel — CAD 도면 직접 업로드 모드 (2026-05)
//
// 기존 자동 SVG 분석을 우회하고, 사용자가 CAD로 미리 그린 도면을 그대로
// 활용해 패널 수·발전 용량을 수동 입력. 수익성 계산 엔진에는 기존
// setMapResult 동일 시그니처로 전달 — 엔진 코드 변경 없음.
//
// 금지 사항: AI Vision API, 자동 패널 인식·카운트.
// 격리: 자동 분석 모드 코드와 완전 분리, 본 디렉토리 안에서만 동작.

import { useState, useRef, useCallback, useEffect } from 'react'

const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png'
const MAX_SIZE = 10 * 1024 * 1024            // 10MB
const DEFAULT_PANEL_W = 580                  // 단결정 580W — 검증 비교용 기본 출력
const MISMATCH_TOLERANCE = 0.10              // ±10% 초과 시 경고
// 패널 출력(W) 드롭다운 옵션 (2026-05) — 직접 입력 옵션은 'custom'
const PANEL_W_PRESETS = [580, 600, 620, 650, 680, 700, 710, 720] as const
const CUSTOM_W_MIN = 200
const CUSTOM_W_MAX = 800

export interface ManualUploadPayload {
  panelCount: number
  capacityKwp: number
  /** 사용자가 입력한 패널 종류 (예: "단결정 580W") — 선택 */
  panelType?: string
  tiltAngle: number
  azimuth: number
  /** 사용자가 입력한 지번 — 선택 (일사량 보정 후속 작업용 reservation) */
  jibun?: string
  /** 업로드한 도면의 dataURL — JPG/PNG 원본, PDF는 1페이지를 canvas로 렌더링한 PNG */
  drawingDataUrl?: string
}

interface Props {
  onSubmit: (payload: ManualUploadPayload) => void
  /** 좌측 패널 검색 시 입력된 주소 — 지번 입력 필드의 기본값 prefill */
  defaultJibun?: string
}

export default function ManualUploadPanel({ onSubmit, defaultJibun }: Props) {
  // ── 파일 상태 ──
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isPdf, setIsPdf] = useState(false)
  const [pdfRendering, setPdfRendering] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  // ── 폼 상태 ──
  const [panelCount, setPanelCount] = useState<string>('')
  const [capacityKw, setCapacityKw] = useState<string>('')
  // 패널 출력(W) — 드롭다운 선택값(숫자) 또는 'custom' (직접 입력 모드)
  const [panelWattSelect, setPanelWattSelect] = useState<number | 'custom'>(DEFAULT_PANEL_W)
  const [panelWattCustom, setPanelWattCustom] = useState<string>('')
  const [tiltAngle, setTiltAngle] = useState<number>(15)
  const [azimuth, setAzimuth] = useState<number>(180)
  const [jibun, setJibun] = useState<string>(defaultJibun ?? '')

  const [formError, setFormError] = useState<string | null>(null)
  const [mismatchConfirmed, setMismatchConfirmed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // defaultJibun이 나중에 도착해도 한 번은 prefill
  useEffect(() => {
    if (defaultJibun && !jibun) setJibun(defaultJibun)
  }, [defaultJibun]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── PDF 1페이지를 canvas에 렌더링 후 dataURL 추출 ──
  const renderPdfFirstPage = useCallback(async (f: File): Promise<string | null> => {
    setPdfRendering(true)
    try {
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
      const arrayBuffer = await f.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const page = await pdf.getPage(1)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = canvasRef.current
      if (!canvas) return null
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      await page.render({ canvasContext: ctx, viewport, canvas }).promise
      return canvas.toDataURL('image/png')
    } catch (e) {
      setFileError('PDF 렌더링 실패: ' + (e instanceof Error ? e.message : String(e)))
      return null
    } finally {
      setPdfRendering(false)
    }
  }, [])

  // ── 파일 선택·드롭 공통 핸들러 ──
  const handleFile = useCallback(async (f: File) => {
    setFileError(null)
    if (f.size > MAX_SIZE) {
      setFileError(`파일 크기 초과 (${(f.size / 1024 / 1024).toFixed(1)}MB > 10MB)`)
      return
    }
    const isAccepted = /\.(pdf|jpe?g|png)$/i.test(f.name) ||
      ['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)
    if (!isAccepted) {
      setFileError('지원 형식: JPG, PNG, PDF')
      return
    }
    setFile(f)

    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      setIsPdf(true)
      setPreviewUrl(null)
      // canvas가 DOM에 마운트된 후 렌더링하도록 다음 tick으로 미룸
      setTimeout(async () => {
        const dataUrl = await renderPdfFirstPage(f)
        if (dataUrl) setPreviewUrl(dataUrl)
      }, 0)
    } else {
      setIsPdf(false)
      const reader = new FileReader()
      reader.onload = () => setPreviewUrl(reader.result as string)
      reader.onerror = () => setFileError('파일 읽기 실패')
      reader.readAsDataURL(f)
    }
  }, [renderPdfFirstPage])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }, [handleFile])

  const resetFile = useCallback(() => {
    setFile(null)
    setPreviewUrl(null)
    setIsPdf(false)
    setFileError(null)
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  // ── 제출 ──
  const handleSubmit = useCallback(() => {
    setFormError(null)
    if (!file) {
      setFormError('도면을 먼저 업로드해 주세요')
      return
    }
    const pc = parseInt(panelCount, 10)
    const cap = parseFloat(capacityKw)
    if (!pc || pc <= 0) {
      setFormError('패널 수를 입력해 주세요 (1 이상의 정수)')
      return
    }
    if (!cap || cap <= 0) {
      setFormError('발전 용량을 입력해 주세요 (0보다 큰 값)')
      return
    }

    // 패널 출력 결정 — 드롭다운 또는 직접 입력 (범위 검증)
    let panelWatt: number = DEFAULT_PANEL_W
    if (panelWattSelect === 'custom') {
      const cw = parseFloat(panelWattCustom)
      if (!cw || cw < CUSTOM_W_MIN || cw > CUSTOM_W_MAX) {
        setFormError(`패널 출력은 ${CUSTOM_W_MIN}~${CUSTOM_W_MAX}W 범위의 숫자여야 합니다`)
        return
      }
      panelWatt = cw
    } else {
      panelWatt = panelWattSelect
    }

    // 패널 수 × 580W vs 발전 용량 ±10% 검증 (사용자 무시 가능)
    // 검증 기준 출력은 580W 그대로 유지 — 사용자 명시 요청 (이슈 2 미수정)
    const expectedKw = (pc * DEFAULT_PANEL_W) / 1000
    const diffRatio = Math.abs(cap - expectedKw) / expectedKw
    if (diffRatio > MISMATCH_TOLERANCE && !mismatchConfirmed) {
      setFormError(
        `⚠ 입력값을 다시 확인해 주세요. 패널 ${pc}장 × ${DEFAULT_PANEL_W}W ≈ ${expectedKw.toFixed(1)}kW 인데 발전 용량 ${cap}kW (오차 ${(diffRatio * 100).toFixed(1)}%). ` +
        '한 번 더 [수익성 분석 진행] 을 누르면 무시하고 진행합니다.'
      )
      setMismatchConfirmed(true)
      return
    }

    // panelType 문자열은 정규화된 W 값으로 생성 (예: "580W") — moduleIndex 매핑에 사용
    onSubmit({
      panelCount: pc,
      capacityKwp: cap,
      panelType: `${panelWatt}W`,
      tiltAngle,
      azimuth,
      jibun: jibun.trim() || undefined,
      drawingDataUrl: previewUrl ?? undefined,
    })
  }, [file, panelCount, capacityKw, panelWattSelect, panelWattCustom, tiltAngle, azimuth, jibun, previewUrl, mismatchConfirmed, onSubmit])

  // 패널 수·용량이 바뀌면 mismatch 확인을 초기화 (다시 경고 받음)
  useEffect(() => { setMismatchConfirmed(false) }, [panelCount, capacityKw])

  const canSubmit = !!file && !!panelCount && !!capacityKw && !pdfRendering

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* 좌측 60% — 도면 표시 */}
      <div className="lg:flex-[3] min-w-0">
        {!file ? (
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
              isDragging
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
            }`}
          >
            <div className="text-4xl mb-3">📂</div>
            <div className="text-sm font-medium text-gray-700">
              여기에 CAD 도면을 드래그&드롭
            </div>
            <div className="text-xs text-gray-500 mt-1">또는 클릭하여 파일 선택</div>
            <div className="text-[10px] text-gray-400 mt-3">
              JPG · PNG · PDF · 최대 10MB
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>
        ) : (
          <div className="relative border border-gray-300 rounded-lg overflow-hidden bg-white">
            <button
              onClick={resetFile}
              className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white border border-gray-300 hover:bg-gray-100 text-gray-700 text-sm font-bold shadow"
              aria-label="다시 업로드"
              title="다시 업로드"
            >
              ×
            </button>
            <div className="absolute bottom-2 left-2 z-10 text-[10px] text-gray-600 bg-white/85 border border-gray-200 rounded px-1.5 py-0.5">
              {file.name} · {(file.size / 1024).toFixed(0)}KB
            </div>
            {pdfRendering && (
              <div className="p-8 text-center text-sm text-gray-500">PDF 렌더링 중...</div>
            )}
            {previewUrl && !isPdf && (
              <img src={previewUrl} alt="업로드 도면" className="w-full h-auto" />
            )}
            {/* PDF용 canvas — renderPdfFirstPage가 항상 이 ref로 그림 */}
            <canvas
              ref={canvasRef}
              className={`w-full h-auto ${isPdf ? '' : 'hidden'}`}
            />
          </div>
        )}
        {fileError && (
          <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
            {fileError}
          </div>
        )}
      </div>

      {/* 우측 40% — 메타정보 폼 */}
      <div className="lg:flex-[2] min-w-0 space-y-3">
        <div className="text-xs font-semibold text-gray-700">📋 도면 정보 수동 입력</div>

        <FormField label="패널 수 (장)" required>
          <input
            type="number" min={1} step={1} inputMode="numeric"
            value={panelCount}
            onChange={e => setPanelCount(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="예: 200"
          />
        </FormField>

        <FormField label="발전 용량 (kW)" required>
          <input
            type="number" min={0.1} step={0.1} inputMode="decimal"
            value={capacityKw}
            onChange={e => setCapacityKw(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="예: 116.0"
          />
        </FormField>

        <FormField label="패널 출력 (W)">
          <select
            value={String(panelWattSelect)}
            onChange={e => {
              const v = e.target.value
              setPanelWattSelect(v === 'custom' ? 'custom' : Number(v))
            }}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {PANEL_W_PRESETS.map(w => (
              <option key={w} value={w}>{w}W</option>
            ))}
            <option value="custom">직접 입력</option>
          </select>
          {panelWattSelect === 'custom' && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="number"
                min={CUSTOM_W_MIN}
                max={CUSTOM_W_MAX}
                step={1}
                inputMode="numeric"
                value={panelWattCustom}
                onChange={e => setPanelWattCustom(e.target.value)}
                placeholder={`${CUSTOM_W_MIN}~${CUSTOM_W_MAX}`}
                className="w-24 text-sm border border-gray-300 rounded px-2 py-1.5 text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500">W (범위: {CUSTOM_W_MIN}~{CUSTOM_W_MAX})</span>
            </div>
          )}
        </FormField>

        <div className="grid grid-cols-2 gap-2">
          <FormField label="경사각 (°)">
            <input
              type="number" min={0} max={60} step={1}
              value={tiltAngle}
              onChange={e => setTiltAngle(Number(e.target.value))}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </FormField>
          <FormField label="방위각 (180=정남)">
            <input
              type="number" min={0} max={360} step={1}
              value={azimuth}
              onChange={e => setAzimuth(Number(e.target.value))}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </FormField>
        </div>

        <FormField label="지번 (일사량 보정용)">
          <input
            type="text"
            value={jibun}
            onChange={e => setJibun(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="예: 여주시 점동면 삼합리 산 36"
          />
        </FormField>

        {formError && (
          <div className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded p-2 leading-relaxed">
            {formError}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
            canSubmit
              ? 'bg-blue-500 text-white hover:bg-blue-600'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          수익성 분석 진행 →
        </button>

        <div className="text-[10px] text-gray-500 leading-relaxed pt-1 border-t border-gray-100">
          ⚠ 본 결과는 사용자가 수동 입력한 값을 기반으로 합니다.
          AI 자동 인식·계산 없음 — 실측 검증 권장.
        </div>
      </div>
    </div>
  )
}

function FormField({ label, required, children }: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="text-xs text-gray-600 font-medium block mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  )
}
