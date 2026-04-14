'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useSolarStore } from '@/store/useStore'

// Dynamic imports to avoid SSR issues with canvas/leaflet
const WelcomeModal = dynamic(() => import('@/components/WelcomeModal'), { ssr: false })
const FloatingBadge = dynamic(() => import('@/components/FloatingBadge'), { ssr: false })
const MapTab = dynamic(() => import('@/components/tabs/MapTab'), { ssr: false })
const RevenueTab = dynamic(() => import('@/components/tabs/RevenueTab'), { ssr: false })
const OrdinanceTab = dynamic(() => import('@/components/tabs/OrdinanceTab'), { ssr: false })
const PermitTab = dynamic(() => import('@/components/tabs/PermitTab'), { ssr: false })
const PanelTab = dynamic(() => import('@/components/tabs/PanelTab'), { ssr: false })
const ChecklistTab = dynamic(() => import('@/components/tabs/ChecklistTab'), { ssr: false })
const UnitPriceTab = dynamic(() => import('@/components/tabs/UnitPriceTab'), { ssr: false })
const SimulationHistoryPanel = dynamic(() => import('@/components/SimulationHistoryPanel'), { ssr: false })
const SaveSimulationModal = dynamic(() => import('@/components/SaveSimulationModal'), { ssr: false })

const TABS = [
  { id: 'map', label: '지도·배치도', icon: '🗺️', shortLabel: '지도' },
  { id: 'revenue', label: '수익성 시뮬레이터', icon: '📊', shortLabel: '수익성' },
  { id: 'ordinance', label: '조례 비교', icon: '⚖️', shortLabel: '조례' },
  { id: 'permit', label: '인허가 서류', icon: '📋', shortLabel: '인허가' },
  { id: 'panel', label: '패널 사양', icon: '⚡', shortLabel: '패널' },
  { id: 'checklist', label: '실무 체크리스트', icon: '✅', shortLabel: '체크' },
  { id: 'unitprice', label: '단가 관리', icon: '💰', shortLabel: '단가' },
]

export default function Home() {
  const {
    activeTab, setActiveTab, priceOverride,
    historyPanelOpen, setHistoryPanelOpen,
    historyCount, setHistoryCount,
  } = useSolarStore()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const router = useRouter()

  const handleLogout = useCallback(() => {
    document.cookie = 'solar_auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
    router.replace('/login')
  }, [router])

  const currentTab = TABS.find(t => t.id === activeTab) ?? TABS[0]

  // 초기 이력 건수 로드
  useEffect(() => {
    import('@/lib/simulationHistory').then(m => {
      setHistoryCount(m.getAllSimulations().length)
    })
  }, [setHistoryCount])

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <WelcomeModal />
      <FloatingBadge />
      <SimulationHistoryPanel />
      <SaveSimulationModal onSaved={() => {
        import('@/lib/simulationHistory').then(m => setHistoryCount(m.getAllSimulations().length))
      }} />

      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3">
          {/* Logo */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-9 h-9 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-xl flex items-center justify-center text-xl shadow-sm">
              ☀️
            </div>
            <div className="hidden sm:block">
              <div className="font-bold text-gray-900 text-base leading-tight">SolarAdvisor</div>
              <div className="text-xs text-gray-400 leading-tight">(주)이강물산 이사 (예)육군대령 조영두</div>
            </div>
          </div>

          {/* Desktop tab navigation */}
          <nav className="hidden lg:flex flex-1 items-center gap-1 mx-2 xl:mx-4">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          {/* Mobile: current tab name */}
          <div className="lg:hidden flex-1 flex items-center gap-2">
            <span className="font-semibold text-gray-800 text-sm">{currentTab.icon} {currentTab.label}</span>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            <span className="hidden md:inline-flex text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-medium border border-green-200">
              SMP {priceOverride.smp}원 확정
            </span>
            {/* 이력 버튼 */}
            <button
              onClick={() => setHistoryPanelOpen(!historyPanelOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium transition-colors"
              title="시뮬레이션 이력"
            >
              <span>📋</span>
              <span className="hidden sm:inline">이력</span>
              {historyCount > 0 && (
                <span className="bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center">
                  {historyCount > 99 ? '99+' : historyCount}
                </span>
              )}
            </button>
            {/* 이력 관리 페이지 링크 */}
            <Link
              href="/history"
              className="hidden md:flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors px-2 py-1.5 rounded-lg hover:bg-gray-50"
              title="이력 관리 페이지"
            >
              <svg width="12" height="12" fill="none" viewBox="0 0 12 12">
                <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V5L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <path d="M7 1v4h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              <span>전체</span>
            </Link>
            {/* 로그아웃 버튼 */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-red-50 hover:text-red-500 transition-colors"
              title="로그아웃"
            >
              <svg width="13" height="13" fill="none" viewBox="0 0 13 13">
                <path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h3M9 9l3-3-3-3M12 6.5H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="hidden sm:inline">로그아웃</span>
            </button>
            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"
              aria-label="메뉴"
            >
              <div className={`w-5 h-0.5 bg-gray-600 transition-all mb-1 ${mobileMenuOpen ? 'rotate-45 translate-y-1.5' : ''}`} />
              <div className={`w-5 h-0.5 bg-gray-600 transition-all mb-1 ${mobileMenuOpen ? 'opacity-0' : ''}`} />
              <div className={`w-5 h-0.5 bg-gray-600 transition-all ${mobileMenuOpen ? '-rotate-45 -translate-y-1.5' : ''}`} />
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-gray-100 bg-white shadow-lg">
            <div className="max-w-screen-2xl mx-auto px-3 py-2 grid grid-cols-4 sm:grid-cols-7 gap-1.5">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setMobileMenuOpen(false) }}
                  className={`flex flex-col items-center gap-1 px-2 py-3 rounded-xl text-xs font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="text-2xl">{tab.icon}</span>
                  <span>{tab.shortLabel}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* Tablet sub-nav */}
      <nav className="hidden sm:flex lg:hidden bg-white border-b border-gray-200 sticky top-[61px] z-30 overflow-x-auto">
        <div className="max-w-screen-2xl mx-auto px-3 flex gap-1 py-1.5">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${
                activeTab === tab.id
                  ? 'bg-blue-500 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <span>{tab.icon}</span>
              <span className="hidden md:inline">{tab.label}</span>
              <span className="md:hidden">{tab.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-4 pb-20 sm:pb-6">
        {/* Demo guide */}
        <div className="mb-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl p-3 text-white">
          <div className="flex items-center gap-2 flex-wrap text-xs sm:text-sm">
            <span className="font-bold flex-shrink-0">📍 5분 데모:</span>
            {['① 지도→배치도', '② 수익성 계산', '③ 조례 확인', '④ 서류목록 PDF', '⑤ 계약 전환'].map((step, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="bg-white/20 px-2 py-0.5 rounded-full whitespace-nowrap">{step}</span>
                {i < 4 && <span className="opacity-60 hidden sm:inline">→</span>}
              </span>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div>
          {activeTab === 'map' && <MapTab />}
          {activeTab === 'revenue' && <RevenueTab />}
          {activeTab === 'ordinance' && <OrdinanceTab />}
          {activeTab === 'permit' && <PermitTab />}
          {activeTab === 'panel' && <PanelTab />}
          {activeTab === 'checklist' && <ChecklistTab />}
          {activeTab === 'unitprice' && <UnitPriceTab />}
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 shadow-lg safe-area-inset-bottom">
        <div className="grid grid-cols-7 h-16">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-col items-center justify-center gap-0.5 transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span className="text-[9px] leading-tight font-medium">{tab.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Footer */}
      <footer className="hidden sm:block bg-white border-t border-gray-100 py-3">
        <div className="max-w-screen-2xl mx-auto px-4 flex items-center justify-between text-xs text-gray-400 flex-wrap gap-2">
          <span>SolarAdvisor v5.2 © 2026 — 태양광 사업성 분석 플랫폼</span>
          <div className="flex items-center gap-3">
            <span>SMP {priceOverride.smp}원/kWh</span>
            <span>REC건물 {priceOverride.recBuilding.toLocaleString()}원/MWh ×1.5</span>
            <span>REC토지 {priceOverride.recLand.toLocaleString()}원/MWh</span>
            <span>발전시간 3.5h/일</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
