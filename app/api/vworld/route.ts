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
      // 주소 → 좌표 변환
      // 순서: 1) parcel  2) road  3) parcel without province prefix
      const address = searchParams.get('address') ?? ''
      const base =
        `https://api.vworld.kr/req/address` +
        `?service=address&request=getcoord&version=2.0` +
        `&crs=epsg:4326&address=${encodeURIComponent(address)}` +
        `&refine=true&simple=false&format=json&key=${apiKey}`

      // 1차: 지번주소(parcel)
      const parcelRes = await fetch(base + '&type=parcel', { cache: 'no-store' })
      if (parcelRes.ok) {
        const parcelData = await parcelRes.json()
        if (parcelData?.response?.result?.point) {
          return NextResponse.json(parcelData)
        }
      }

      // 2차: 도로명주소(road)
      const roadRes = await fetch(base + '&type=road', { cache: 'no-store' })
      if (roadRes.ok) {
        const roadData = await roadRes.json()
        if (roadData?.response?.result?.point) {
          return NextResponse.json(roadData)
        }
      }

      // 3차: 첫 번째 단어(도/광역시) 제거 후 재시도 (예: '경기도 수원시...' → '수원시...')
      const shortAddress = address.includes(' ') ? address.slice(address.indexOf(' ') + 1) : address
      if (shortAddress !== address) {
        const base3 =
          `https://api.vworld.kr/req/address` +
          `?service=address&request=getcoord&version=2.0` +
          `&crs=epsg:4326&address=${encodeURIComponent(shortAddress)}` +
          `&refine=true&simple=false&format=json&key=${apiKey}`
        const res3 = await fetch(base3 + '&type=parcel', { cache: 'no-store' })
        if (res3.ok) {
          const data3 = await res3.json()
          if (data3?.response?.result?.point) {
            return NextResponse.json(data3)
          }
        }
      }

      // 모두 실패: 마지막 road 응답 반환 (클라이언트가 status 확인)
      const fallbackRes = await fetch(base + '&type=road', { cache: 'no-store' })
      const fallbackData = await fallbackRes.json()
      return NextResponse.json(fallbackData)
    }

    if (type === 'tile') {
      // VWorld WMTS 위성사진 타일 프록시 (CORS 우회)
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: 'VWorld API request failed: ' + msg }, { status: 500 })
  }
}
