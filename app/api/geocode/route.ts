import { NextRequest, NextResponse } from 'next/server'

// VWorld 통합 지오코더 — 주소 → (좌표 + PNU + 필지)
// Edge Runtime + 인천 PoP 강제 → VWorld 한국 IP 정책 안정 우회
export const runtime = 'edge'
export const preferredRegion = 'icn1'  // Seoul/Incheon (Vercel Edge region)

interface ParcelInfo {
  ring: number[][]      // [[lon, lat], ...]
  areaSqm: number
  label: string
  pnu?: string
  jimok?: string
}

interface GeocodeResponse {
  lat: number
  lng: number
  pnu?: string
  parcel: ParcelInfo | null
  source: 'vworld'
}

const MPD_LAT = 111319.9

function shoelaceAreaSqm(ring: number[][]): number {
  const lat0 = ring.reduce((s, c) => s + c[1], 0) / ring.length
  const lon0 = ring.reduce((s, c) => s + c[0], 0) / ring.length
  const mpdLon = MPD_LAT * Math.cos((lat0 * Math.PI) / 180)
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = (ring[i][0] - lon0) * mpdLon
    const yi = (ring[i][1] - lat0) * MPD_LAT
    const xj = (ring[j][0] - lon0) * mpdLon
    const yj = (ring[j][1] - lat0) * MPD_LAT
    area += xi * yj - xj * yi
  }
  return Math.abs(area / 2)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = (searchParams.get('address') ?? '').trim()
  const apiKey = process.env.VWORLD_API_KEY

  if (!address) {
    return NextResponse.json({ error: 'address required' }, { status: 400 })
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'VWORLD_API_KEY not configured' }, { status: 503 })
  }

  // VWorld는 등록된 도메인 Referer 필요
  const reqHost = req.headers.get('host') ?? ''
  const proto = reqHost.includes('localhost') ? 'http' : 'https'
  const siteOrigin = `${proto}://${reqHost}`
  const vwHeaders = {
    Referer: siteOrigin + '/',
    Origin: siteOrigin,
    'User-Agent': 'Mozilla/5.0 (compatible; SolarAdvisor/1.0)',
  }
  // Edge Runtime fetch에 명시적 timeout — outbound 무한 대기 시
  // "Network connection lost" 에러 회피
  const vwFetch = async (url: string, timeoutMs = 8000) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await fetch(url, { cache: 'no-store', headers: vwHeaders, signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  }

  try {
    // ── Step 1: 주소 → 좌표 ────────────────────────────────────
    // 1차: 지번주소(parcel) → 2차: 도로명주소(road) → 3차: 시군구 단축
    const coordBase =
      `https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0` +
      `&crs=epsg:4326&refine=true&simple=false&format=json&key=${apiKey}` +
      `&address=${encodeURIComponent(address)}`

    let lat = NaN
    let lng = NaN

    const tryCoord = async (url: string) => {
      const r = await vwFetch(url)
      if (!r.ok) return false
      const ct = r.headers.get('content-type') ?? ''
      if (!ct.includes('json')) return false
      const d = await r.json()
      const point = d?.response?.result?.point
      if (!point) return false
      const x = parseFloat(point.x)
      const y = parseFloat(point.y)
      if (Number.isNaN(x) || Number.isNaN(y)) return false
      lng = x; lat = y
      return true
    }

    if (!(await tryCoord(coordBase + '&type=parcel'))) {
      if (!(await tryCoord(coordBase + '&type=road'))) {
        // 시·도 제거 후 재시도 (예: "경상남도 진주시 ..." → "진주시 ...")
        const short = address.includes(' ') ? address.slice(address.indexOf(' ') + 1) : address
        if (short !== address) {
          const shortBase =
            `https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0` +
            `&crs=epsg:4326&refine=true&simple=false&format=json&key=${apiKey}` +
            `&address=${encodeURIComponent(short)}`
          await tryCoord(shortBase + '&type=parcel')
        }
      }
    }

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return NextResponse.json(
        { error: '주소를 찾을 수 없습니다 (VWorld 응답 없음)' },
        { status: 404 },
      )
    }

    // ── Step 2: 좌표 → 필지 (LP_PA_CBND_BUBUN) ─────────────────
    const parcelUrl =
      `https://api.vworld.kr/req/data?service=data&request=GetFeature` +
      `&data=LP_PA_CBND_BUBUN&key=${apiKey}&format=json&geometry=true&attribute=true` +
      `&crs=epsg:4326&page=1&size=1` +
      `&geomFilter=POINT(${lng}%20${lat})`

    let parcel: ParcelInfo | null = null
    const parcelRes = await vwFetch(parcelUrl)
    const parcelCt = parcelRes.headers.get('content-type') ?? ''
    if (parcelRes.ok && parcelCt.includes('json')) {
      const d = await parcelRes.json()
      const feature = d?.response?.result?.featureCollection?.features?.[0]
      if (feature?.geometry) {
        let ring: number[][] = []
        if (feature.geometry.type === 'Polygon' && feature.geometry.coordinates?.[0]) {
          ring = feature.geometry.coordinates[0]
        } else if (
          feature.geometry.type === 'MultiPolygon' &&
          feature.geometry.coordinates?.[0]?.[0]
        ) {
          ring = feature.geometry.coordinates[0][0]
        }
        if (ring.length >= 3) {
          const closed =
            ring[0][0] === ring[ring.length - 1][0] &&
            ring[0][1] === ring[ring.length - 1][1]
          const cleanRing = closed ? ring.slice(0, -1) : ring
          const props = feature.properties ?? {}
          const pnu: string | undefined = props.pnu ?? props.PNU ?? undefined
          const jimok: string | undefined =
            props.jimok ?? props.JIMOK ?? props.LDC ?? props.ldc ?? undefined
          const label =
            [props.EMD_NM, props.RI_NM, props.JIBUN].filter(Boolean).join(' ') ||
            `${lat.toFixed(4)}, ${lng.toFixed(4)}`
          parcel = {
            ring: cleanRing,
            areaSqm: shoelaceAreaSqm(cleanRing),
            label,
            pnu,
            jimok,
          }
        }
      }
    }

    const body: GeocodeResponse = {
      lat,
      lng,
      pnu: parcel?.pnu,
      parcel,
      source: 'vworld',
    }
    return NextResponse.json(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    const isAbort = err instanceof Error && err.name === 'AbortError'
    const friendly = isAbort
      ? 'VWorld 응답 지연 (8초 초과) — 잠시 후 다시 시도하세요'
      : msg.toLowerCase().includes('network')
      ? 'VWorld 네트워크 연결 실패 — VPN 또는 프로덕션 도메인 등록 확인'
      : 'VWorld 통합 지오코더 실패: ' + msg
    return NextResponse.json({ error: friendly, _raw: msg }, { status: 502 })
  }
}
