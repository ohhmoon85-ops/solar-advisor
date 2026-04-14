// lib/cadastre.ts — 지번 주소 → 필지 폴리곤 클라이언트 유틸리티 (v5.2)
// 기존 /api/vworld route(coord/parcel 타입)를 호출하는 클라이언트 래퍼
// v5.2: jimok(지목) 자동 추출, jimokToPlotType, getJimokChangeImpact 추가

import type { Polygon, Point, PlotType } from './layoutEngine'

// ── 타입 ───────────────────────────────────────────────────────────

export interface CadastreResult {
  latitude: number
  longitude: number
  /** 지리 미터 로컬 좌표 폴리곤 (layoutEngine에 바로 전달 가능) */
  localPolygon: Polygon
  /** 원본 경위도 링 [[lon, lat], ...] */
  geoRing: number[][]
  plotAreaM2: number
  address: string
  /** v5.2: V-World feature 지목 코드 (예: '전', '답', '대', '임야') */
  jimok?: string
  /** v5.2: 지목 한글 라벨 */
  jimokLabel?: string
  /** v5.2: 지목 기반 권장 PlotType */
  suggestedPlotType?: PlotType
}

// ── 좌표 변환 ──────────────────────────────────────────────────────

const MPD_LAT = 111319.9  // 위도 1° ≈ m

function mpdLon(lat: number): number {
  return MPD_LAT * Math.cos((lat * Math.PI) / 180)
}

/**
 * 경위도 링 → 로컬 미터 폴리곤 변환
 * Equirectangular 근사: 위도 1° ≈ 111,319.9m, 경도 1° ≈ 111,319.9 × cos(lat) m
 * @param ring [[lon, lat], ...] 형식의 경위도 좌표 배열
 * @param centerLat 기준 위도
 * @param centerLon 기준 경도
 */
export function convertGeoRingToLocalPolygon(
  ring: number[][],
  centerLat: number,
  centerLon: number
): Polygon {
  return ring.map(([lon, lat]) => ({
    x: (lon - centerLon) * mpdLon(centerLat),
    y: (lat - centerLat) * MPD_LAT,
  }))
}

/**
 * 로컬 미터 폴리곤 → 경위도 링 역변환
 */
export function convertLocalPolygonToGeoRing(
  polygon: Polygon,
  centerLat: number,
  centerLon: number
): number[][] {
  return polygon.map(p => [
    centerLon + p.x / mpdLon(centerLat),
    centerLat + p.y / MPD_LAT,
  ])
}

// ── 지목 코드 처리 ─────────────────────────────────────────────────

/**
 * 지목 코드 → PlotType 변환
 * V-World feature.properties.jimok 값 기준
 */
export function jimokToPlotType(jimokLabel: string): PlotType {
  const label = jimokLabel.trim()

  // 지붕형 (건물 지목)
  if (['대', '공장용지', '학교용지', '주차장', '주유소용지', '창고용지'].includes(label)) {
    return 'roof'
  }
  // 임야
  if (['임야'].includes(label)) {
    return 'forest'
  }
  // 농지 (전·답·과수원)
  if (['전', '답', '과수원', '목장용지'].includes(label)) {
    return 'farmland'
  }
  // 나머지 (잡종지, 구거, 도로 등)
  return 'land'
}

/**
 * 현재 지목 → 목표 용도 전환 시 영향 설명
 * @param currentJimok 현재 지목 (예: '전', '임야')
 * @param targetJimok 목표 지목 (예: '잡종지')
 * @returns 전환 영향 설명 문자열
 */
export function getJimokChangeImpact(
  currentJimok: string,
  targetJimok: string
): string {
  const farmlands = ['전', '답', '과수원', '목장용지']
  const isFarmToDevelopment = farmlands.includes(currentJimok) &&
    ['잡종지', '대', '공장용지'].includes(targetJimok)
  const isForestToDevelopment = currentJimok === '임야' &&
    ['잡종지', '대'].includes(targetJimok)

  if (isFarmToDevelopment) {
    return `농지(${currentJimok}) → ${targetJimok} 전환: 농지전용허가 필요. 전용부담금 발생. 심사 기간 3~6개월. 마진 1.5m 적용 권장.`
  }
  if (isForestToDevelopment) {
    return `임야(${currentJimok}) → ${targetJimok} 전환: 산지전용허가 필요. 대체산림자원조성비 부과. 심사 기간 6~12개월.`
  }
  if (currentJimok === targetJimok) {
    return `지목변경 불필요 (현재 ${currentJimok})`
  }
  return `${currentJimok} → ${targetJimok} 전환: 지목변경 신청 필요. 관할 시·군·구청 확인 바람.`
}

// ── API 호출 ───────────────────────────────────────────────────────

/**
 * V-World API(기존 /api/vworld)를 통해 좌표 조회
 * @throws 주소를 찾을 수 없는 경우 Error
 */
async function fetchCoordinates(address: string): Promise<{ lat: number; lon: number }> {
  const res = await fetch(`/api/vworld?type=coord&address=${encodeURIComponent(address)}`)
  if (!res.ok) throw new Error(`VWorld coord API error: ${res.status}`)
  const data = await res.json()
  const point = data?.response?.result?.point
  if (!point) throw new Error('주소를 찾을 수 없습니다')
  return {
    lon: parseFloat(point.x),
    lat: parseFloat(point.y),
  }
}

/**
 * V-World API를 통해 필지 경계 폴리곤 GeoJSON 조회
 * v5.2: jimok 필드 추출 추가
 * @returns GeoJSON 피처 정보 또는 null
 */
async function fetchParcelGeoJson(
  lat: number,
  lon: number
): Promise<{ ring: number[][]; areaSqm: number; jimok?: string; jimokLabel?: string } | null> {
  const res = await fetch(`/api/vworld?type=parcel&lat=${lat}&lon=${lon}`)
  if (!res.ok) return null
  const data = await res.json()

  const feature = data?.response?.result?.featureCollection?.features?.[0]
  if (!feature) return null

  const geom = feature.geometry
  if (!geom) return null

  // Polygon 또는 MultiPolygon 처리
  let ring: number[][] = []
  if (geom.type === 'Polygon' && geom.coordinates?.[0]) {
    ring = geom.coordinates[0]
  } else if (geom.type === 'MultiPolygon' && geom.coordinates?.[0]?.[0]) {
    ring = geom.coordinates[0][0]
  }
  if (ring.length < 3) return null

  // v5.2: 지목 코드 추출 (V-World feature properties)
  const props = feature.properties ?? {}
  // V-World 필지 레이어의 지목 필드: 'jimok' 또는 'JIMOK' 또는 'LDC'
  const jimokRaw: string | undefined =
    props.jimok ?? props.JIMOK ?? props.LDC ?? props.ldc ?? undefined
  const jimokLabel = jimokRaw ? String(jimokRaw).trim() : undefined

  // 면적: 슈 공식으로 계산
  const lat0 = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length
  const lon0 = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = (ring[i][0] - lon0) * mpdLon(lat0)
    const yi = (ring[i][1] - lat0) * MPD_LAT
    const xj = (ring[j][0] - lon0) * mpdLon(lat0)
    const yj = (ring[j][1] - lat0) * MPD_LAT
    area += xi * yj - xj * yi
  }
  const areaSqm = Math.abs(area / 2)

  return { ring, areaSqm, jimok: jimokLabel, jimokLabel }
}

/**
 * 주소 → CadastreResult 변환 (전체 파이프라인)
 * 내부적으로 /api/vworld (coord, parcel) 를 순차 호출
 * v5.2: jimok, suggestedPlotType 포함
 * @param address 지번 또는 도로명 주소
 * @throws 주소 미발견 또는 API 오류 시 Error
 */
export async function fetchCadastreByAddress(address: string): Promise<CadastreResult> {
  // 1. 좌표 조회
  const { lat, lon } = await fetchCoordinates(address)

  // 2. 필지 폴리곤 조회
  const parcelData = await fetchParcelGeoJson(lat, lon)

  if (!parcelData || parcelData.ring.length < 3) {
    throw new Error(
      '지번 경계를 조회할 수 없습니다. 직접 부지 면적(m²)을 입력해 주세요.'
    )
  }

  const { ring, areaSqm, jimok, jimokLabel } = parcelData
  const localPolygon = convertGeoRingToLocalPolygon(ring, lat, lon)
  const suggestedPlotType = jimokLabel ? jimokToPlotType(jimokLabel) : 'land'

  return {
    latitude: lat,
    longitude: lon,
    localPolygon,
    geoRing: ring,
    plotAreaM2: areaSqm,
    address,
    jimok,
    jimokLabel,
    suggestedPlotType,
  }
}

/**
 * 직접 면적 입력 → 정사각형 근사 폴리곤 생성 (V-World API 실패 시 폴백)
 */
export function createSquarePolygonFromArea(
  lat: number,
  lon: number,
  areaM2: number
): CadastreResult {
  const side = Math.sqrt(areaM2)
  const halfX = side / 2
  const halfY = side / 2
  const localPolygon: Polygon = [
    { x: -halfX, y: -halfY },
    { x:  halfX, y: -halfY },
    { x:  halfX, y:  halfY },
    { x: -halfX, y:  halfY },
  ]
  return {
    latitude: lat,
    longitude: lon,
    localPolygon,
    geoRing: [],
    plotAreaM2: areaM2,
    address: `직접입력 (${areaM2.toLocaleString()}m²)`,
    suggestedPlotType: 'land',
  }
}
