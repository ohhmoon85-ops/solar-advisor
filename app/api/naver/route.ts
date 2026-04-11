import { NextRequest, NextResponse } from 'next/server'

// 네이버 클라우드 플랫폼 Geocoding API
// 발급: console.ncloud.com → AI·NAVER API → Maps → Geocoding
// 환경변수: NAVER_MAP_CLIENT_ID, NAVER_MAP_CLIENT_SECRET

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('query')
  const clientId = process.env.NAVER_MAP_CLIENT_ID
  const clientSecret = process.env.NAVER_MAP_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'NAVER_MAP_CLIENT_ID/SECRET not configured', fallback: true }, { status: 503 })
  }
  if (!query) {
    return NextResponse.json({ error: 'query required' }, { status: 400 })
  }

  try {
    const url = `https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret,
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return NextResponse.json({ error: `Naver API HTTP ${res.status}: ${errText.slice(0, 200)}`, fallback: true }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.json({ error: 'Naver fetch failed: ' + msg, fallback: true }, { status: 500 })
  }
}
