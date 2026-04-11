import { NextRequest, NextResponse } from 'next/server'

const NOM_BASE = 'https://nominatim.openstreetmap.org/search'
const HEADERS = {
  'User-Agent': 'SolarAdvisor/1.0 (solar-advisor.vercel.app)',
  'Accept-Language': 'ko,en',
}

async function nominatimSearch(q: string): Promise<unknown[] | null> {
  const url = `${NOM_BASE}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=kr&addressdetails=1`
  try {
    const res = await fetch(url, { headers: HEADERS, cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data) && data.length > 0 ? data : null
  } catch { return null }
}

// 지번/번지 제거: "경기도 동두천시 하봉암동 3-1" → "경기도 동두천시 하봉암동"
function stripLotNumber(q: string): string {
  return q.replace(/\s+\d+(-\d+)?$/, '').trim()
}

// 시/군/구 이하만: "경기도 동두천시 하봉암동" → "동두천시 하봉암동"
function dropProvince(q: string): string {
  const parts = q.trim().split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(' ') : q
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('query') ?? ''
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  try {
    // 1차: 원본 쿼리
    let result = await nominatimSearch(query)
    if (result) return NextResponse.json(result)

    // 2차: 지번 제거 (동 단위까지만)
    const noLot = stripLotNumber(query)
    if (noLot !== query) {
      result = await nominatimSearch(noLot)
      if (result) return NextResponse.json(result)
    }

    // 3차: 도/광역시 제거 (시/군/구 + 동)
    const noProvince = dropProvince(noLot)
    if (noProvince !== noLot) {
      result = await nominatimSearch(noProvince)
      if (result) return NextResponse.json(result)
    }

    // 4차: 동/읍/면만 (마지막 두 단어)
    const parts = noProvince.trim().split(/\s+/)
    if (parts.length > 1) {
      const short = parts.slice(-2).join(' ')
      result = await nominatimSearch(short)
      if (result) return NextResponse.json(result)
    }

    return NextResponse.json([])
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: 'Nominatim request failed: ' + msg }, { status: 500 })
  }
}
