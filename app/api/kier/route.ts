import { NextRequest, NextResponse } from 'next/server'

// 한국에너지기술연구원 (KIER) API 프록시 — 모든 서비스 동일 API 키 사용
// SolarPvService : 태양광 발전량 예측정보   → service=pv | pv-month
// SolarGhiService: 태양에너지 시공간 자원정보 → service=ghi | ghi-month
// SrQtyService   : 실시간 일사량 데이터      → service=srqty | srqty-month

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const service = searchParams.get('service')

  const apiKey = process.env.KIER_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'KIER_API_KEY not configured' }, { status: 503 })
  }

  const lat = searchParams.get('lat') ?? ''
  const lon = searchParams.get('lon') ?? ''
  const tilt = searchParams.get('tilt') ?? '33'
  const azimuth = searchParams.get('azimuth') ?? '0' // 0 = 정남향

  if (!lat || !lon) {
    return NextResponse.json({ error: 'lat, lon required' }, { status: 400 })
  }

  const key = encodeURIComponent(apiKey)

  try {
    let url = ''

    if (service === 'pv') {
      // 연간 태양광 발전 가능량 (kWh/kW/년) — 경사각·방위각 반영
      url =
        `https://apis.data.go.kr/B551184/SolarPvService/getYearPvPot` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}` +
        `&tilt=${tilt}&azimuth=${azimuth}&capacity=1&_type=json`
    } else if (service === 'pv-month') {
      // 월별 태양광 발전 가능량
      url =
        `https://apis.data.go.kr/B551184/SolarPvService/getMonthPvPot` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}` +
        `&tilt=${tilt}&azimuth=${azimuth}&capacity=1&_type=json`
    } else if (service === 'ghi') {
      // 연간 수평면 전일사량 (kWh/m²/년)
      url =
        `https://apis.data.go.kr/B551184/SolarGhiService/getYearGhiInfo` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}&_type=json`
    } else if (service === 'ghi-month') {
      // 월별 수평면 전일사량
      url =
        `https://apis.data.go.kr/B551184/SolarGhiService/getMonthGhiInfo` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}&_type=json`
    } else if (service === 'srqty') {
      // 연간 실시간 일사량 (kWh/m²/년)
      url =
        `https://apis.data.go.kr/B551184/SrQtyService/getYearSrQtyInfo` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}&_type=json`
    } else if (service === 'srqty-month') {
      // 월별 실시간 일사량
      url =
        `https://apis.data.go.kr/B551184/SrQtyService/getMonthSrQtyInfo` +
        `?serviceKey=${key}&lat=${lat}&lon=${lon}&_type=json`
    } else {
      return NextResponse.json(
        { error: 'invalid service (pv|ghi|srqty|pv-month|ghi-month|srqty-month)' },
        { status: 400 }
      )
    }

    const res = await fetch(url, { cache: 'no-store' })

    // KIER API가 XML 오류 페이지를 반환하는 경우 처리 (serviceKey 오류 등)
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      const text = await res.text()
      const msgMatch = text.match(/<returnAuthMsg[^>]*>([^<]+)<\/returnAuthMsg>/)
        ?? text.match(/<errMsg[^>]*>([^<]+)<\/errMsg>/)
      const msg = msgMatch ? msgMatch[1] : `HTTP ${res.status} — non-JSON response`
      return NextResponse.json({ error: `KIER API error: ${msg}` }, { status: 502 })
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `KIER API request failed: ${msg}` }, { status: 500 })
  }
}
