import { NextRequest, NextResponse } from 'next/server'

// Kakao Local API — 주소 검색 (좌표 변환)
// 키 발급: https://developers.kakao.com → 앱 만들기 → REST API 키
// 환경변수: KAKAO_REST_API_KEY

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('query')
  const apiKey = process.env.KAKAO_REST_API_KEY

  if (!apiKey) {
    return NextResponse.json({ error: 'KAKAO_REST_API_KEY not configured', fallback: true }, { status: 503 })
  }
  if (!query) {
    return NextResponse.json({ error: 'query required' }, { status: 400 })
  }

  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&analyze_type=similar`
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Kakao API HTTP ${res.status}`, fallback: true }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.json({ error: 'Kakao fetch failed: ' + msg, fallback: true }, { status: 500 })
  }
}
