import { NextRequest, NextResponse } from 'next/server'

// KIER API 엔드포인트 (2025-11-18 서비스 URL 변경 적용)
const ENDPOINTS = {
  pv:    'https://apis.data.go.kr/B551184/SolarPvService/getSolarPvHrInfo',
  ghi:   'https://apis.data.go.kr/B551184/SolarGhiService/getSolarGhiHrInfo',
  srqty: 'https://apis.data.go.kr/B551184/SrQtyService/getSrQtyPredcInfo',
}

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// 시간대 데이터에서 값 추출 (필드명 다중 대응)
function extractHourlyValue(item: Record<string, unknown>, type: 'pv' | 'ghi'): number {
  let val: unknown
  if (type === 'pv') {
    val = item.pvPot ?? item.pvValue ?? item.apvPot ?? item.pvEnerge ?? item.power ?? 0
  } else {
    val = item.ghi ?? item.ghiValue ?? item.srqty ?? item.radiation ?? item.irrad ?? 0
  }
  return parseFloat(String(val)) || 0
}

// 특정 날짜 데이터 조회 (24시간 합계 반환)
async function fetchDailySum(
  url: string,
  apiKey: string,
  date: string,
  lat: string,
  lon: string,
  type: 'pv' | 'ghi',
): Promise<number | null> {
  const params = new URLSearchParams({
    serviceKey: apiKey,
    date,
    lat,
    lon,
    pageNo: '1',
    numOfRows: '24',
    type: 'json',
  })

  try {
    const res = await fetch(`${url}?${params}`, { cache: 'no-store' })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) return null

    const data = await res.json()
    const items = data?.response?.body?.items?.item
    if (!items) return null

    const list: Record<string, unknown>[] = Array.isArray(items) ? items : [items]
    if (list.length === 0) return null

    const sum = list.reduce((acc, item) => acc + extractHourlyValue(item, type), 0)
    return sum
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const service = searchParams.get('service')
  const apiKey = process.env.KIER_API_KEY

  if (!apiKey) {
    return NextResponse.json({ error: 'KIER_API_KEY not configured' }, { status: 503 })
  }

  const lat = searchParams.get('lat') ?? ''
  const lon = searchParams.get('lon') ?? ''

  if (!lat || !lon) {
    return NextResponse.json({ error: 'lat, lon required' }, { status: 400 })
  }

  // 연간 합계 계산: 매월 15일 샘플링 × 해당 월 일수로 환산
  if (service === 'pv' || service === 'ghi') {
    const url = service === 'pv' ? ENDPOINTS.pv : ENDPOINTS.ghi
    const type = service === 'pv' ? 'pv' : 'ghi'
    const targetYear = new Date().getFullYear() - 1  // 직전 연도 데이터 사용

    let annualTotal = 0
    let successCount = 0

    for (let month = 1; month <= 12; month++) {
      const dateStr = `${targetYear}${String(month).padStart(2, '0')}15`
      const dailySum = await fetchDailySum(url, apiKey, dateStr, lat, lon, type)

      if (dailySum !== null) {
        annualTotal += dailySum * DAYS_PER_MONTH[month - 1]
        successCount++
      }
    }

    if (successCount === 0) {
      return NextResponse.json(
        { error: 'KIER API: 데이터를 가져올 수 없습니다', fallback: true },
        { status: 502 },
      )
    }

    // 누락된 월은 성공한 월의 평균으로 보완
    if (successCount < 12) {
      const avgPerMonth = annualTotal / successCount
      annualTotal += avgPerMonth * (12 - successCount)
    }

    return NextResponse.json({
      annualTotal: Math.round(annualTotal * 10) / 10,
      sampledMonths: successCount,
      year: targetYear,
    })
  }

  // 월별 서비스 (pv-month, ghi-month): 특정 월 합계
  if (service === 'pv-month' || service === 'ghi-month') {
    const url = service === 'pv-month' ? ENDPOINTS.pv : ENDPOINTS.ghi
    const type = service === 'pv-month' ? 'pv' : 'ghi'
    const targetYear = new Date().getFullYear() - 1
    const results: { month: number; total: number }[] = []

    for (let month = 1; month <= 12; month++) {
      const dateStr = `${targetYear}${String(month).padStart(2, '0')}15`
      const dailySum = await fetchDailySum(url, apiKey, dateStr, lat, lon, type)
      if (dailySum !== null) {
        results.push({ month, total: Math.round(dailySum * DAYS_PER_MONTH[month - 1] * 10) / 10 })
      }
    }

    return NextResponse.json({ months: results, year: targetYear })
  }

  return NextResponse.json({ error: 'invalid service (pv|ghi|pv-month|ghi-month)' }, { status: 400 })
}
