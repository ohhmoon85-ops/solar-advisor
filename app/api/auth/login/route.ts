import { createHash } from 'crypto'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const { id, pw } = await req.json().catch(() => ({}))

  if (!id || !pw) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const storedHash = process.env[`AUTH_HASH_${id}`]
  if (!storedHash) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const inputHash = createHash('sha256').update(pw).digest('hex')
  if (inputHash !== storedHash) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  return NextResponse.json({ ok: true })
}
