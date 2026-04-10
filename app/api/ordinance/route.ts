import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const region = searchParams.get('region') || ''
  const apiKey = process.env.LAW_API_KEY

  if (!apiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 500 })
  }

  try {
    const searchUrl = `http://www.law.go.kr/DRF/lawSearch.do?OC=${apiKey}&target=ordin&query=${encodeURIComponent(region + ' 태양광')}&type=JSON&display=5`
    const res = await fetch(searchUrl, { next: { revalidate: 3600 } })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch ordinance data' }, { status: 500 })
  }
}
