import { NextRequest, NextResponse } from 'next/server'

// data.go.kr 한국전력거래소 계통한계가격(SMP) API
// API 신청: https://www.data.go.kr → '계통한계가격' 검색 → 한국전력거래소 SMP 서비스 신청
// 환경변수: KPX_SMP_API_KEY (발급받은 serviceKey)

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const apiKey = process.env.KPX_SMP_API_KEY

  if (!apiKey) {
    return NextResponse.json({
      error: 'KPX_SMP_API_KEY not configured',
      guide: 'data.go.kr에서 한국전력거래소 SMP 서비스를 신청하고 KPX_SMP_API_KEY 환경변수를 설정하세요.',
      fallback: true,
    }, { status: 503 })
  }

  const now = new Date()
  const yyyymm = searchParams.get('yyyymm') ??
    (now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0'))

  try {
    const url =
      'https://apis.data.go.kr/B551182/smpInvtCalc/smpInvtCalcList' +
      '?serviceKey=' + encodeURIComponent(apiKey) +
      '&pageNo=1&numOfRows=31&dataType=JSON&yyyymm=' + yyyymm

    const res = await fetch(url, { cache: 'no-store' })

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      const text = await res.text()
      const msgMatch = text.match(/<returnAuthMsg[^>]*>([^<]+)</returnAuthMsg>/)
      const msg = msgMatch ? msgMatch[1] : 'non-JSON (API 키 오류 또는 미승인)'
      return NextResponse.json({ error: msg, fallback: true }, { status: 502 })
    }

    const data = await res.json()
    const items: Array<{ baseDatetime?: string; smpPrice?: number; areaCode?: string }> =
      data?.response?.body?.items?.item ?? []

    if (!items.length) {
      // 전월 재시도
      const m = now.getMonth()
      const prevYYYYMM = m === 0
        ? (now.getFullYear() - 1) + '12'
        : now.getFullYear() + String(m).padStart(2, '0')
      const url2 = url.replace('yyyymm=' + yyyymm, 'yyyymm=' + prevYYYYMM)
      const res2 = await fetch(url2, { cache: 'no-store' })
      const data2 = await res2.json()
      const items2: typeof items = data2?.response?.body?.items?.item ?? []
      if (!items2.length) {
        return NextResponse.json({ error: 'SMP 데이터 없음', fallback: true }, { status: 404 })
      }
      const avg = Math.round(items2.reduce((s, i) => s + (i.smpPrice ?? 0), 0) / items2.length)
      return NextResponse.json({ smp: avg, unit: '원/kWh', period: prevYYYYMM, source: 'data.go.kr' })
    }

    const avg = Math.round(items.reduce((s, i) => s + (i.smpPrice ?? 0), 0) / items.length)
    return NextResponse.json({ smp: avg, unit: '원/kWh', period: yyyymm, source: 'data.go.kr' })

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.json({ error: msg, fallback: true }, { status: 500 })
  }
}
