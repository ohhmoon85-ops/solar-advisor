import { NextResponse } from 'next/server'

// KPX SMP API — 최근 90일 일별 SMP 평균 (분기 평균)
// data.go.kr B552115/SmpWithForecastDemand
// env: KPX_SMP_API_KEY | areaCd: 1=land
// 1시간 메모리 캐시 + Next.js revalidate 1h

export const runtime = 'nodejs'
export const revalidate = 3600

const BASE_URL = 'https://apis.data.go.kr/B552115/SmpWithForecastDemand/getSmpWithForecastDemand'
const CACHE_TTL_MS = 60 * 60 * 1000

interface QtrCache {
  smp: number
  period: string
  count: number
  cachedAt: string
  expiresAt: number
}
let memCache: QtrCache | null = null

function toYyyymmdd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function toDateStr(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

async function fetchSmpPage(apiKey: string, yyyymmdd: string, numOfRows: number): Promise<Array<{ date: string; smp: number }>> {
  const url =
    `${BASE_URL}?serviceKey=${apiKey}` +
    `&pageNo=1&numOfRows=${numOfRows}&dataType=JSON&areaCd=1&yyyymmdd=${yyyymmdd}`

  const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
  if (!res.ok) return []

  const data = await res.json()
  const rc: string = data?.response?.header?.resultCode ?? ''
  if (rc && rc !== '00' && rc !== '0000') return []

  const raw = data?.response?.body?.items?.item
  if (!raw) return []
  const items: unknown[] = Array.isArray(raw) ? raw : [raw]

  return items
    .map(i => {
      const obj = i as Record<string, unknown>
      return {
        date: String(obj.baseDt ?? obj.date ?? obj.yyyymmdd ?? ''),
        smp: Number(obj.smp ?? 0),
      }
    })
    .filter(r => r.smp > 0)
}

export async function GET() {
  const apiKey = process.env.KPX_SMP_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'KPX_SMP_API_KEY not set', fallback: true }, { status: 503 })
  }

  const now = Date.now()

  if (memCache && now < memCache.expiresAt) {
    return NextResponse.json({
      smp: memCache.smp,
      unit: 'KRW/kWh',
      period: memCache.period,
      count: memCache.count,
      source: 'KPX',
      cached: true,
      cachedAt: memCache.cachedAt,
    })
  }

  try {
    const nowDate = new Date()
    const endDate = toYyyymmdd(nowDate)

    // 최근 90일치 요청 — API가 단일 날짜만 지원하면 count=1로 반환됨
    const records = await fetchSmpPage(apiKey, endDate, 90)

    // 데이터 없으면 어제, 그제 순서로 재시도
    if (records.length === 0) {
      for (let offset = 1; offset <= 3; offset++) {
        const d = new Date(nowDate)
        d.setDate(d.getDate() - offset)
        const fallback = await fetchSmpPage(apiKey, toYyyymmdd(d), 90)
        if (fallback.length > 0) {
          records.push(...fallback)
          break
        }
      }
    }

    if (records.length === 0) {
      return NextResponse.json({ error: 'SMP data unavailable', fallback: true }, { status: 404 })
    }

    const avg = records.reduce((s, r) => s + r.smp, 0) / records.length
    const smp = Math.round(avg * 100) / 100

    const dates = records.map(r => r.date).filter(Boolean).sort()
    const startLabel = dates.length > 0 ? toDateStr(dates[0]) : toDateStr(toYyyymmdd(new Date(nowDate.getTime() - 89 * 86400000)))
    const endLabel = dates.length > 0 ? toDateStr(dates[dates.length - 1]) : toDateStr(endDate)
    const period = `${startLabel} ~ ${endLabel}`

    const cachedAt = new Date().toISOString()
    memCache = { smp, period, count: records.length, cachedAt, expiresAt: now + CACHE_TTL_MS }

    const response = NextResponse.json({
      smp,
      unit: 'KRW/kWh',
      period,
      count: records.length,
      source: 'KPX',
      cached: false,
      cachedAt,
    })
    response.headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600')
    return response

  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'unknown', fallback: true }, { status: 500 })
  }
}
