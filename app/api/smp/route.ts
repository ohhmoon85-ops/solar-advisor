import { NextRequest, NextResponse } from 'next/server'

// KPX SMP API - data.go.kr B552115/SmpWithForecastDemand
// Operation: getSmpWithForecastDemand | areaCd: 1=land
// Daily limit: 100 req/day -> memory cache 1h + Next.js revalidate 1h

export const revalidate = 3600

const BASE_URL = 'https://apis.data.go.kr/B552115/SmpWithForecastDemand/getSmpWithForecastDemand'
const CACHE_TTL_MS = 60 * 60 * 1000  // 1 hour

// ── 서버 메모리 캐시 ───────────────────────────────────────────────
interface SmpCache {
  smp: number
  date: string
  cachedAt: string
  expiresAt: number
}
let memCache: SmpCache | null = null

// ── 헬퍼 ──────────────────────────────────────────────────────────
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

  const res = await fetch(url, {
    cache: 'no-store',
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

// ── Route Handler ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const apiKey = process.env.KPX_SMP_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'KPX_SMP_API_KEY not set', fallback: true }, { status: 503 })
  }

  const now = Date.now()

  // 메모리 캐시 유효하면 즉시 반환
  if (memCache && now < memCache.expiresAt) {
    return NextResponse.json({
      smp: memCache.smp,
      unit: 'KRW/kWh',
      date: memCache.date,
      source: 'KPX',
      cached: true,
      cachedAt: memCache.cachedAt,
    })
  }

  // KPX API 호출
  const nowDate = new Date()
  const { searchParams } = new URL(req.url)
  const yyyymmdd = searchParams.get('yyyymmdd') ?? searchParams.get('date') ?? toYyyymmdd(nowDate)

  try {
    let smp = await fetchSmp(apiKey, yyyymmdd)
    if (smp === null) {
      const d1 = new Date(nowDate); d1.setDate(d1.getDate() - 1)
      smp = await fetchSmp(apiKey, toYyyymmdd(d1))
    }
    if (smp === null) {
      const d2 = new Date(nowDate); d2.setDate(d2.getDate() - 2)
      smp = await fetchSmp(apiKey, toYyyymmdd(d2))
    }
    if (smp === null) {
      return NextResponse.json({ error: 'SMP data unavailable', fallback: true }, { status: 404 })
    }

    // 캐시 갱신
    const cachedAt = new Date().toISOString()
    memCache = { smp, date: yyyymmdd, cachedAt, expiresAt: now + CACHE_TTL_MS }

    const response = NextResponse.json({
      smp,
      unit: 'KRW/kWh',
      date: yyyymmdd,
      source: 'KPX',
      cached: false,
      cachedAt,
    })
    response.headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600')
    return response

  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'unknown',
      fallback: true,
    }, { status: 500 })
  }
}