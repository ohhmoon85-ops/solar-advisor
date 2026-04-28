'use client'

// AuctionFileDropzone — 경매 PDF/이미지에서 한국 지번 자동 추출
// PDF: pdfjs-dist (텍스트 레이어), 스캔 PDF는 tesseract.js로 폴백 가능
// 이미지(JPG/PNG): tesseract.js 한국어 OCR
// 매칭된 지번을 부모 컴포넌트로 전달 (최대 5개)

import { useState, useRef, useCallback, useEffect } from 'react'

// 한국 지번 패턴
//   [광역(선택)] [시/군/구] [읍/면(선택, 군 하위)] [동/리/읍/면/로/길] [번지]
//   예: "경상남도 진주시 사봉면 부계리 661" / "경기도 화성시 봉담읍 와우리 1120-2"
//       "서울특별시 강남구 역삼동 123-45" / "충청남도 천안시 동남구 신부동 100-1번지"
const JIBUN_PATTERN = /(?:[가-힣]{1,5}(?:특별시|광역시|특별자치시|특별자치도|도)\s+)?[가-힣]{1,6}(?:시|군|구)\s+(?:[가-힣]{1,6}(?:시|군|구)\s+)?(?:[가-힣]{1,6}(?:읍|면)\s+)?[가-힣]{1,8}(?:동|리|읍|면|로|길)\s*\d+(?:[-]\d+)?(?:번지|번길)?/g

const MAX_JIBUN = 5
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png'

interface Props {
  /** 추출 완료 시 호출 — 최대 5개 지번 문자열 배열 */
  onParsed: (jibuns: string[]) => void
  /** 자동 검색 트리거 (보너스) */
  onAutoSearch?: () => void
  /** 기본 접힘 여부 */
  defaultCollapsed?: boolean
}

interface ExtractStatus {
  phase: 'idle' | 'reading' | 'extracting' | 'matching' | 'done' | 'error'
  message?: string
  progress?: number
}

// ── PDF 텍스트 추출 ──────────────────────────────────────────────
async function extractPdfText(file: File, onProgress?: (p: number) => void): Promise<string> {
  // pdfjs-dist는 Worker 사용 — 동적 import로 SSR 회피
  const pdfjsLib = await import('pdfjs-dist')
  // Worker URL — Webpack/Turbopack ESM 표준 (asset emit + URL 변환)
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map(it => ('str' in it ? it.str : ''))
      .join(' ')
    fullText += pageText + '\n'
    onProgress?.(i / pdf.numPages)
  }
  return fullText
}

// ── 이미지 OCR ────────────────────────────────────────────────────
async function extractImageText(file: File, onProgress?: (p: number) => void): Promise<string> {
  const Tesseract = (await import('tesseract.js')).default
  const result = await Tesseract.recognize(file, 'kor+eng', {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress)
    },
  })
  return result.data.text ?? ''
}

// ── 지번 매칭 + 정규화 + 중복 제거 ────────────────────────────────
function extractJibuns(rawText: string): string[] {
  const matches = rawText.match(JIBUN_PATTERN) ?? []
  const cleaned = matches.map(s =>
    s
      .replace(/\s+/g, ' ')
      .replace(/번지\s*$/, '')
      .trim(),
  )
  // 중복 제거 (단순 문자열 기준)
  const uniq: string[] = []
  for (const j of cleaned) {
    if (!uniq.includes(j)) uniq.push(j)
    if (uniq.length >= MAX_JIBUN) break
  }
  return uniq
}

// ── 컴포넌트 ──────────────────────────────────────────────────────
export default function AuctionFileDropzone({
  onParsed,
  onAutoSearch,
  defaultCollapsed = false,
}: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [dragActive, setDragActive] = useState(false)
  const [status, setStatus] = useState<ExtractStatus>({ phase: 'idle' })
  const [extracted, setExtracted] = useState<string[]>([])
  const [editing, setEditing] = useState<string[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditing(extracted)
  }, [extracted])

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name)
    setExtracted([])
    setStatus({ phase: 'reading', message: '파일을 읽는 중...' })

    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      const isImg =
        /^image\/(jpeg|png)$/i.test(file.type) ||
        /\.(jpe?g|png)$/i.test(file.name)
      if (!isPdf && !isImg) {
        setStatus({
          phase: 'error',
          message: 'PDF, JPG, PNG 파일만 지원됩니다.',
        })
        return
      }

      setStatus({ phase: 'extracting', message: isPdf ? 'PDF 텍스트 추출 중...' : 'OCR 분석 중 (수십 초 소요)...', progress: 0 })

      const text = isPdf
        ? await extractPdfText(file, p => setStatus(s => ({ ...s, progress: p })))
        : await extractImageText(file, p => setStatus(s => ({ ...s, progress: p })))

      setStatus({ phase: 'matching', message: '지번 패턴 매칭 중...' })
      const jibuns = extractJibuns(text)

      if (jibuns.length === 0) {
        setStatus({
          phase: 'error',
          message: '지번을 찾지 못했습니다. 파일에 한국 지번 형식의 텍스트가 포함되어 있는지 확인하세요. (이미지는 해상도가 낮으면 OCR 정확도가 떨어집니다)',
        })
        return
      }

      setExtracted(jibuns)
      setStatus({
        phase: 'done',
        message: `${jibuns.length}개 지번을 찾았습니다.`,
      })
    } catch (err) {
      setStatus({
        phase: 'error',
        message: '파일 분석 실패: ' + (err instanceof Error ? err.message : String(err)),
      })
    }
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer.files?.[0]
      if (file) handleFile(file)
    },
    [handleFile],
  )

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFile(file)
      e.target.value = '' // 같은 파일 재선택 가능
    },
    [handleFile],
  )

  const handleApply = (autoSearch: boolean) => {
    const cleaned = editing.map(s => s.trim()).filter(Boolean)
    if (cleaned.length === 0) return
    onParsed(cleaned)
    if (autoSearch && onAutoSearch) onAutoSearch()
    setExtracted([])
    setEditing([])
    setFileName(null)
    setStatus({ phase: 'idle' })
  }

  // ── 토글 헤더 ──
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full text-left text-xs text-blue-600 hover:text-blue-700 hover:underline px-1 py-1"
      >
        📎 경매 파일에서 지번 자동 추출 (PDF/JPG/PNG)
      </button>
    )
  }

  // ── 메인 UI ──
  return (
    <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-2.5 mb-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-blue-700">📎 경매 파일 자동 추출</span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-[10px] text-gray-400 hover:text-gray-600"
          title="접기"
        >
          ─ 접기
        </button>
      </div>

      {/* 드롭존 */}
      <div
        onDragEnter={e => { e.preventDefault(); setDragActive(true) }}
        onDragOver={e => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={[
          'border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors',
          dragActive
            ? 'border-blue-500 bg-blue-100'
            : 'border-blue-300 bg-white hover:border-blue-400 hover:bg-blue-50',
          status.phase === 'extracting' || status.phase === 'reading' ? 'pointer-events-none opacity-70' : '',
        ].join(' ')}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          onChange={onChange}
          className="hidden"
        />
        <div className="text-xs text-gray-600">
          {status.phase === 'idle' && (
            <>
              <span className="text-base">📁</span> 경매 PDF/사진을 여기에 드롭하거나 클릭
              <div className="text-[10px] text-gray-400 mt-0.5">
                지번이 적힌 페이지를 자동으로 분석합니다
              </div>
            </>
          )}
          {(status.phase === 'reading' || status.phase === 'extracting' || status.phase === 'matching') && (
            <div className="space-y-1">
              <div className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-3.5 w-3.5 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                <span className="text-blue-700 font-medium">{status.message}</span>
              </div>
              {fileName && <div className="text-[10px] text-gray-500 truncate">{fileName}</div>}
              {status.progress !== undefined && (
                <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-1 bg-blue-500 rounded-full transition-all"
                    style={{ width: `${Math.round(status.progress * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {status.phase === 'done' && (
            <span className="text-green-700 font-medium">✓ {status.message}</span>
          )}
          {status.phase === 'error' && (
            <span className="text-red-600 text-[11px]">⚠ {status.message}</span>
          )}
        </div>
      </div>

      {/* 추출 결과 미리보기 + 편집 */}
      {extracted.length > 0 && (
        <div className="mt-2 space-y-1.5">
          <div className="text-[11px] text-gray-500">
            추출된 지번 (편집 후 적용 가능):
          </div>
          {editing.map((j, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <span className="text-[10px] text-gray-400 w-4">{i + 1}.</span>
              <input
                type="text"
                value={j}
                onChange={e => {
                  const next = [...editing]
                  next[i] = e.target.value
                  setEditing(next)
                }}
                className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs bg-white"
              />
              <button
                onClick={() => setEditing(editing.filter((_, idx) => idx !== i))}
                className="text-gray-400 hover:text-red-500 px-1 text-xs"
                title="제외"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex gap-1.5 pt-1">
            <button
              onClick={() => handleApply(false)}
              disabled={editing.filter(s => s.trim()).length === 0}
              className="flex-1 px-2.5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-semibold rounded"
            >
              지번 입력에 채우기
            </button>
            {onAutoSearch && (
              <button
                onClick={() => handleApply(true)}
                disabled={editing.filter(s => s.trim()).length === 0}
                className="px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-semibold rounded"
                title="채우고 바로 검색"
              >
                채우고 검색 →
              </button>
            )}
            <button
              onClick={() => {
                setExtracted([])
                setEditing([])
                setFileName(null)
                setStatus({ phase: 'idle' })
              }}
              className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs rounded"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
