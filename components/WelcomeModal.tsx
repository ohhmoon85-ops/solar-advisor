'use client'

import { useState, useEffect } from 'react'

const LS_KEY = 'welcomeSeen'

function getShouldShow(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return true
    const data = JSON.parse(raw) as { type: 'forever' | 'today'; ts: number }
    if (data.type === 'forever') return false
    if (data.type === 'today') {
      const elapsed = Date.now() - data.ts
      return elapsed >= 24 * 60 * 60 * 1000
    }
  } catch { /* ignore */ }
  return true
}

const CARDS = [
  {
    icon: '🤖',
    title: 'AI 최적 패널 배치',
    desc: '부지 형태·위도·방위각을 동시에 계산하여 이론값이 아닌 실제 최대 설치 장수를 도출합니다',
  },
  {
    icon: '📐',
    title: '위도별 최적 경사각 자동 도출',
    desc: '강원도 38°부터 제주 33.5°까지 지역별 동지 기준 사계절 발전량을 극대화하는 최적 설치 각도를 자동 계산합니다',
  },
  {
    icon: '🗺️',
    title: '지번 입력 → 지적도 즉시 연동',
    desc: 'V-World 공공데이터로 해당 부지의 경계선·면적·지목을 자동으로 불러와 별도 도면 없이 바로 시뮬레이션합니다',
  },
  {
    icon: '⚖️',
    title: '법적 이격거리 자동 준수',
    desc: '토지·농지·임야·지붕 유형에 따라 경계선 마진(2m/0.5m)을 자동 반영하고 하천·도로 인접 시 추가 이격을 적용합니다',
  },
  {
    icon: '💰',
    title: '20년 수익 시뮬레이션',
    desc: '설치 비용·전기 단가·열화율을 반영한 LCOE와 투자 회수 기간을 현장에서 바로 확인할 수 있습니다',
  },
  {
    icon: '✅',
    title: '현장에서 원스탑 해결',
    desc: '주소 입력부터 패널 배치도 출력·수익 분석·PDF 보고서까지 고객 앞에서 5분 안에 완료합니다',
  },
]

export default function WelcomeModal() {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const [cardsIn, setCardsIn] = useState(false)
  const [skipToday, setSkipToday] = useState(false)
  const [skipForever, setSkipForever] = useState(false)

  useEffect(() => {
    if (getShouldShow()) {
      // 디버그 확인용 (구현 완료 확인)
      console.log('[WelcomeModal] localStorage welcomeSeen:', localStorage.getItem(LS_KEY) ?? '(없음 — 첫 방문)')
      setVisible(true)
      // 카드 stagger 시작은 팝업 등장(400ms) 이후
      const t = setTimeout(() => setCardsIn(true), 450)
      return () => clearTimeout(t)
    }
  }, [])

  const handleClose = () => {
    if (skipForever) {
      localStorage.setItem(LS_KEY, JSON.stringify({ type: 'forever', ts: Date.now() }))
    } else if (skipToday) {
      localStorage.setItem(LS_KEY, JSON.stringify({ type: 'today', ts: Date.now() }))
    }
    console.log('[WelcomeModal] 저장된 welcomeSeen:', localStorage.getItem(LS_KEY))
    setClosing(true)
    setTimeout(() => setVisible(false), 220)
  }

  if (!visible) return null

  return (
    <>
      <style>{`
        @keyframes solar-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes modal-in {
          from { opacity: 0; transform: translateY(28px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
        @keyframes modal-out {
          from { opacity: 1; transform: translateY(0)    scale(1);    }
          to   { opacity: 0; transform: translateY(12px) scale(0.97); }
        }
        @keyframes overlay-in  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes overlay-out { from { opacity: 1; } to { opacity: 0; } }
        @keyframes card-in {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
        .welcome-overlay {
          animation: ${closing ? 'overlay-out' : 'overlay-in'} ${closing ? '0.22s' : '0.3s'} ease forwards;
        }
        .welcome-modal {
          animation: ${closing ? 'modal-out' : 'modal-in'} ${closing ? '0.22s' : '0.4s'} cubic-bezier(.22,.68,0,1.2) forwards;
        }
        .sun-spin { animation: solar-spin 20s linear infinite; }
        .card-stagger-0  { animation: card-in 0.38s 0.00s ease both; }
        .card-stagger-1  { animation: card-in 0.38s 0.08s ease both; }
        .card-stagger-2  { animation: card-in 0.38s 0.16s ease both; }
        .card-stagger-3  { animation: card-in 0.38s 0.24s ease both; }
        .card-stagger-4  { animation: card-in 0.38s 0.32s ease both; }
        .card-stagger-5  { animation: card-in 0.38s 0.40s ease both; }
      `}</style>

      {/* 오버레이 */}
      <div
        className="welcome-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(3,7,18,0.78)', backdropFilter: 'blur(6px)' }}
        onClick={handleClose}
      >
        {/* 모달 */}
        <div
          className="welcome-modal relative w-full bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
          style={{ maxWidth: 780, maxHeight: '92vh', overflowY: 'auto' }}
          onClick={e => e.stopPropagation()}
        >
          {/* 상단 그라디언트 라인 */}
          <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg,#f5a623,#4ecdc4,#3b82f6)' }} />

          {/* 닫기 버튼 */}
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-100 hover:bg-slate-700 transition-colors z-10"
            aria-label="닫기"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>

          {/* ── 헤더 ── */}
          <div className="px-8 pt-8 pb-6 text-center">
            {/* 태양 아이콘 */}
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
              style={{ background: 'linear-gradient(135deg,#f5a623,#f97316)' }}>
              <svg className="sun-spin" width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="7" fill="#fff" fillOpacity=".95"/>
                <g stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="16" y1="2"  x2="16" y2="6"/>
                  <line x1="16" y1="26" x2="16" y2="30"/>
                  <line x1="2"  y1="16" x2="6"  y2="16"/>
                  <line x1="26" y1="16" x2="30" y2="16"/>
                  <line x1="6.34"  y1="6.34"  x2="9.17"  y2="9.17"/>
                  <line x1="22.83" y1="22.83" x2="25.66" y2="25.66"/>
                  <line x1="25.66" y1="6.34"  x2="22.83" y2="9.17"/>
                  <line x1="9.17"  y1="22.83" x2="6.34"  y2="25.66"/>
                </g>
              </svg>
            </div>

            <h1 className="text-2xl sm:text-3xl font-bold text-slate-50 leading-tight mb-2">
              AI가 계산하는 최적의 태양광 설계
            </h1>
            <p className="text-slate-400 text-sm sm:text-base">
              지번 하나로 수익까지, 현장에서 5분 완성
            </p>
          </div>

          {/* ── 카드 그리드 ── */}
          <div className="px-6 sm:px-8 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CARDS.map((card, i) => (
                <div
                  key={i}
                  className={`card-stagger-${i} rounded-xl p-4 border border-slate-700 hover:border-slate-500 transition-colors`}
                  style={{
                    background: 'rgba(30,41,59,0.7)',
                    opacity: cardsIn ? undefined : 0,
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl flex-shrink-0 mt-0.5">{card.icon}</span>
                    <div>
                      <div className="text-sm font-semibold text-slate-100 mb-1">{card.title}</div>
                      <div className="text-xs text-slate-400 leading-relaxed">{card.desc}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── CTA 영역 ── */}
          <div className="px-6 sm:px-8 pb-8">
            {/* 강조 문구 */}
            <div
              className="rounded-xl px-4 py-3 mb-5 text-center text-xs sm:text-sm font-medium"
              style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', color: '#f5c842' }}
            >
              실제 시공 사례 검증 완료 &nbsp;·&nbsp; 사계절 발전량 최적화 &nbsp;·&nbsp; 지적도 자동 연동
            </div>

            {/* 버튼 */}
            <div className="flex flex-col sm:flex-row gap-3 mb-5">
              <button
                onClick={handleClose}
                className="flex-1 py-3 px-6 rounded-xl font-semibold text-sm text-slate-900 transition-all hover:brightness-110 active:scale-[.98]"
                style={{ background: 'linear-gradient(135deg,#f5a623,#f97316)' }}
              >
                ▶&nbsp; 지금 바로 시작하기
              </button>
              <button
                onClick={handleClose}
                className="flex-1 sm:flex-none sm:w-32 py-3 px-6 rounded-xl font-medium text-sm text-slate-300 border border-slate-600 hover:bg-slate-800 hover:text-slate-100 transition-colors"
              >
                둘러보기
              </button>
            </div>

            {/* 체크박스 */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center items-start sm:items-center">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={skipToday}
                  onChange={e => {
                    setSkipToday(e.target.checked)
                    if (e.target.checked) setSkipForever(false)
                  }}
                  className="w-4 h-4 rounded accent-amber-500 cursor-pointer"
                />
                <span className="text-xs text-slate-500 group-hover:text-slate-400 transition-colors">
                  오늘 하루 보지 않기
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={skipForever}
                  onChange={e => {
                    setSkipForever(e.target.checked)
                    if (e.target.checked) setSkipToday(false)
                  }}
                  className="w-4 h-4 rounded accent-amber-500 cursor-pointer"
                />
                <span className="text-xs text-slate-500 group-hover:text-slate-400 transition-colors">
                  다시 보지 않기
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
