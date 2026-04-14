import { NextRequest, NextResponse } from 'next/server'

// ──────────────────────────────────────────────────────────────────
// 한국전력거래소 계통한계가격 및 수요예측 API (하루전 발전계획용)
// EndPoint: https://apis.data.go.kr/B552115/SmpWithForecastDemand
// data.go.kr 신청 → 승인 후 serviceKey 발급
// 환경변수: KPX_SMP_API_KEY (포털 제공 Encoding 인증키)
// ──────────────────────────────────────────────────────────────────

/** yyyymmdd 문자열 반환 */
function toYyyymmdd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 전날 Date 반환 */
function prevDay(d: Date): Date {
  const pd = new Date(d)
  pd.setDate(pd.getDate() - 1)
  return pd
}

/** SMP 아이템 타입 */
interface SmpItem {
  baseDate?: string
  baseDatetime?: string
  datetime?: string
  smpPrice?: number
  smp?: number
  price?: number
  areaCode?: string
  areaCd?: string
  landSmpPrice?: number
  jejuSmpPrice?: number
  [key: string]: unknown
}

/** 아이템 배열에서 육지 SMP 평균 추출 */
function extractAvgSmp(items: SmpItem[]): number | null {
  if (!items.length) return null

  // 육지(areaCode='L' 또는 '1') 우선, 없으면 전체 평균
  const landItems = items.filter(i => {
    const code = (i.areaCode ?? i.areaCd ?? '').toString().toUpperCase()
    return code === 'L' || code === '1' || code === '전국' || code === 'LAND'
  })
  const target = landItems.length ? landItems : items

  const priceField = ['smpPrice', 'landSmpPrice', 'smp', 'price'] as const
  let sum = 0, count = 0
  for (const item of target) {
    for (const f of priceField) {
      const v = Number(item[f])
      if (!isNaN(v) && v > 0) { sum += v; count++; break }
    }
  }
  return count > 0 ? Math.round(sum / count) : null
}

/** B552115/SmpWithForecastDemand 단일 조회 */
async function fetchSmpByDate(
  apiKey: string,
  yyyymmdd: string
): Promise<{ smp: number | null; raw: unknown }> {
  // data.go.kr REST 표준: sub-path는 API마다 다를 수 있음
  // 가능한 경로를 순서대로 시도
  const candidates = [
    `https://apis.data.go.kr/B552115/SmpWithForecastDemand/getSmpWithForecastDemandList`,
    `https://apis.data.go.kr/B552115/SmpWithForecastDemand/getSmpList`,
    `https://apis.data.go.kr/B552115/SmpWithForecastDemand`,
  ]

  for (const base of candidates) {
    try {
      // data.go.kr: Encoding key는 그대로(encodeURIComponent 불필요), Decoding key는 인코딩 필요
      // 포털에서 Encoding 키를 사용하는 경우 그대로 전달
      const url =
        `${base}?serviceKey=${apiKey}` +
        `&pageNo=1&numOfRows=48&dataType=JSON` +
        `&yyyymmdd=${yyyymmdd}`

      const res = await fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })

      const contentType = res.headers.get('content-type') ?? ''

      // XML 에러 응답 처리 (API 키 오류, 미승인 등)
      if (!contentType.includes('json')) {
        const text = await res.text()
        // returnAuthMsg 또는 errMsg 파싱
        const msg =
          text.match(/<returnAuthMsg[^>]*>([^<]+)<\/returnAuthMsg>/)?.[1] ??
          text.match(/<errMsg[^>]*>([^<]+)<\/errMsg>/)?.[1] ??
          `non-JSON (HTTP ${res.status})`
        // SERVICE_KEY_IS_NOT_REGISTERED_ERROR 등이면 다음 경로 시도 불필요
        if (msg.includes('SERVICE_KEY') || msg.includes('인증')) {
          return { smp: null, raw: { error: msg } }
        }
        continue  // 다음 경로 시도
      }

      const data = await res.json()

      // 표준 data.go.kr 응답 구조
      const resultCode: string =
        data?.response?.header?.resultCode ?? data?.response?.header?.resultCd ?? ''
      if (resultCode && resultCode !== '00' && resultCode !== '0000') {
        const resultMsg = data?.response?.header?.resultMsg ?? '알 수 없는 오류'
        // NO_DATA 같은 경우는 다음 날짜로 재시도
        if (resultMsg.includes('NO_DATA') || resultMsg.includes('데이터없음')) {
          return { smp: null, raw: data }
        }
        continue
      }

      const items: SmpItem[] =
        data?.response?.body?.items?.item ??
        data?.response?.body?.items ??
        data?.items?.item ??
        []

      const normalized = Array.isArray(items) ? items : [items]
      const smp = extractAvgSmp(normalized)

      if (smp !== null) {
        return { smp, raw: data }
      }
    } catch {
      continue
    }
  }

  return { smp: null, raw: null }
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KPX_SMP_API_KEY

  if (!apiKey) {
    return NextResponse.json({
      error: 'KPX_SMP_API_KEY not configured',
      guide:
        'data.go.kr에서 한국전력거래소_계통한계가격및수요예측(B552115/SmpWithForecastDemand)을 신청하고 ' +
        'Vercel 환경변수 KPX_SMP_API_KEY에 Encoding 인증키를 설정하세요.',
      fallback: true,
    }, { status: 503 })
  }

  const { searchParams } = new URL(req.url)
  const now = new Date()

  // yyyymmdd 파라미터: 클라이언트 전달 또는 오늘
  const yyyymmdd =
    searchParams.get('yyyymmdd') ??
    searchParams.get('date') ??
    toYyyymmdd(now)

  try {
    // 1차: 요청 날짜
    let { smp, raw } = await fetchSmpByDate(apiKey, yyyymmdd)

    // 2차: 전날 (오늘 데이터가 아직 없을 수 있음)
    if (smp === null) {
      const prev = toYyyymmdd(prevDay(new Date(
        Number(yyyymmdd.slice(0, 4)),
        Number(yyyymmdd.slice(4, 6)) - 1,
        Number(yyyymmdd.slice(6, 8))
      )));
      ({ smp, raw } = await fetchSmpByDate(apiKey, prev))
    }

    // 3차: 2일 전
    if (smp === null) {
      const d = new Date(now)
      d.setDate(d.getDate() - 2)
      const twoDaysAgo = toYyyymmdd(d);
      ({ smp, raw } = await fetchSmpByDate(apiKey, twoDaysAgo))
    }

    if (smp === null) {
      return NextResponse.json({
        error: 'SMP 데이터를 가져오지 못했습니다. API 키를 확인하거나 잠시 후 다시 시도하세요.',
        raw,
        fallback: true,
      }, { status: 404 })
    }

    return NextResponse.json({
      smp,
      unit: '원/kWh',
      date: yyyymmdd,
      source: 'data.go.kr · B552115/SmpWithForecastDemand',
    })

  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'unknown',
      fallback: true,
    }, { status: 500 })
  }
}
