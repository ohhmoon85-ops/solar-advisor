'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const SAVED_ID_KEY = 'solar_saved_id'
const AUTH_COOKIE = 'solar_auth'

// 승인된 계정
const VALID_ID = 'choyd6448'
const VALID_PW = 'leesh7221!'

function setAuthCookie() {
  const expires = new Date()
  expires.setDate(expires.getDate() + 30) // 30일 유지
  document.cookie = `${AUTH_COOKIE}=1; path=/; expires=${expires.toUTCString()}; SameSite=Strict`
}

export default function LoginPage() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [saveId, setSaveId] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPw, setShowPw] = useState(false)

  // 저장된 ID 불러오기
  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ID_KEY)
    if (saved) {
      setId(saved)
      setSaveId(true)
    }
  }, [])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    setTimeout(() => {
      if (id === VALID_ID && pw === VALID_PW) {
        // ID 저장 처리
        if (saveId) {
          localStorage.setItem(SAVED_ID_KEY, id)
        } else {
          localStorage.removeItem(SAVED_ID_KEY)
        }
        setAuthCookie()
        router.replace('/')
      } else {
        setError('아이디 또는 비밀번호가 올바르지 않습니다.')
        setLoading(false)
      }
    }, 400)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 로고 */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-2xl flex items-center justify-center text-3xl shadow-lg mb-3">
            ☀️
          </div>
          <h1 className="text-2xl font-bold text-gray-900">SolarAdvisor</h1>
          <p className="text-sm text-gray-500 mt-1">(주)이강물산 이사 (예)육군대령 조영두</p>
        </div>

        {/* 로그인 카드 */}
        <div className="bg-white rounded-2xl shadow-xl p-6 border border-gray-100">
          <h2 className="text-base font-semibold text-gray-800 mb-5 text-center">로그인</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* ID */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">아이디</label>
              <input
                type="text"
                value={id}
                onChange={e => setId(e.target.value)}
                placeholder="아이디를 입력하세요"
                autoComplete="username"
                required
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition"
              />
            </div>

            {/* PW */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">비밀번호</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={pw}
                  onChange={e => setPw(e.target.value)}
                  placeholder="비밀번호를 입력하세요"
                  autoComplete="current-password"
                  required
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                  tabIndex={-1}
                >
                  {showPw ? '숨김' : '표시'}
                </button>
              </div>
            </div>

            {/* ID 저장 */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveId}
                onChange={e => setSaveId(e.target.checked)}
                className="w-4 h-4 rounded accent-blue-500"
              />
              <span className="text-xs text-gray-500">아이디 저장</span>
            </label>

            {/* 에러 */}
            {error && (
              <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 text-center">
                {error}
              </div>
            )}

            {/* 로그인 버튼 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
            >
              {loading ? '확인 중...' : '로그인'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-5">
          태양광 사업성 분석 플랫폼 v5.2
        </p>
      </div>
    </div>
  )
}
