import { NextRequest, NextResponse } from 'next/server'

// KPX SMP API - data.go.kr B552115/SmpWithForecastDemand
// Operation: getSmpWithForecastDemand | areaCd: 1=land
// Daily limit: 100 req/day -> cache 6h on server

const BASE_URL = 'https://apis.data.go.kr/B552115/SmpWithForecastDemand/getSmpWithForecastDemand'
const CACHE_TTL_SEC = 6 * 60 * 60  // 6 hours

function toYyyymmdd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

async function fetchSmp(apiKey: string, yyyymmdd: string): Promise<number | null> {
  const url =
    `${BASE_URL}?serviceKey=${apiKey}` +
    `&pageNo=1&numOfRows=1&dataType=JSON&areaCd=1&yyyymmdd=${yyyymmdd}`

  // revalidate every 6h to stay within 100 req/day limit
  const res = await fetch(url, {
    next: { revalidate: CACHE_TTL_SEC },
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null

  const data = await res.json()
  const rc: string = data?.response?.header?.resultCode ?? ''
  if (rc && rc !== '00' && rc !== '0000') return null

  const raw = data?.response?.body?.items?.item
  const first = Array.isArray(raw) ? raw[0] : raw
  const smp = Number(first?.smp)
  return !isNaN(smp) && smp > 0 ? smp : null
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KPX_SMP_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'KPX_SMP_API_KEY not set', fallback: true }, { status: 503 })
  }

  const now = new Date()
  const { searchParams } = new URL(req.url)
  const yyyymmdd = searchParams.get('yyyymmdd') ?? searchParams.get('date') ?? toYyyymmdd(now)

  try {
    let smp = await fetchSmp(apiKey, yyyymmdd)
    if (smp === null) {
      const d1 = new Date(now); d1.setDate(d1.getDate() - 1)
      smp = await fetchSmp(apiKey, toYyyymmdd(d1))
    }
    if (smp === null) {
      const d2 = new Date(now); d2.setDate(d2.getDate() - 2)
      smp = await fetchSmp(apiKey, toYyyymmdd(d2))
    }
    if (smp === null) {
      return NextResponse.json({ error: 'SMP data unavailable', fallback: true }, { status: 404 })
    }

    const response = NextResponse.json({ smp, unit: 'KRW/kWh', date: yyyymmdd, source: 'KPX' })
    // CDN/browser cache 6h
    response.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SEC}, stale-while-revalidate=3600`)
    return response
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'unknown',
      fallback: true,
    }, { status: 500 })
  }
}