import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const apiKey = process.env.VWORLD_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: 'VWORLD_API_KEY not configured' },
      { status: 503 }
    )
  }

  try {
    if (type === 'coord') {
      // 주소 → 좌표 변환 (지번주소 우선)
      const address = searchParams.get('address') ?? ''
      const url =
        `https://api.vworld.kr/req/address` +
        `?service=address&request=getcoord&version=2.0` +
        `&crs=epsg:4326&address=${encodeURIComponent(address)}` +
        `&refine=true&simple=false&format=json&type=parcel&key=${apiKey}`
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json()
      return NextResponse.json(data)
    }

    if (type === 'tile') {
      // VWorld WMTS 위성사진 타일 프록시 (CORS 우회)
      // URL 형식: /req/wmts/1.0.0/{key}/Satellite/{z}/{y}/{x}.jpeg
      const z = searchParams.get('z')
      const x = searchParams.get('x')
      const y = searchParams.get('y')
      if (!z || !x || !y) return NextResponse.json({ error: 'z,x,y required' }, { status: 400 })
      const tileUrl = `https://api.vworld.kr/req/wmts/1.0.0/${apiKey}/Satellite/${z}/${y}/${x}.jpeg`
      const tileRes = await fetch(tileUrl, { cache: 'no-store' })
      if (!tileRes.ok) return new Response(null, { status: 404 })
      const buf = await tileRes.arrayBuffer()
      return new Response(buf, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    if (type === 'parcel') {
      // 좌표 → 필지 경계 폴리곤 (LP_PA_CBND_BUBUN: 분부번 경계)
      const lon = searchParams.get('lon') ?? ''
      const lat = searchParams.get('lat') ?? ''
      const url =
        `https://api.vworld.kr/req/data` +
        `?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN` +
        `&key=${apiKey}&format=json&geometry=true&attribute=true` +
        `&crs=epsg:4326&page=1&size=1` +
        `&geomFilter=POINT(${lon}%20${lat})`
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json()
      return NextResponse.json(data)
    }

    return NextResponse.json({ error: 'invalid type' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'VWorld API request failed' }, { status: 500 })
  }
}
