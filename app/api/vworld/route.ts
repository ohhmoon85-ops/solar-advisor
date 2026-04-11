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

  // VWorld API는 등록된 도메인의 Referer/Origin 헤더가 필요
  const reqHost = req.headers.get('host') ?? ''
  const proto = reqHost.includes('localhost') ? 'http' : 'https'
  const siteOrigin = `${proto}://${reqHost}`
  const vwHeaders = {
    'Referer': siteOrigin + '/',
    'Origin': siteOrigin,
    'User-Agent': 'Mozilla/5.0 (compatible; SolarAdvisor/1.0)',
  }

  const vwFetch = (url: string) =>
    fetch(url, { cache: 'no-store', headers: vwHeaders })

  try {
    if (type === 'coord') {
      const address = searchParams.get('address') ?? ''
      const base =
        `https://api.vworld.kr/req/address` +
        `?service=address&request=getcoord&version=2.0` +
        `&crs=epsg:4326&address=${encodeURIComponent(address)}` +
        `&refine=true&simple=false&format=json&key=${apiKey}`

      // 1차: 지번주소(parcel)
      const parcelRes = await vwFetch(base + '&type=parcel')
      if (parcelRes.ok) {
        const parcelData = await parcelRes.json()
        if (parcelData?.response?.result?.point) {
          return NextResponse.json(parcelData)
        }
      }

      // 2차: 도로명주소(road)
      const roadRes = await vwFetch(base + '&type=road')
      if (roadRes.ok) {
        const roadData = await roadRes.json()
        if (roadData?.response?.result?.point) {
          return NextResponse.json(roadData)
        }
      }

      // 3차: 시/군/구부터 시작 (도/광역시 제거)
      const shortAddress = address.includes(' ') ? address.slice(address.indexOf(' ') + 1) : address
      if (shortAddress !== address) {
        const base3 =
          `https://api.vworld.kr/req/address` +
          `?service=address&request=getcoord&version=2.0` +
          `&crs=epsg:4326&address=${encodeURIComponent(shortAddress)}` +
          `&refine=true&simple=false&format=json&key=${apiKey}`
        const res3 = await vwFetch(base3 + '&type=parcel')
        if (res3.ok) {
          const data3 = await res3.json()
          if (data3?.response?.result?.point) {
            return NextResponse.json(data3)
          }
        }
      }

      // 모두 실패: 마지막 road 응답 반환
      const fallbackRes = await vwFetch(base + '&type=road')
      const fallbackCt = fallbackRes.headers.get('content-type') ?? ''
      if (!fallbackCt.includes('json')) {
        return NextResponse.json({ response: { status: 'NOT_FOUND', error: 'VWorld non-JSON response' } })
      }
      const fallbackData = await fallbackRes.json()
      return NextResponse.json(fallbackData)
    }

    if (type === 'tile') {
      const z = searchParams.get('z')
      const x = searchParams.get('x')
      const y = searchParams.get('y')
      if (!z || !x || !y) return NextResponse.json({ error: 'z,x,y required' }, { status: 400 })
      // ArcGIS World Imagery (API키 불필요, 전세계 고해상도 위성사진)
      const tileUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
      const tileRes = await fetch(tileUrl, { cache: 'no-store' })
      if (!tileRes.ok) return new Response(null, { status: 404 })
      const buf = await tileRes.arrayBuffer()
      const ct = tileRes.headers.get('content-type') ?? 'image/jpeg'
      return new Response(buf, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    if (type === 'parcel') {
      const lon = searchParams.get('lon') ?? ''
      const lat = searchParams.get('lat') ?? ''
      const url =
        `https://api.vworld.kr/req/data` +
        `?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN` +
        `&key=${apiKey}&format=json&geometry=true&attribute=true` +
        `&crs=epsg:4326&page=1&size=1` +
        `&geomFilter=POINT(${lon}%20${lat})`
      const res = await vwFetch(url)
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) {
        return NextResponse.json({ response: { status: 'ERROR', result: null } })
      }
      const data = await res.json()
      return NextResponse.json(data)
    }

    if (type === 'elevation') {
      // 중심 + 상하좌우 20m 지점 5개 고도 조회 → 경사도 계산
      const lon = parseFloat(searchParams.get('lon') ?? '0')
      const lat = parseFloat(searchParams.get('lat') ?? '0')
      const dLat = 20 / 111319.9
      const dLon = 20 / (111319.9 * Math.cos(lat * Math.PI / 180))
      const pts = [
        [lon, lat],
        [lon, lat + dLat],
        [lon, lat - dLat],
        [lon + dLon, lat],
        [lon - dLon, lat],
      ]
      const getElev = async (lo: number, la: number): Promise<number | null> => {
        const url = `https://api.vworld.kr/req/dem?service=dem&request=getElevation&version=2.0&crs=epsg:4326&key=${apiKey}&format=json&point=${lo},${la}`
        try {
          const r = await vwFetch(url)
          if (!r.ok) return null
          const ct = r.headers.get('content-type') ?? ''
          if (!ct.includes('json')) return null
          const d = await r.json()
          const h = d?.response?.result?.height ?? d?.response?.result?.elevation
          return h != null ? parseFloat(h) : null
        } catch { return null }
      }
      const elevs = await Promise.all(pts.map(([lo, la]) => getElev(lo, la)))
      const [hC, hN, hS, hE, hW] = elevs
      if (hC == null || hN == null || hS == null || hE == null || hW == null) {
        return NextResponse.json({ error: 'elevation data unavailable', fallback: true }, { status: 503 })
      }
      const slopeNS = Math.abs(hN - hS) / 40   // m/m
      const slopeEW = Math.abs(hE - hW) / 40   // m/m
      const slopePct = Math.round(Math.sqrt(slopeNS ** 2 + slopeEW ** 2) * 100)
      return NextResponse.json({ slope: slopePct, elevations: { center: hC, N: hN, S: hS, E: hE, W: hW } })
    }

    return NextResponse.json({ error: 'invalid type' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: 'VWorld API request failed: ' + msg }, { status: 500 })
  }
}
