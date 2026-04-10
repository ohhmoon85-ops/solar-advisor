'use client'

import { useState, useRef } from 'react'
import { PERMIT_STAGE1, PERMIT_STAGE2 } from '@/lib/staticData'

type InstallFilter = 'all' | 'building' | 'land'

export default function PermitTab() {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<InstallFilter>('all')
  const [pdfLoading, setPdfLoading] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)

  const allItems = [...PERMIT_STAGE1, ...PERMIT_STAGE2]

  const visibleStage1 = PERMIT_STAGE1.filter(item => {
    if (filter === 'building' && item.landOnly) return false
    if (filter === 'land' && item.buildingOnly) return false
    return true
  })

  const visibleStage2 = PERMIT_STAGE2.filter(item => {
    if (filter === 'building' && item.landOnly) return false
    if (filter === 'land' && item.buildingOnly) return false
    return true
  })

  const visibleAll = [...visibleStage1, ...visibleStage2]
  const checkedCount = visibleAll.filter(i => checked[i.id]).length
  const progress = visibleAll.length > 0 ? Math.round((checkedCount / visibleAll.length) * 100) : 0
  const requiredUnchecked = visibleAll.filter(i => i.required && !checked[i.id])

  const toggle = (id: string) => setChecked(prev => ({ ...prev, [id]: !prev[id] }))

  const handleSavePDF = async () => {
    const el = printRef.current
    if (!el) return
    setPdfLoading(true)
    try {
      const { jsPDF } = await import('jspdf')
      const { default: html2canvas } = await import('html2canvas')

      // html2canvas로 화면 캡처 (한글 폰트 그대로 렌더링)
      const canvas = await html2canvas(el, {
        scale: 2,           // 고해상도
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
      })

      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF('p', 'mm', 'a4')

      const pageW = pdf.internal.pageSize.getWidth()   // 210mm
      const pageH = pdf.internal.pageSize.getHeight()  // 297mm
      const margin = 8
      const printW = pageW - margin * 2
      const printH = (canvas.height / canvas.width) * printW

      // 여러 페이지로 분할
      let yRemain = printH
      let srcY = 0

      while (yRemain > 0) {
        const sliceH = Math.min(pageH - margin * 2, yRemain)
        const sliceCanvas = document.createElement('canvas')
        sliceCanvas.width = canvas.width
        sliceCanvas.height = (sliceH / printW) * canvas.width
        const ctx = sliceCanvas.getContext('2d')!
        ctx.drawImage(
          canvas,
          0, srcY,
          canvas.width, sliceCanvas.height,
          0, 0,
          canvas.width, sliceCanvas.height
        )
        pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', margin, margin, printW, sliceH)
        yRemain -= sliceH
        srcY += sliceCanvas.height
        if (yRemain > 0) pdf.addPage()
      }

      pdf.save('인허가_서류_체크리스트.pdf')
    } finally {
      setPdfLoading(false)
    }
  }

  const ItemRow = ({ item }: { item: typeof PERMIT_STAGE1[0] }) => {
    const isChecked = checked[item.id] ?? false
    const isRequired = item.required

    return (
      <div
        className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
          isChecked
            ? 'bg-green-50 border-green-200'
            : isRequired
            ? 'bg-white border-red-200'
            : 'bg-white border-gray-200 hover:border-gray-300'
        }`}
        onClick={() => toggle(item.id)}
      >
        <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
          isChecked ? 'bg-green-500 border-green-500' : isRequired ? 'border-red-400' : 'border-gray-400'
        }`}>
          {isChecked && <span className="text-white text-xs font-bold">✓</span>}
        </div>
        <div className="flex-1 min-w-0">
          <span className={`text-sm leading-relaxed ${isChecked ? 'line-through text-gray-400' : 'text-gray-800'}`}>
            {item.text}
          </span>
        </div>
        {isRequired && !isChecked && (
          <span className="flex-shrink-0 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-semibold">필수</span>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4" ref={printRef}>
      {/* Warning banner */}
      {requiredUnchecked.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-3">
          <span className="text-red-500 text-xl flex-shrink-0">⚠</span>
          <span className="text-sm font-semibold text-red-700">
            필수 항목 {requiredUnchecked.length}개 미완료
          </span>
        </div>
      )}

      {/* Header controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <span className="text-lg">📋</span> 인허가 서류 체크리스트
            </h3>
            <div className="text-sm text-gray-500 mt-0.5">
              {checkedCount}/{visibleAll.length}개 완료
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'all', label: '전체' },
              { key: 'building', label: '건물형' },
              { key: 'land', label: '토지형' },
            ].map(f => (
              <button key={f.key}
                onClick={() => setFilter(f.key as InstallFilter)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  filter === f.key ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              onClick={handleSavePDF}
              disabled={pdfLoading}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-60 flex items-center gap-1.5"
            >
              {pdfLoading ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  생성 중...
                </>
              ) : 'PDF 다운로드'}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>진행률</span>
            <span className="font-semibold text-blue-600">{progress}%</span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-green-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Stage 1 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-blue-800">단계 1: 발전사업허가 신청</h3>
            <div className="text-xs text-blue-600 mt-0.5">18종 서류 · 시·군·구청 접수</div>
          </div>
          <span className="text-sm font-bold text-blue-700">
            {visibleStage1.filter(i => checked[i.id]).length}/{visibleStage1.length}
          </span>
        </div>
        <div className="p-4 space-y-2">
          {visibleStage1.map(item => <ItemRow key={item.id} item={item} />)}
        </div>
      </div>

      {/* Stage 2 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-orange-50 border-b border-orange-100 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-orange-800">단계 2: 개발행위 · PPA · 사용전검사 · 에너지공단 등록</h3>
            <div className="text-xs text-orange-600 mt-0.5">사업 진행 단계별 서류</div>
          </div>
          <span className="text-sm font-bold text-orange-700">
            {visibleStage2.filter(i => checked[i.id]).length}/{visibleStage2.length}
          </span>
        </div>
        <div className="p-4 space-y-2">
          {visibleStage2.map(item => <ItemRow key={item.id} item={item} />)}
        </div>
      </div>

      {/* Key notes */}
      <div className="bg-yellow-50 rounded-xl border border-yellow-200 p-4">
        <h4 className="font-semibold text-yellow-800 mb-2 flex items-center gap-2">
          <span>💡</span> 주요 유의사항
        </h4>
        <ul className="space-y-1 text-sm text-yellow-700">
          <li>• 잔액증명서: 사업비 15% 이상 (100kW → 최소 1,500만원) — 거래은행 발급</li>
          <li>• PPA 신청서: 반드시 2024.06.10 이후 신양식 사용</li>
          <li>• 사용전검사: 한전 송전요청서 최소 1주일 전 제출</li>
          <li>• 에너지공단 REC 설비확인: 현장 방문 3~4주 소요</li>
          <li className="font-semibold text-red-700">• 사업개시 신고: 사용전검사 후 60일 이내 필수 (미신고 벌금 60만원)</li>
        </ul>
      </div>
    </div>
  )
}
