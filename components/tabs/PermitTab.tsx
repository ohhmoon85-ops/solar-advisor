'use client'

import { useState } from 'react'
import { PERMIT_STAGE1, PERMIT_STAGE2 } from '@/lib/staticData'

type InstallFilter = 'all' | 'building' | 'land'

export default function PermitTab() {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<InstallFilter>('all')
  const [pdfLoading, setPdfLoading] = useState(false)

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

  // window.print() 방식: html2canvas 대체 — 모든 환경에서 안정적, 한글 완벽 지원
  const handleSavePDF = () => {
    setPdfLoading(true)
    try {
      const filterLabel =
        filter === 'building' ? '건물형' : filter === 'land' ? '토지형' : '전체'
      const today = new Date().toLocaleDateString('ko-KR')

      const makeRow = (item: typeof PERMIT_STAGE1[0]) => {
        const done = !!checked[item.id]
        const reqBadge = item.required
          ? '<span style="background:#fee2e2;color:#dc2626;padding:2px 6px;border-radius:4px;font-weight:600">필수</span>'
          : ''
        const color = done ? '#9ca3af' : '#111827'
        const deco = done ? 'line-through' : 'none'
        const chk = done ? '&#9745;' : '&#9744;'
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;color:${color};text-decoration:${deco}">${chk} ${item.text}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:11px">${reqBadge}</td>
        </tr>`
      }

      const s1rows = visibleStage1.map(makeRow).join('')
      const s2rows = visibleStage2.map(makeRow).join('')
      const barW = progress + '%'

      const html = [
        '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">',
        '<title>인허가 서류 체크리스트</title><style>',
        '*{box-sizing:border-box;margin:0;padding:0}',
        "body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;padding:20px;color:#111827}",
        'h1{font-size:18px;font-weight:700;margin-bottom:4px}',
        '.meta{font-size:12px;color:#6b7280;margin-bottom:12px}',
        '.bar{background:#e5e7eb;height:8px;border-radius:4px;margin-bottom:20px}',
        '.fill{background:linear-gradient(to right,#3b82f6,#22c55e);height:8px;border-radius:4px;width:' + barW + '}',
        'h2{font-size:14px;font-weight:700;padding:8px 12px}',
        '.s1{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;border-radius:8px 8px 0 0}',
        '.s2{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:8px 8px 0 0}',
        'table{width:100%;border-collapse:collapse;margin-bottom:20px;border:1px solid #e5e7eb;border-top:none}',
        '.notes{background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:12px;font-size:12px}',
        '.notes h3{font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px}',
        '.notes li{color:#78350f;margin-bottom:4px;margin-left:16px}',
        '.warn{color:#dc2626;font-weight:600}',
        '@media print{body{padding:10px}}',
        '</style></head><body>',
        '<h1>&#128203; 인허가 서류 체크리스트</h1>',
        '<div class="meta">출력일: ' + today + ' | 필터: ' + filterLabel + ' | 진행률: ' + checkedCount + '/' + visibleAll.length + '개 (' + progress + '%)</div>',
        '<div class="bar"><div class="fill"></div></div>',
        '<h2 class="s1">단계 1: 발전사업허가 신청 — 시·군·구청 접수</h2>',
        '<table><tbody>' + s1rows + '</tbody></table>',
        '<h2 class="s2">단계 2: 개발행위 · PPA · 사용전검사 · 에너지공단 등록</h2>',
        '<table><tbody>' + s2rows + '</tbody></table>',
        '<div class="notes"><h3>&#128161; 주요 유의사항</h3><ul>',
        '<li>잔액증명서: 사업비 15% 이상 (100kW → 최소 1,500만원) — 거래은행 발급</li>',
        '<li>PPA 신청서: 반드시 2024.06.10 이후 신양식 사용</li>',
        '<li>사용전검사: 한전 송전요청서 최소 1주일 전 제출</li>',
        '<li>에너지공단 REC 설비확인: 현장 방문 3~4주 소요</li>',
        '<li class="warn">사업개시 신고: 사용전검사 후 60일 이내 필수 (미신고 벌금 60만원)</li>',
        '</ul></div></body></html>',
      ].join('')

      const win = window.open('', '_blank', 'width=820,height=920')
      if (!win) {
        alert('팝업이 차단되었습니다. 브라우저 주소창 우측 팝업 허용 클릭 후 다시 시도해주세요.')
        return
      }
      win.document.write(html)
      win.document.close()
      win.focus()
      setTimeout(() => { win.print() }, 600)
    } catch (err) {
      console.error('PDF 생성 실패:', err)
      alert('PDF 생성 중 오류가 발생했습니다.')
    } finally {
      setPdfLoading(false)
    }
  }

  type PermitItem = typeof PERMIT_STAGE1[0] & { formUrl?: string; formNote?: string }

  const ItemRow = ({ item }: { item: PermitItem }) => {
    const isChecked = checked[item.id] ?? false
    const isRequired = item.required
    return (
      <div className={`rounded-lg border transition-colors ${
        isChecked ? 'bg-green-50 border-green-200'
        : isRequired ? 'bg-white border-red-200'
        : 'bg-white border-gray-200 hover:border-gray-300'
      }`}>
        <div className="flex items-start gap-3 p-3 cursor-pointer" onClick={() => toggle(item.id)}>
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
        {(item.formUrl || item.formNote) && (
          <div className="px-3 pb-2.5 flex items-start gap-2 border-t border-gray-100 pt-2">
            {item.formNote && (
              <span className="text-xs text-gray-500 flex-1">{item.formNote}</span>
            )}
            {item.formUrl && (
              <a
                href={item.formUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="flex-shrink-0 flex items-center gap-1 text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded hover:bg-blue-100 transition-colors"
              >
                <span>↗</span> 서식/신청
              </a>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {requiredUnchecked.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-3">
          <span className="text-red-500 text-xl flex-shrink-0">⚠</span>
          <span className="text-sm font-semibold text-red-700">필수 항목 {requiredUnchecked.length}개 미완료</span>
        </div>
      )}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <span className="text-lg">📋</span> 인허가 서류 체크리스트
            </h3>
            <div className="text-sm text-gray-500 mt-0.5">{checkedCount}/{visibleAll.length}개 완료</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'building', 'land'] as const).map(key => (
              <button key={key} onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  filter === key ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'
                }`}>
                {key === 'all' ? '전체' : key === 'building' ? '건물형' : '토지형'}
              </button>
            ))}
            <button onClick={handleSavePDF} disabled={pdfLoading}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-60">
              {pdfLoading ? '생성 중...' : 'PDF 다운로드'}
            </button>
          </div>
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>진행률</span><span className="font-semibold text-blue-600">{progress}%</span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-blue-500 to-green-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

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
        <div className="p-4 space-y-2">{visibleStage1.map(item => <ItemRow key={item.id} item={item} />)}</div>
      </div>

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
        <div className="p-4 space-y-2">{visibleStage2.map(item => <ItemRow key={item.id} item={item} />)}</div>
      </div>

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
