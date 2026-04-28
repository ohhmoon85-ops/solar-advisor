# 사무실 PC 첫 세팅 가이드

새 PC에서 SolarAdvisor를 처음 받아 실행하는 절차입니다. **이미 다른 PC에서 동작 중인 코드를 가정**하므로, 코드는 git 또는 USB로 가져온 상태에서 시작합니다.

---

## 1. 사전 요구사항

| 항목 | 권장 버전 | 확인 명령 |
|---|---|---|
| Node.js | 20.x 이상 | `node -v` |
| npm | 10.x 이상 (Node 동봉) | `npm -v` |
| Git (선택) | 최신 | `git --version` |
| OS | Windows 10/11, macOS, Linux | — |

Node.js 미설치 시: <https://nodejs.org> → LTS 다운로드.

---

## 2. 코드 가져오기

**Git 사용 시**
```bash
git clone <저장소 URL> solar-advisor
cd solar-advisor
```

**USB / 압축파일 사용 시**
- `node_modules/`, `.next/`, `.env.local`, `tsconfig.tsbuildinfo` 폴더/파일은 받지 마세요 (각 PC에서 새로 생성됨)
- 받은 폴더에서 터미널 열기

---

## 3. 환경변수 설정 (.env.local)

```bash
# 템플릿 복사
cp .env.example .env.local       # macOS / Linux / Git Bash
# 또는
copy .env.example .env.local     # Windows cmd
# 또는
Copy-Item .env.example .env.local  # PowerShell
```

`.env.local` 을 에디터로 열어 실제 값을 채웁니다. **최소한 다음 3개는 필수:**

```env
AUTH_HASH_yourid=<로그인 비밀번호의 SHA-256 해시>
VWORLD_API_KEY=<VWorld 키>
NEXT_PUBLIC_VWORLD_API_KEY=<위와 동일 값>
```

> 키를 다른 PC에서 복사해 오는 경우: USB / 1Password / 사내 비밀저장소 등 안전한 채널 사용. **Slack DM·이메일 평문 전송 금지.**

> VWorld 콘솔(<https://www.vworld.kr>)에 본 PC가 사용할 도메인이 등록되어 있어야 합니다. 개발 환경은 `localhost:3000`. 등록 후 반영까지 **수 분** 걸릴 수 있습니다.

---

## 4. 의존성 설치 + 실행

```bash
npm install
npm run dev
```

- 설치 완료까지 ~2~5분
- `Ready in X.Xs` 메시지 후 <http://localhost:3000>

---

## 5. 동작 확인

1. 브라우저에서 <http://localhost:3000> 접속
2. 로그인 (`.env.local` 의 `AUTH_HASH_*` 계정)
3. **지도·배치도 탭** → "지번 입력" 에 `경남 진주시 사봉면 부계리 661` 입력
4. 검색 → 다음이 모두 보이면 정상:
   - 청록색 필지 폴리곤
   - 좌측 ParcelInfoCard
   - 좌측 "지적도" 토글 ON 시 인접 필지 라벨/경계
   - SMP 단가 (헤더)

---

## 6. 흔한 트러블슈팅

### 6-1. 포트 3000 이 이미 사용 중

증상: `Error: listen EADDRINUSE: address already in use :::3000`

**Windows PowerShell**
```powershell
# 점유 PID 찾기
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
# 프로세스 종료 (PID 확인 후)
Stop-Process -Id <PID> -Force
```

**macOS / Linux**
```bash
lsof -i :3000
kill -9 <PID>
```

또는 다른 포트로:
```bash
npm run dev -- -p 3001
```

### 6-2. 좀비 Next 프로세스

증상: `Ctrl+C` 했는데 포트가 살아있음, dev 서버가 두 개 떠 있음.

**Windows**
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

**macOS / Linux**
```bash
pkill -f "next dev"
```

### 6-3. .env.local 변경했는데 안 먹음

Next.js dev server는 `.env.*` 변경 시 **자동 재시작되지 않습니다.** 환경변수는 `process.env.X` 로 빌드 타임 인라이닝되므로 수동 재시작 필요:

```
Ctrl+C → npm run dev
```

브라우저는 추가로 **하드 리프레시** (`Ctrl+Shift+R`).

### 6-4. WMS 지적도 타일 깨진 이미지로 표시

원인 1순위: `NEXT_PUBLIC_VWORLD_API_KEY` 누락. → `.env.local` 확인 후 dev 재시작.

원인 2순위: VWorld 콘솔에 `localhost:3000` 미등록. → vworld.kr 마이페이지에서 사이트 추가.

브라우저 DevTools → Network → 실패한 `api.vworld.kr/req/wms?...` 요청의 `key=` 파라미터 확인:
- 비어있음 → 환경변수 문제
- 36자 키 있음 + 403 응답 → 사이트 등록 문제

### 6-5. node_modules 손상 / `npm install` 후에도 모듈 못 찾음

```bash
rm -rf node_modules package-lock.json .next
npm install
```

Windows PowerShell:
```powershell
Remove-Item -Recurse -Force node_modules, package-lock.json, .next
npm install
```

### 6-6. TypeScript 타입 캐시 오류 (특히 라우트 추가/삭제 후)

```bash
rm -rf .next/types
npx tsc --noEmit
```

### 6-7. VWorld 가 갑자기 502 / 응답 없음

- VWorld 자체 점검 시간 (주로 새벽) — 잠시 후 재시도
- VWorld 콘솔에서 일일 호출 한도 초과 여부 확인
- 한국 IP 외 (해외 VPN 등)에서 호출 시 차단됨 — VPN 끄기

---

## 7. 흐름 정리

```
git clone (또는 USB)
   ↓
cp .env.example .env.local
   ↓
.env.local 의 실제 키 값 채우기
   ↓
npm install
   ↓
npm run dev
   ↓
http://localhost:3000 → 로그인 → 지번 검색 OK 확인
```

문제 발생 시 위 6장의 항목별 가이드를 먼저 시도하세요.
