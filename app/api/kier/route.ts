import { NextRequest, NextResponse } from 'next/server'

// 한국에너지기술연구원 (KIER) API 프록시
// SolarPvService : 태양광 발전량 예측정보  → KIER_PV_API_KEY
// SolarGhiService: 태양에너지 시공간 자원정보 → KIER_API_KEY

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const service = searchParams.get('service') // 'pv' | 'ghi' | 'pv-month' | 'ghi-month'

  // 서비스별로 다른 API 키 사용
  const ghiKey = process.env.KIER_API_KEY      // 태양에너지 시공간 자원정보
  const pvKey  = process.env.KIER_PV_API_KEY   // 태양광 발전량 예측정보
               ?? process.env.KIER_API_KEY     // 폴백: 키가 동일한 경우 대비

  const isPvService = service === 'pv' || service === 'pv-month'
  const apiKey = isPvService ? pvKey : ghiKey

  if (!apiKey) {
    const missing = isPvService ? 'KIER_PV_API_KEY' : 'KIER_API_KEY'
    return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })
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
    } else {
      return NextResponse.json({ error: 'invalid service (pv|ghi|pv-month|ghi-month)' }, { status: 400 })
    }

    const res = await fetch(url, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'KIER API request failed' }, { status: 500 })
  }
}
