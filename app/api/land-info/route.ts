import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

const VW = 'https://api.vworld.kr'

const JIMOK_MAP: Record<string, string> = {
  '01': '전', '02': '답', '03': '과수원', '04': '목장용지', '05': '임야',
  '06': '광천지', '07': '염전', '08': '대', '09': '공장용지', '10': '학교용지',
  '11': '주차장', '12': '주유소용지', '13': '창고용지', '14': '도로',
  '15': '철도용지', '16': '제방', '17': '하천', '18': '구거', '19': '유지',
  '20': '양어장', '21': '수도용지', '22': '공원', '23': '체육용지',
  '24': '유원지', '25': '종교용지', '26': '사적지', '27': '묘지', '28': '잡종지',
}

function resolveJimok(cd: string, nm: string): string {
  if (nm) return nm
  return JIMOK_MAP[cd] ?? cd
}

function determineCanInstall(
  zoneDetail: string,
  jimokName: string,
): 'possible' | 'conditional' | 'impossible' {
  if (/자연환경보전|상수원보호|수변구역|군사|문화재보호/.test(zoneDetail)) return 'impossible'
  if (/보전관리|절대농지/.test(zoneDetail)) return 'impossible'
  if (/농림|생산관리|보전녹지|생산녹지/.test(zoneDetail)) return 'conditional'
  if (/전|답|과수원|목장/.test(jimokName) && !/계획관리|자연녹지/.test(zoneDetail)) return 'conditional'
  if (/임야|산지/.test(jimokName) && !/계획관리|자연녹지/.test(zoneDetail)) return 'conditional'
  return 'possible'
}

function buildRestrictions(zoneDetail: string, jimokName: string): string[] {
  const r: string[] = []
  if (/전|답|과수원|목장/.test(jimokName)) r.push('농지법 적용 (농지전용허가 필요)')
  if (/임야/.test(jimokName)) r.push('산지관리법 적용 (산지전용허가 필요)')
  if (/군사/.test(zoneDetail)) r.push('군사기지 및 군사시설 보호법')
  if (/상수원보호|수변구역/.test(zoneDetail)) r.push('수도법 / 수변구역 규제')
  if (/문화재/.test(zoneDetail)) r.push('문화재보호법 적용')
  return r
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  const qLon = searchParams.get('lon')
  const qLat = searchParams.get('lat')

  const apiKey = process.env.VWORLD_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'VWORLD_API_KEY not configured' }, { status: 503 })
  }

  const reqHost = req.headers.get('host') ?? ''
  const proto = reqHost.includes('localhost') ? 'http' : 'https'
  const origin = `${proto}://${reqHost}`
  const vwHeaders = {
    Referer: origin + '/',
    Origin: origin,
    'User-Agent': 'Mozilla/5.0 (compatible; SolarAdvisor/1.0)',
  }
  const vwFetch = (url: string) => fetch(url, { cache: 'no-store', headers: vwHeaders })

  let lon: string
  let lat: string

  try {
    if (qLon && qLat) {
      lon = qLon
      lat = qLat
    } else if (address) {
      const coordUrl =
        `${VW}/req/address?service=address&request=getcoord&version=2.0` +
        `&crs=epsg:4326&type=parcel&refine=true&simple=false&format=json` +
        `&key=${apiKey}&address=${encodeURIComponent(address)}`
      const coordRes = await vwFetch(coordUrl)
      if (!coordRes.ok) throw new Error('VWorld address lookup failed')
      const coordData = await coordRes.json()
      const pt = coordData?.response?.result?.point
      if (!pt?.x || !pt?.y) throw new Error('Address not found: ' + address)
      lon = pt.x
      lat = pt.y
    } else {
      return NextResponse.json({ error: 'address or lon/lat required' }, { status: 400 })
    }

    // Parcel data (jimok)
    const parcelUrl =
      `${VW}/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN` +
      `&key=${apiKey}&format=json&geometry=false&attribute=true` +
      `&crs=epsg:4326&page=1&size=1&geomFilter=POINT(${lon}%20${lat})`
    const [parcelRes, zoneRes] = await Promise.all([
      vwFetch(parcelUrl),
      vwFetch(
        `${VW}/req/data?service=data&request=GetFeature&data=LT_C_UQ111` +
        `&key=${apiKey}&format=json&geometry=false&attribute=true` +
        `&crs=epsg:4326&page=1&size=1&geomFilter=POINT(${lon}%20${lat})`
      ),
    ])

    const parcelData = parcelRes.ok ? await parcelRes.json() : null
    const zoneData = zoneRes.ok ? await zoneRes.json() : null

    const parcelAttr =
      parcelData?.response?.result?.featureCollection?.features?.[0]?.properties ?? {}
    const zoneAttr =
      zoneData?.response?.result?.featureCollection?.features?.[0]?.properties ?? {}

    const jimokCd: string = parcelAttr.JIMOK_CD ?? parcelAttr.jimok_cd ?? ''
    const jimokNm: string = parcelAttr.JIMOK_NM ?? parcelAttr.jimok_nm ?? ''
    const jimok = resolveJimok(jimokCd, jimokNm)
    const pnu: string = parcelAttr.PNU ?? parcelAttr.pnu ?? ''
    const jibun: string = parcelAttr.JIBUN ?? parcelAttr.jibun ?? ''

    const zoneDetail: string =
      zoneAttr.UQ111_COL_NAME ?? zoneAttr.COL_ADM_SECT_NM ?? zoneAttr.ZONE_NM ?? zoneAttr.zone_nm ?? ''
    const zoneCode: string =
      zoneAttr.UQ111_COL_COD ?? zoneAttr.COL_ADM_SECT_CD ?? zoneAttr.ZONE_CD ?? zoneAttr.zone_cd ?? ''

    const canInstall = determineCanInstall(zoneDetail, jimok)
    const restrictions = buildRestrictions(zoneDetail, jimok)

    return NextResponse.json({
      lon,
      lat,
      pnu,
      jibun,
      jimok,
      zoneCode,
      zoneDetail,
      canInstall,
      restrictions,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    )
  }
}