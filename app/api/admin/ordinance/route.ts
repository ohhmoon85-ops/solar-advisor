import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { STATIC_ORDINANCE } from '@/lib/staticData'

async function getOverrides(): Promise<Record<string, unknown>> {
  try {
    const data = await kv.get<Record<string, unknown>>('ordinance_overrides')
    return data ?? {}
  } catch {
    return {}
  }
}

export async function GET() {
  try {
    const overrides = await getOverrides()
    const result: Record<string, unknown> = {}
    for (const region of Object.keys(STATIC_ORDINANCE)) {
      result[region] = overrides[region] ?? STATIC_ORDINANCE[region]
    }
    return NextResponse.json({
      data: result,
      overrides: Object.keys(overrides),
      source: 'kv+static',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.json({ error: 'KV read failed: ' + msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { region, data } = await req.json() as { region: string; data: unknown }
    if (!region || !data) {
      return NextResponse.json({ error: 'region and data required' }, { status: 400 })
    }
    if (!(region in STATIC_ORDINANCE)) {
      return NextResponse.json({ error: 'unknown region: ' + region }, { status: 400 })
    }
    const overrides = await getOverrides()
    const today = new Date().toISOString().slice(0, 10)
    overrides[region] = { ...(data as object), lastUpdated: today }
    await kv.set('ordinance_overrides', overrides)
    return NextResponse.json({ ok: true, region, savedAt: today })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg.includes('KV_REST_API_URL') || msg.includes('ENOTFOUND') || msg.includes('fetch')) {
      return NextResponse.json({
        error: 'Vercel KV 미설정',
        guide: 'Vercel 대시보드 → Storage → KV 생성 후 환경변수(KV_REST_API_URL, KV_REST_API_TOKEN) 추가',
        code: 'KV_NOT_CONFIGURED',
      }, { status: 503 })
    }
    return NextResponse.json({ error: 'KV write failed: ' + msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { region } = await req.json() as { region: string }
    if (!region) return NextResponse.json({ error: 'region required' }, { status: 400 })
    const overrides = await getOverrides()
    delete overrides[region]
    await kv.set('ordinance_overrides', overrides)
    return NextResponse.json({ ok: true, region, restored: 'static' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
