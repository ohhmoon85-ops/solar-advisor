import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('query') ?? ''
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(query)}` +
    `&format=json&limit=1&countrycodes=kr&addressdetails=1`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SolarAdvisor/1.0 (solar-advisor.vercel.app)',
        'Accept-Language': 'ko,en',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `Nominatim HTTP ${res.status}` },
        { status: res.status }
      )
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: 'Nominatim request failed: ' + msg }, { status: 500 })
  }
}
