'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useSolarStore } from '@/store/useStore'
import type { FullAnalysisResult } from '@/lib/layoutEngine'
import type { MultiZoneResult, ZoneLayoutResult } from '@/lib/multiZoneLayout'
import { isMultiZoneResult } from '@/lib/multiZoneLayout'
import { exportDXF } from '@/lib/dxfExport'

// ── Paper size configs ────────────────────────────────────────────
type PaperSize = 'A3L' | 'A4L' | 'A4P'
interface PaperCfg {
  svgW: number; svgH: number
  pdfW: number; pdfH: number
  pdfOrient: 'landscape' | 'portrait'; pdfFormat: 'a3' | 'a4'
  tbW: number; label: string
}
const PAPER: Record<PaperSize, PaperCfg> = {
  A3L: { svgW: 1120, svgH: 794, pdfW: 420, pdfH: 297, pdfOrient: 'landscape', pdfFormat: 'a3', tbW: 200, label: 'A3 가로 (420×297mm)' },
  A4L: { svgW: 794,  svgH: 561, pdfW: 297, pdfH: 210, pdfOrient: 'landscape', pdfFormat: 'a4', tbW: 160, label: 'A4 가로 (297×210mm)' },
  A4P: { svgW: 561,  svgH: 794, pdfW: 210, pdfH: 297, pdfOrient: 'portrait',  pdfFormat: 'a4', tbW: 160, label: 'A4 세로 (210×297mm)' },
}

// ── Layout constants ──────────────────────────────────────────────
const NUM_ROWS = 13
const STANDARD_SCALES = [50, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 3000, 5000]
const NICE_BAR_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
const FONT = 'Malgun Gothic, Apple SD Gothic Neo, NanumGothic, sans-serif'

// ── Coordinate types ──────────────────────────────────────────────
interface Pt { x: number; y: number }
interface VBox { minX: number; minY: number; rangeX: number; rangeY: number }

// ── Module-level utilities ────────────────────────────────────────
function buildVBox(pts: Pt[], w: number, h: number, pad = 0.10): VBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const dX = maxX - minX || 1, dY = maxY - minY || 1
  const scale = Math.min(w / (dX * (1 + pad * 2)), h / (dY * (1 + pad * 2)))
  const rangeX = w / scale, rangeY = h / scale
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  return { minX: cx - rangeX / 2, minY: cy - rangeY / 2, rangeX, rangeY }
}

function polyCentroid(poly: Pt[]): Pt {
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  }
}

function selectScale(rangeX: number, drawWMM: number): number {
  const raw = (rangeX * 1000) / drawWMM
  return STANDARD_SCALES.find(s => s >= raw) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1]
}

function niceBarM(rangeX: number): number {
  const target = rangeX * 0.18
  return NICE_BAR_M.reduce((best, v) => Math.abs(v - target) < Math.abs(best - target) ? v : best)
}

function genDrawingNumber(): string {
  if (typeof window === 'undefined') return 'SA-00000000-001'
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  try {
    const raw = localStorage.getItem('solar_drawing_counter')
    const data: { date: string; count: number } = raw ? JSON.parse(raw) : { date: '', count: 0 }
    const count = data.date === today ? data.count + 1 : 1
    localStorage.setItem('solar_drawing_counter', JSON.stringify({ date: today, count }))
    return `SA-${today}-${String(count).padStart(3, '0')}`
  } catch {
    return `SA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-001`
  }
}

function isZoneResult(z: FullAnalysisResult): z is ZoneLayoutResult {
  return 'zoneLabel' in z
}

// ── Component ─────────────────────────────────────────────────────
export default function DrawingTab() {
  const svgRef = useRef<SVGSVGElement>(null)
  const [paperSize, setPaperSize] = useState<PaperSize>('A3L')
  const [authorName, setAuthorName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [exporting, setExporting] = useState<'pdf' | null>(null)
  const [drawingNumber] = useState(genDrawingNumber)
  const { lastFullAnalysisJson, lastAnalysisAddress, mapResult, setActiveTab, lastGeoOrigin } = useSolarStore()

  // Load saved form values from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem('solar_drawing_meta')
      if (raw) {
        const { author = '', company = '', project = '' } = JSON.parse(raw)
        setAuthorName(author)
        setCompanyName(company)
        setProjectName(project)
      }
    } catch { /* ignore */ }
  }, [])

  // 600ms debounce 자동 저장
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSave = useCallback((author: string, company: string, project: string) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem('solar_drawing_meta', JSON.stringify({ author, company, project }))
      } catch { /* ignore */ }
    }, 600)
  }, [])

  // Parse analysis result — collect ALL zones
  let zones: FullAnalysisResult[] = []
  if (lastFullAnalysisJson) {
    try {
      const parsed = JSON.parse(lastFullAnalysisJson)
      if (isMultiZoneResult(parsed as FullAnalysisResult | MultiZoneResult)) {
        zones = (parsed as MultiZoneResult).zones
      } else {
        zones = [parsed as FullAnalysisResult]
      }
    } catch { /* ignore */ }
  }

  // Empty state
  if (zones.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-6xl mb-5">📐</div>
        <h2 className="text-xl font-bold text-gray-700 mb-2">정밀 분석 결과가 없습니다</h2>
        <p className="text-gray-500 text-sm mb-6">지도 탭에서 부지를 선택하고 정밀 분석을 실행한 후 돌아오세요.</p>
        <button onClick={() => setActiveTab('map')}
          className="px-5 py-2.5 bg-blue-500 text-white rounded-xl font-medium hover:bg-blue-600 transition-colors">
          🗺️ 지도 탭으로 이동
        </button>
      </div>
    )
  }

  // ── Paper dimensions ──────────────────────────────────────────
  const cfg = PAPER[paperSize]
  const svgW = cfg.svgW, svgH = cfg.svgH, tbW = cfg.tbW
  const drawW = svgW - tbW, drawH = svgH
  const tbHeaderH = Math.round(svgH * 0.065)
  const legendH = Math.round(svgH * 0.111)
  const dataH = svgH - tbHeaderH - legendH
  const tbRowH = dataH / NUM_ROWS
  const drawWMM = cfg.pdfW - (tbW / svgW) * cfg.pdfW

  // ── Coordinate transform helpers (capture drawW/drawH/vb) ─────
  // Collect all points across all zones for unified viewbox
  const allPts: Pt[] = zones.flatMap(z => [
    ...z.safeZone.originalPolygon,
    ...(z.safeZone.safeZonePolygon ?? []),
    ...z.layout.placements.flatMap(p => [...p.corners]),
  ])
  const vb = buildVBox(allPts, drawW, drawH)

  const toPts = (poly: Pt[]): string =>
    poly.map(p => {
      const x = ((p.x - vb.minX) / vb.rangeX) * drawW
      const y = drawH - ((p.y - vb.minY) / vb.rangeY) * drawH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')

  const toXY = (p: Pt): [number, number] => [
    ((p.x - vb.minX) / vb.rangeX) * drawW,
    drawH - ((p.y - vb.minY) / vb.rangeY) * drawH,
  ]

  // ── 위성지도 배경 타일 계산 ─────────────────────────────────────
  // ENU 좌표(m) ↔ WGS84 변환 (lastGeoOrigin 기준)
  const MPD_LAT_DT = 111319.9
  interface SatTileDT { src: string; x: number; y: number; w: number; h: number }
  const satTilesDT: SatTileDT[] = (() => {
    if (!lastGeoOrigin) return []
    const { lat: oLat, lon: oLon } = lastGeoOrigin
    const mpdLonDT = MPD_LAT_DT * Math.cos(oLat * Math.PI / 180)
    // ENU → WGS84
    const enuToGeo = (x: number, y: number) => ({
      lon: oLon + x / mpdLonDT,
      lat: oLat + y / MPD_LAT_DT,
    })
    // WGS84 → 타일 좌표
    const lonLatToTileDT = (lon: number, lat: number, z: number) => {
      const n = Math.pow(2, z)
      const tx = Math.floor((lon + 180) / 360 * n)
      const lr = lat * Math.PI / 180
      const ty = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n)
      return { tx, ty }
    }
    // 타일 북서 모서리 WGS84
    const tileOriginDT = (tx: number, ty: number, z: number) => {
      const n = Math.pow(2, z)
      return {
        lon: tx / n * 360 - 180,
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI,
      }
    }
    // WGS84 → ENU
    const geoToEnu = (lon: number, lat: number) => ({
      x: (lon - oLon) * mpdLonDT,
      y: (lat - oLat) * MPD_LAT_DT,
    })
    // ENU → SVG 픽셀
    const enuToSvg = (x: number, y: number): [number, number] => [
      ((x - vb.minX) / vb.rangeX) * drawW,
      drawH - ((y - vb.minY) / vb.rangeY) * drawH,
    ]
    // 줌 레벨: m/px 기준으로 역산
    const mPerPx = vb.rangeX / drawW
    const rawZ = Math.log2(40075016.686 * Math.cos(oLat * Math.PI / 180) / (256 * mPerPx))
    const z = Math.max(15, Math.min(20, Math.round(rawZ)))
    // 뷰박스 코너의 WGS84 범위
    const corners = [
      enuToGeo(vb.minX, vb.minY),
      enuToGeo(vb.minX + vb.rangeX, vb.minY + vb.rangeY),
    ]
    const minTile = lonLatToTileDT(
      Math.min(corners[0].lon, corners[1].lon),
      Math.max(corners[0].lat, corners[1].lat),
      z,
    )
    const maxTile = lonLatToTileDT(
      Math.max(corners[0].lon, corners[1].lon),
      Math.min(corners[0].lat, corners[1].lat),
      z,
    )
    const tiles: SatTileDT[] = []
    for (let tx = minTile.tx; tx <= maxTile.tx; tx++) {
      for (let ty = minTile.ty; ty <= maxTile.ty; ty++) {
        const nw = tileOriginDT(tx, ty, z)
        const se = tileOriginDT(tx + 1, ty + 1, z)
        const enuNW = geoToEnu(nw.lon, nw.lat)
        const enuSE = geoToEnu(se.lon, se.lat)
        const [sx1, sy1] = enuToSvg(enuNW.x, enuNW.y)
        const [sx2, sy2] = enuToSvg(enuSE.x, enuSE.y)
        tiles.push({
          src: `/api/vworld?type=satellite&z=${z}&x=${tx}&y=${ty}`,
          x: sx1, y: sy1,
          w: sx2 - sx1, h: sy2 - sy1,
        })
      }
    }
    return tiles
  })()

  // ── Scale & bar ───────────────────────────────────────────────
  const scale = selectScale(vb.rangeX, drawWMM)
  const barM = niceBarM(vb.rangeX)
  const barPx = (barM / vb.rangeX) * drawW
  const isSiteSmall = Math.max(vb.rangeX, vb.rangeY) < 50

  // ── Aggregated data ───────────────────────────────────────────
  const totalPanelCount = zones.reduce((s, z) => s + z.layout.totalCount, 0)
  const totalKwp = zones.reduce((s, z) => s + z.layout.totalKwp, 0)
  const refZone = zones[0]
  const isMulti = zones.length > 1

  // ── Address ───────────────────────────────────────────────────
  const rawAddress = lastAnalysisAddress ?? mapResult?.address ?? ''
  const addrs = rawAddress ? rawAddress.split(',').map(s => s.trim()).filter(Boolean) : []
  const addrPrimary = addrs[0] ?? '주소 정보 없음'
  const addrExtra = addrs.length > 1 ? `외 ${addrs.length - 1}건` : null

  // ── Title block rows (12) ─────────────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const tbRows: { label: string; val: string; sub?: string }[] = [
    { label: '도면명', val: '태양광 패널 배치도' },
    { label: '도면번호', val: drawingNumber },
    { label: '사업명', val: projectName || '—' },
    { label: '주 소', val: addrPrimary.length > 16 ? addrPrimary.slice(0, 15) + '…' : addrPrimary, sub: addrExtra ?? undefined },
    { label: '패널 수', val: isMulti ? `${totalPanelCount.toLocaleString()}장 (${zones.length}구역)` : `${totalPanelCount.toLocaleString()}장` },
    { label: '설비 용량', val: `${totalKwp.toFixed(2)} kWp` },
    { label: '경사각 (최적)', val: `${refZone.optimalTilt}°` },
    { label: '방 위 각', val: `${refZone.azimuthDeg}° (정남 기준)` },
    { label: '배열 간격', val: `${refZone.rowSpacing.toFixed(2)} m` },
    { label: '축 척', val: `1 : ${scale.toLocaleString()}` },
    { label: '작 성 자', val: authorName || '—' },
    { label: '회 사 명', val: companyName || '—' },
    { label: '작 성 일', val: today },
  ]

  // ── Font sizes (proportional to tbRowH) ──────────────────────
  const fsLabel = Math.max(7, Math.round(tbRowH * 0.19))
  const fsValue = Math.max(8, Math.round(tbRowH * 0.23))
  const fsSub = Math.max(7, Math.round(tbRowH * 0.17))
  const labelBandH = Math.round(tbRowH * 0.32)

  // ── PDF export ────────────────────────────────────────────────
  const handleExportPDF = async () => {
    if (!svgRef.current || exporting) return
    setExporting('pdf')
    try {
      const xml = new XMLSerializer().serializeToString(svgRef.current)
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      await new Promise<void>((resolve, reject) => {
        const img = new Image()
        img.onload = async () => {
          try {
            const UPSCALE = 3
            const canvas = document.createElement('canvas')
            canvas.width = svgW * UPSCALE
            canvas.height = svgH * UPSCALE
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
            URL.revokeObjectURL(url)
            const { jsPDF } = await import('jspdf')
            const pdf = new jsPDF({ orientation: cfg.pdfOrient, unit: 'mm', format: cfg.pdfFormat })
            pdf.addImage(canvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, cfg.pdfW, cfg.pdfH)
            const safe = addrPrimary.replace(/\s+/g, '_').replace(/[^\w가-힣]/g, '').slice(0, 20)
            pdf.save(`배치도_${drawingNumber}_${safe}.pdf`)
            resolve()
          } catch (e) { reject(e) }
        }
        img.onerror = reject
        img.src = url
      })
    } catch {
      alert('PDF 저장 중 오류가 발생했습니다.')
    } finally {
      setExporting(null)
    }
  }

  // ── DXF export ────────────────────────────────────────────────
  const handleExportDXF = () => {
    const safe = addrPrimary.replace(/\s+/g, '_').replace(/[^\w가-힣]/g, '').slice(0, 20)
    exportDXF(zones, `배치도_${drawingNumber}_${safe}.dxf`, { author: authorName, company: companyName })
  }

  // ── JSX ───────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3">
        {/* Drawing info form */}
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div className="text-sm font-semibold text-gray-700 mb-3">📝 도면 정보 <span className="text-xs font-normal text-gray-400">(입력 시 자동 저장)</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">작성자</label>
              <input
                value={authorName}
                onChange={e => { setAuthorName(e.target.value); autoSave(e.target.value, companyName, projectName) }}
                placeholder="예: 조영두"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">회사명</label>
              <input
                value={companyName}
                onChange={e => { setCompanyName(e.target.value); autoSave(authorName, e.target.value, projectName) }}
                placeholder="예: 이강물산"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">사업명 (선택)</label>
              <input
                value={projectName}
                onChange={e => { setProjectName(e.target.value); autoSave(authorName, companyName, e.target.value) }}
                placeholder="예: 진주시 부계리 태양광 발전"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>
          <div className="flex items-center mt-2">
            <span className="text-xs text-gray-400">도면번호: {drawingNumber}</span>
          </div>
        </div>

        {/* Paper size + export buttons */}
        <div className="flex flex-col gap-3 min-w-[200px]">
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <div className="text-xs font-semibold text-gray-600 mb-2">용지 크기</div>
            <div className="space-y-1.5">
              {(Object.keys(PAPER) as PaperSize[]).map(ps => (
                <label key={ps} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="paper" value={ps} checked={paperSize === ps}
                    onChange={() => setPaperSize(ps)} className="accent-blue-600" />
                  <span className="text-sm text-gray-700">{PAPER[ps].label}</span>
                  {ps === 'A4L' && isSiteSmall && (
                    <span className="text-[10px] text-blue-500 font-medium bg-blue-50 px-1 rounded">추천</span>
                  )}
                </label>
              ))}
            </div>
          </div>
          <button onClick={handleExportPDF} disabled={!!exporting}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors">
            {exporting === 'pdf' ? (
              <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                PDF 생성 중…</>
            ) : `📄 PDF (${cfg.label.split(' ')[0]} ${cfg.label.split(' ')[1]})`}
          </button>
          <button onClick={handleExportDXF} disabled={!!exporting}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors">
            📐 DXF (AutoCAD)
          </button>
        </div>
      </div>

      {/* SVG drawing */}
      <div className="border border-gray-300 rounded-xl overflow-hidden shadow-sm bg-white">
        <div className="overflow-x-auto">
          <svg
            ref={svgRef}
            width={svgW} height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
          >
            <defs>
              <clipPath id="dc"><rect x={0} y={0} width={drawW} height={drawH} /></clipPath>
            </defs>

            {/* Backgrounds */}
            <rect width={svgW} height={svgH} fill="#e8edf5" />
            <rect x={0} y={0} width={drawW} height={drawH} fill="#ffffff" />

            {/* Drawing content */}
            <g clipPath="url(#dc)">
              {/* 위성지도 배경 — lastGeoOrigin 있을 때만 렌더링 */}
              {satTilesDT.map((t, i) => (
                <image key={i} href={t.src}
                  x={t.x} y={t.y} width={t.w} height={t.h}
                  preserveAspectRatio="none" opacity="0.85" />
              ))}

              {zones.map((zone, zi) => (
                <g key={zi}>
                  {/* Safe zone — 위성지도 위에서도 경계 식별 가능하도록 반투명 채움 */}
                  {zone.safeZone.safeZonePolygon && zone.safeZone.safeZonePolygon.length >= 3 && (
                    <polygon points={toPts(zone.safeZone.safeZonePolygon)}
                      fill={satTilesDT.length > 0 ? 'rgba(219,234,254,0.45)' : '#eff6ff'}
                      stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="7 3" opacity="0.85" />
                  )}
                  {/* Boundary */}
                  <polygon points={toPts(zone.safeZone.originalPolygon)}
                    fill="none" stroke="#1e293b" strokeWidth="2.5" />
                  {/* Panels */}
                  {zone.layout.placements.map(p => (
                    <polygon key={p.id} points={toPts([...p.corners])}
                      fill="#fde68a" stroke="#b45309" strokeWidth="0.35" />
                  ))}
                  {/* Zone label (multi-zone only) */}
                  {isMulti && zone.safeZone.originalPolygon.length >= 3 && (() => {
                    const c = polyCentroid(zone.safeZone.originalPolygon)
                    const [sx, sy] = toXY(c)
                    const label = isZoneResult(zone) ? zone.zoneLabel : `구역 ${zi + 1}`
                    const countTxt = `${zone.layout.totalCount}장 · ${zone.layout.totalKwp.toFixed(1)}kWp`
                    const fontSize = Math.max(8, Math.round(drawW / 80))
                    const bw = Math.max(80, countTxt.length * fontSize * 0.65 + 12)
                    return (
                      <g>
                        <rect x={sx - bw / 2} y={sy - fontSize * 2.4 - 3} width={bw} height={fontSize * 2.8 + 4}
                          fill="rgba(255,255,255,0.85)" stroke="#3b82f6" strokeWidth="1" rx="3" />
                        <text x={sx} y={sy - fontSize * 1.1} textAnchor="middle"
                          fontSize={fontSize + 1} fontWeight="bold" fill="#1e40af" fontFamily={FONT}>{label}</text>
                        <text x={sx} y={sy + fontSize * 0.6} textAnchor="middle"
                          fontSize={fontSize} fill="#374151" fontFamily={FONT}>{countTxt}</text>
                      </g>
                    )
                  })()}
                </g>
              ))}

              {/* N-arrow (top-left) */}
              <g transform={`translate(${Math.round(drawW * 0.042)}, ${Math.round(drawH * 0.068)})`}>
                <circle cx="0" cy="0" r="16" fill="white" stroke="#1e293b" strokeWidth="1.5" />
                <line x1="0" y1="11" x2="0" y2="-7" stroke="#1e293b" strokeWidth="2" strokeLinecap="round" />
                <polygon points="0,-13 -4,-4 4,-4" fill="#1e293b" />
                <text x="0" y="26" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#1e293b" fontFamily={FONT}>N</text>
              </g>

              {/* Scale bar (bottom-left) */}
              <g transform={`translate(20, ${drawH - 28})`}>
                <rect x={0} y={0} width={barPx} height={8} fill="none" stroke="#374151" strokeWidth="1.2" />
                <rect x={0} y={0} width={barPx / 2} height={8} fill="#374151" />
                <text x={0} y={20} fontSize="9" fill="#374151" fontFamily={FONT}>0</text>
                <text x={barPx / 2} y={20} textAnchor="middle" fontSize="9" fill="#374151" fontFamily={FONT}>{barM / 2}m</text>
                <text x={barPx} y={20} textAnchor="end" fontSize="9" fill="#374151" fontFamily={FONT}>{barM}m</text>
              </g>
            </g>

            {/* Drawing area border */}
            <rect x={0} y={0} width={drawW} height={drawH} fill="none" stroke="#374151" strokeWidth="1.5" />

            {/* ── Title block ─────────────────────────────────── */}
            <rect x={drawW} y={0} width={tbW} height={svgH} fill="#f9fafb" />
            <rect x={drawW} y={0} width={tbW} height={svgH} fill="none" stroke="#374151" strokeWidth="1.5" />

            {/* Header */}
            <rect x={drawW} y={0} width={tbW} height={tbHeaderH} fill="#1e3a8a" />
            <text x={drawW + tbW / 2} y={tbHeaderH * 0.42} textAnchor="middle"
              fontSize={Math.round(tbHeaderH * 0.26)} fontWeight="bold" fill="white" fontFamily={FONT}>
              태양광 패널 배치도
            </text>
            <text x={drawW + tbW / 2} y={tbHeaderH * 0.76} textAnchor="middle"
              fontSize={Math.round(tbHeaderH * 0.18)} fill="#bfdbfe" fontFamily={FONT}>
              Solar Panel Layout Drawing
            </text>
            <line x1={drawW} y1={tbHeaderH} x2={svgW} y2={tbHeaderH} stroke="#374151" strokeWidth="1" />

            {/* Data rows */}
            {tbRows.map((row, i) => {
              const ry = tbHeaderH + i * tbRowH
              return (
                <g key={i}>
                  <line x1={drawW} y1={ry + tbRowH} x2={svgW} y2={ry + tbRowH} stroke="#d1d5db" strokeWidth="0.7" />
                  <rect x={drawW} y={ry} width={tbW} height={labelBandH} fill="#dbeafe" />
                  <text x={drawW + 6} y={ry + labelBandH * 0.78} fontSize={fsLabel} fill="#1e40af" fontFamily={FONT}>
                    {row.label}
                  </text>
                  <text x={drawW + 6} y={ry + labelBandH + (tbRowH - labelBandH) * 0.52}
                    fontSize={fsValue} fontWeight="bold" fill="#111827" fontFamily={FONT}>
                    {row.val}
                  </text>
                  {row.sub && (
                    <text x={drawW + 6} y={ry + labelBandH + (tbRowH - labelBandH) * 0.82}
                      fontSize={fsSub} fill="#6b7280" fontFamily={FONT}>
                      {row.sub}
                    </text>
                  )}
                </g>
              )
            })}

            {/* Legend section */}
            <line x1={drawW} y1={tbHeaderH + dataH} x2={svgW} y2={tbHeaderH + dataH}
              stroke="#374151" strokeWidth="1.2" />
            <rect x={drawW} y={tbHeaderH + dataH} width={tbW} height={16} fill="#e2e8f0" />
            <text x={drawW + tbW / 2} y={tbHeaderH + dataH + 11} textAnchor="middle"
              fontSize={8.5} fill="#374151" fontFamily={FONT}>─ 범 례 ─</text>
            {[
              { fill: 'none',    stroke: '#1e293b', sw: 2,   dash: '',    lbl: '부지 경계' },
              { fill: '#eff6ff', stroke: '#3b82f6', sw: 1.2, dash: '4 2', lbl: '설치 가능 구역' },
              { fill: '#fde68a', stroke: '#b45309', sw: 0.8, dash: '',    lbl: '태양광 패널' },
            ].map((item, i) => {
              const ly = tbHeaderH + dataH + 20 + i * ((legendH - 20) / 3)
              return (
                <g key={i}>
                  <rect x={drawW + 7} y={ly} width={16} height={10}
                    fill={item.fill} stroke={item.stroke} strokeWidth={item.sw} strokeDasharray={item.dash} />
                  <text x={drawW + 27} y={ly + 8} fontSize={8.5} fill="#374151" fontFamily={FONT}>{item.lbl}</text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>

      {/* DXF usage hint */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 space-y-1">
        <div className="font-semibold">📐 DXF 파일 활용 안내</div>
        <div>AutoCAD, ZWCAD, DraftSight, 무료 뷰어(eDrawings, A360 Viewer)에서 열 수 있습니다.</div>
        <div>레이어: <span className="font-mono bg-white/60 px-1 rounded">BOUNDARY</span>(부지경계) · <span className="font-mono bg-white/60 px-1 rounded">SAFE_ZONE</span>(설치구역) · <span className="font-mono bg-white/60 px-1 rounded">PANELS</span>(패널) — 좌표 단위: 미터</div>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-4 py-2">
        ⚠️ 본 도면은 시각적 참조용이며, 실제 설치를 위해서는 공인 측량사의 정밀 측량 및 구조기술사의 설계가 필요합니다.
      </p>
    </div>
  )
}
