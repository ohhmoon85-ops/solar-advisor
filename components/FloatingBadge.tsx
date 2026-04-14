'use client'

export default function FloatingBadge() {
  const handleClick = () => {
    // 지도 탭 입력 폼으로 스크롤
    const target =
      document.querySelector<HTMLElement>('input[placeholder*="지번"], input[placeholder*="주소"]') ??
      document.querySelector<HTMLElement>('main')
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus?.()
    }
  }

  return (
    <>
      <style>{`
        @keyframes badge-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
        .floating-badge {
          animation: badge-in 0.5s 0.8s ease both;
        }
        .floating-badge:hover {
          transform: scale(1.03);
          box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(245,166,35,0.3);
        }
        .floating-badge { transition: transform 0.2s ease, box-shadow 0.2s ease; }
      `}</style>

      <div
        className="floating-badge fixed bottom-20 sm:bottom-6 right-4 z-40 w-52 rounded-2xl overflow-hidden cursor-pointer select-none"
        style={{
          background: 'linear-gradient(145deg,#0f172a,#1e293b)',
          border: '1px solid rgba(245,166,35,0.35)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && handleClick()}
        aria-label="무료 시뮬레이션 시작"
      >
        {/* 상단 컬러 라인 */}
        <div className="h-0.5 w-full" style={{ background: 'linear-gradient(90deg,#f5a623,#4ecdc4)' }} />

        <div className="px-4 py-3">
          {/* 아이콘 + 타이틀 */}
          <div className="flex items-center gap-2 mb-1.5">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(245,166,35,0.15)', border: '1px solid rgba(245,166,35,0.3)' }}
            >
              <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="7" fill="#f5a623"/>
                <g stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round">
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
            <div>
              <div className="text-xs font-bold text-slate-100 leading-tight">SolarPath Advisor</div>
            </div>
          </div>

          {/* 뱃지 */}
          <div className="flex gap-1.5 mb-2.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{ background: 'rgba(78,205,196,0.15)', color: '#4ecdc4', border: '1px solid rgba(78,205,196,0.25)' }}>
              실증 검증
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{ background: 'rgba(245,166,35,0.15)', color: '#f5a623', border: '1px solid rgba(245,166,35,0.25)' }}>
              AI 배치 최적화
            </span>
          </div>

          {/* CTA */}
          <div
            className="flex items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold"
            style={{ background: 'rgba(245,166,35,0.12)', color: '#f5c842' }}
          >
            <span>무료 시뮬레이션 시작</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>
        </div>
      </div>
    </>
  )
}
