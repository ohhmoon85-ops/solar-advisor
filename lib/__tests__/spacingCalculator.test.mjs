// lib/__tests__/spacingCalculator.test.mjs
// 행간거리 계산 단위 테스트 — Node.js 직접 실행 (node lib/__tests__/spacingCalculator.test.mjs)
// 엑셀 예시값과의 일치 검증

const DEG2RAD = Math.PI / 180

function calculateRowSpacing(solarAngle, moduleAngle, landAngle, moduleLength) {
  const verticalLength = Math.sin(moduleAngle * DEG2RAD) * moduleLength
  const horizontalLength = Math.cos(moduleAngle * DEG2RAD) * moduleLength
  const correctedVertical = Math.sin(landAngle * DEG2RAD) * moduleLength
  const correctedSolarDistance =
    Math.tan((90 - solarAngle) * DEG2RAD) * (verticalLength - correctedVertical)
  const rowSpacing = horizontalLength + correctedSolarDistance
  const moduleToModuleGap = rowSpacing - horizontalLength
  const r = v => Math.round(v * 1000) / 1000
  return {
    verticalLength:         r(verticalLength),
    horizontalLength:       r(horizontalLength),
    correctedVertical:      r(correctedVertical),
    correctedSolarDistance: r(correctedSolarDistance),
    rowSpacing:             r(rowSpacing),
    moduleToModuleGap:      r(moduleToModuleGap),
  }
}

function getSolarAngleByLocation(lat) {
  return 90 - lat - 23.45
}

function calculateSlopeFromPercent(pct) {
  return Math.atan(pct / 100) * (180 / Math.PI)
}

let passed = 0, failed = 0

function assert(desc, actual, expected, tol = 0.001) {
  const ok = Math.abs(actual - expected) <= tol
  if (ok) {
    console.log(`  ✅ ${desc}: ${actual} (기대 ${expected})`)
    passed++
  } else {
    console.error(`  ❌ ${desc}: ${actual} (기대 ${expected}, 차이 ${Math.abs(actual - expected).toFixed(4)})`)
    failed++
  }
}

console.log('\n=== 검증 1: 엑셀 예시값 (§1 핵심 수식) ===')
console.log('입력: solarAngle=26°, moduleAngle=15°, landAngle=3°, moduleLength=2.384m')
{
  const r = calculateRowSpacing(26, 15, 3, 2.384)
  assert('수직길이    ', r.verticalLength,         0.617)
  assert('수평거리    ', r.horizontalLength,        2.303)
  assert('보정수직길이', r.correctedVertical,       0.125)
  assert('보정태양각  ', r.correctedSolarDistance,  1.009)
  assert('행간거리    ', r.rowSpacing,              3.312)
  assert('모듈사이    ', r.moduleToModuleGap,       1.009)
}

console.log('\n=== 검증 2: 경사지 없음 (landAngle=0) ===')
{
  const r = calculateRowSpacing(30, 30, 0, 2.382)
  console.log(`  행간거리: ${r.rowSpacing}m (위도 37° 기준 약 3.74m 예상)`)
  assert('수직길이 ≥ 0', r.verticalLength > 0 ? 1 : 0, 1)
  assert('행간거리 > 수평거리', r.rowSpacing > r.horizontalLength ? 1 : 0, 1)
}

console.log('\n=== 검증 3: 위도 기반 태양각 ===')
assert('위도 35° 태양고도', getSolarAngleByLocation(35), 31.55)
assert('위도 37° 태양고도', getSolarAngleByLocation(37), 29.55)
assert('위도 38° 태양고도', getSolarAngleByLocation(38), 28.55)

console.log('\n=== 검증 4: 기울기 % → 경사각 (§2) ===')
assert('7% → 4.00°', calculateSlopeFromPercent(7), 4.00, 0.01)
assert('0% → 0°',   calculateSlopeFromPercent(0), 0)

console.log('\n=== 검증 5: 경사각 변화에 따른 행간거리 단조성 ===')
{
  const r1 = calculateRowSpacing(30, 15, 0, 2.384)  // 경사각 15°
  const r2 = calculateRowSpacing(30, 30, 0, 2.384)  // 경사각 30°
  assert('경사각 클수록 행간거리 큼', r2.rowSpacing > r1.rowSpacing ? 1 : 0, 1)
  console.log(`  경사각 15°: ${r1.rowSpacing}m, 경사각 30°: ${r2.rowSpacing}m`)
}

console.log('\n=== 검증 6: 토지 경사가 남향이면 행간거리 감소 ===')
{
  const rFlat = calculateRowSpacing(30, 30, 0, 2.384)  // 평지
  const rSlope = calculateRowSpacing(30, 30, 5, 2.384) // 경사지
  assert('경사지 < 평지 행간거리', rSlope.rowSpacing < rFlat.rowSpacing ? 1 : 0, 1)
  console.log(`  평지: ${rFlat.rowSpacing}m, 경사지(5°): ${rSlope.rowSpacing}m`)
}

console.log(`\n=== 결과: ${passed}/${passed + failed} 통과 ===\n`)
if (failed > 0) process.exit(1)