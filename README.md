# SolarAdvisor v5.2

태양광 사업성 분석 플랫폼 — 지번 입력 한 번으로 필지 경계·패널 배치도·20년 ROI·조례·인허가 서류를 한 화면에서 처리합니다.

- **Next.js 16.2** (App Router · Edge Runtime)
- **React 19** + **TypeScript** + **Tailwind v4**
- **Zustand** 전역 상태 + **localStorage** 이력 (서버 DB 없음)
- 외부 API: VWorld · KIER · KPX · 법제처 · Vercel KV (모두 선택, VWorld만 필수)

---

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정
cp .env.example .env.local
# → .env.local 을 열어 VWORLD_API_KEY 등 실제 값을 채움

# 3. 개발 서버 실행
npm run dev
```

브라우저: <http://localhost:3000>

> 첫 사용자 세팅(특히 사무실 PC에서 키 받아 시작하는 경우)은 [SETUP.md](./SETUP.md)를 참고하세요.

---

## 필요한 환경변수

`.env.local` 에 설정 (`.env.example` 복사 후 값만 교체).

### 필수

| 변수 | 용도 | 발급처 |
|---|---|---|
| `AUTH_HASH_<아이디>` | 로그인 계정 (SHA-256 해시) | 직접 생성 — `.env.example` 에 PowerShell 예제 포함 |
| `VWORLD_API_KEY` | **서버사이드** VWorld 호출 (`/api/geocode`, `/api/vworld` 라우트) | <https://www.vworld.kr/dev/v4api.do> |
| `NEXT_PUBLIC_VWORLD_API_KEY` | **브라우저** 직접 호출 (WMS 지적도 타일, DEM 경사도) | 위와 동일 키 값 사용 |

> **VWorld 키가 두 변수에 모두 필요한 이유**
> - 좌표·필지·검색 등 데이터 API는 서버 라우트(Edge Runtime, 한국 PoP)에서 호출 → 서버 변수
> - WMS 지적도 타일은 256×256 PNG 이미지를 `<img>` 로 직접 로드 (CORS 우회) → 브라우저 변수 필요
> - VWorld 콘솔에서 `localhost:3000` 및 프로덕션 도메인을 **사이트 등록**해야 키가 정상 동작

### 선택

| 변수 | 용도 | 미설정 시 동작 |
|---|---|---|
| `LAW_API_KEY` | 법제처 조례 검색 (OC) | 조례 탭 외부 검색만 비활성, 정적 데이터로 폴백 |
| `KIER_API_KEY` | 일사량/발전량 실측 데이터 | 위도 기반 추정값(3.5h/일)으로 폴백 |
| `KPX_SMP_API_KEY` | SMP 가격 자동 조회 | 기본 SMP = 110원/kWh |
| `KV_*` (5종) | Vercel KV — 조례 override 영구 저장 | 정적 데이터만 사용 (override 비활성) |

### 더 이상 사용하지 않음 (DEPRECATED 2026-04)

`KAKAO_REST_API_KEY`, `NAVER_MAP_CLIENT_ID`, `NAVER_MAP_CLIENT_SECRET`, Nominatim 관련 변수 — VWorld 단일 체계로 통합되어 모두 제거되었습니다. 신규 환경에는 추가하지 마세요.

---

## 주요 기능

| 탭 | 내용 |
|---|---|
| 🗺 지도·배치도 | VWorld 필지 자동 경계 + 위성/지적도 타일 + 패널 자동 배치 + 정밀 SVG 분석 + 인터랙티브 편집 |
| 📊 수익성 | 20년 현금흐름·LCOE·NPV·금리 시나리오 비교 |
| ⚖️ 조례 비교 | 시·군·구 최대 3개 동시 비교 (이격·농지·소음·보조금·계통) |
| 📋 인허가 | 발전사업허가~사업개시 25종 서류 체크리스트·PDF 출력 |
| ⚡ 패널 사양 | 5종 표준 모듈 비교 |
| ✅ 체크리스트 | 사전·인허가·시공 3단계 |
| 💰 단가 관리 | SMP·REC·정책금리 분기 갱신 |

---

## 폴더 구조

```
app/
  api/
    geocode/      ← VWorld 통합 라우트 (좌표 + 필지)
    vworld/       ← VWorld 타일·DEM·검색 등
    kier/         ← KIER 일사량
    smp/          ← KPX SMP
    ordinance/    ← 법제처 조례
    admin/ordinance/  ← Vercel KV 조례 override
  history/        ← 시뮬레이션 이력 페이지
  login/
  page.tsx        ← 7개 탭 메인
components/
  tabs/           ← 7개 탭 UI
  LayoutEditor.tsx        ← 인터랙티브 패널 편집기
  SolarLayoutCanvas.tsx   ← SVG 결과 시각화
lib/
  layoutEngine.ts        ← 방위각 회전 그리드 + Safe Zone
  shadowCalculator.ts    ← 동지 이격 + 경사각 최적화
  multiZoneLayout.ts     ← 다구역 폴리곤 분할
  layoutEditor.ts        ← 편집 reducer (20-step undo)
  cadastre.ts            ← 좌표 변환 유틸
  calculations.ts        ← 20년 ROI
  roiAnalyzer.ts         ← LCOE / NPV
  simulationHistory.ts   ← localStorage 이력 (200건)
  panelConfig.ts         ← 패널 프리셋
  ordinanceData.ts       ← 시·군·구 조례
store/useStore.ts        ← Zustand 전역 상태
```

---

## 배포

Vercel — `next build` 자동. Edge Runtime 라우트(`/api/geocode`, `/api/vworld`)는 한국 PoP에서 실행되어 VWorld가 서버 IP를 차단하는 문제를 회피합니다.

배포 시 Vercel 환경변수에 `.env.local`과 동일한 키를 등록하세요 (대시보드 → Settings → Environment Variables).
