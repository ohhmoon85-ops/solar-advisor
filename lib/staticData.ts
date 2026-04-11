export interface OrdinanceData {
  주거이격: string
  농지설치: string
  소음: string
  지붕보조금: string
  계통: string
  비고: string
  // ★ staticData.ts 수동 업데이트 시 이 날짜를 수정 (YYYY-MM-DD)
  lastUpdated: string
}

// ─────────────────────────────────────────────────────────────
// 조례 데이터 수동 업데이트 가이드
// ─────────────────────────────────────────────────────────────
// 법제처 API(law.go.kr)가 해당 지역 조례의 공포일자가
// lastUpdated보다 새로운 날짜를 반환하면, 앱 화면에
// "조례 개정됨" 경고가 표시됩니다.
//
// 경고 발생 시 수동 업데이트 절차:
//  1. https://www.law.go.kr/ordinInfoP.do 접속
//  2. 해당 지역 "태양광" 조례 원문 확인
//  3. 아래 해당 지역 데이터 수정
//  4. lastUpdated를 오늘 날짜(YYYY-MM-DD)로 변경
//  5. git commit & push → Vercel 자동 재배포
// ─────────────────────────────────────────────────────────────
export const STATIC_ORDINANCE: Record<string, OrdinanceData> = {
  서울: { 주거이격: '규정없음', 농지설치: '불허', 소음: '해당없음', 지붕보조금: '30%(10kW)', 계통: '보통', 비고: 'BIPV 우대', lastUpdated: '2026-04-10' },
  경기: { 주거이격: '100m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '20%(100kW)', 계통: '포화', 비고: '사전 계통 협의 필수', lastUpdated: '2026-04-10' },
  충남: { 주거이격: '200m', 농지설치: '허용', 소음: '40dB', 지붕보조금: '25%(500kW)', 계통: '포화★', 비고: '발전사업허가 전 한전 협의 의무', lastUpdated: '2026-04-10' },
  전남: { 주거이격: '250m', 농지설치: '허용', 소음: '40dB', 지붕보조금: '30%(1,000kW)', 계통: '포화★★', 비고: '일부 구역 50m 추가 이격', lastUpdated: '2026-04-10' },
  경북: { 주거이격: '150m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '20%(500kW)', 계통: '여유', 비고: '산지 규제 강화', lastUpdated: '2026-04-10' },
  강원: { 주거이격: '200m', 농지설치: '불허', 소음: '45dB', 지붕보조금: '35%(200kW)', 계통: '여유', 비고: '지붕형 보조금 최고', lastUpdated: '2026-04-10' },
  전북: { 주거이격: '200m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '25%(500kW)', 계통: '여유', 비고: '영농형 선도. 일부 50m 추가', lastUpdated: '2026-04-10' },
  제주: { 주거이격: '300m', 농지설치: '불허', 소음: '40dB', 지붕보조금: '40%(50kW)', 계통: '포화★★★', 비고: '신규 사실상 중단', lastUpdated: '2026-04-10' },
}

export interface PanelData {
  name: string
  watt: number
  efficiency: string
  recWeight: string
  costPerKw: string
  suitable: string
  highlight: boolean
}

export const PANEL_DATA: PanelData[] = [
  {
    name: '단결정 PERC',
    watt: 550,
    efficiency: '21~22%',
    recWeight: '1.0~1.5',
    costPerKw: '100~140만원/kW',
    suitable: '노지·토지',
    highlight: false,
  },
  {
    name: 'TOPCon (GS710wp)',
    watt: 710,
    efficiency: '22~24%',
    recWeight: '1.0~1.5',
    costPerKw: '110~150만원/kW',
    suitable: '소규모 노지 (실제 현장)',
    highlight: true,
  },
  {
    name: '양면형 Bifacial',
    watt: 580,
    efficiency: '21~23%',
    recWeight: '1.0~1.6',
    costPerKw: '110~145만원/kW',
    suitable: '수상·대규모',
    highlight: false,
  },
  {
    name: '박막형',
    watt: 400,
    efficiency: '11~16%',
    recWeight: '1.0~1.5',
    costPerKw: '90~120만원/kW',
    suitable: '커튼월',
    highlight: false,
  },
  {
    name: 'BIPV',
    watt: 300,
    efficiency: '12~16%',
    recWeight: '1.5 (건물일체)',
    costPerKw: '250~350만원/kW',
    suitable: '건물 외장',
    highlight: false,
  },
]

export interface PolicyLoanRate {
  id: string
  institution: string   // 기관명
  program: string       // 사업명
  rate: number          // 금리 (%)
  limitKW: number       // 설비 한도 (kW, 0=제한없음)
  limitRatio: number    // 융자 비율 (%, 사업비 대비)
  limitAmountMan: number // 융자 한도 (만원, 0=제한없음)
  year: number          // 기준연도
  target: string        // 대상
  note: string          // 비고
}

export const DEFAULT_POLICY_LOANS: PolicyLoanRate[] = [
  {
    id: 'loan-1',
    institution: '한국에너지공단',
    program: '신재생에너지 융자지원',
    rate: 2.0,
    limitKW: 0,
    limitRatio: 70,
    limitAmountMan: 0,
    year: 2025,
    target: '법인·개인사업자·일반인',
    note: '분기별 금리 변동. 에너지공단 신재생에너지센터 신청',
  },
  {
    id: 'loan-2',
    institution: '농림수산업자신용보증기금',
    program: '농업인 태양광 정책자금',
    rate: 1.5,
    limitKW: 100,
    limitRatio: 80,
    limitAmountMan: 30000,
    year: 2025,
    target: '농업인 (농지형)',
    note: '농협은행 창구 신청. 농지형 설치 시 우대금리 적용',
  },
  {
    id: 'loan-3',
    institution: '중소기업진흥공단',
    program: '신성장기반자금',
    rate: 2.8,
    limitKW: 0,
    limitRatio: 70,
    limitAmountMan: 100000,
    year: 2025,
    target: '중소기업·소상공인',
    note: '중진공 온렌딩 방식. 거래은행 통해 신청',
  },
  {
    id: 'loan-4',
    institution: '지방자치단체',
    program: '지역별 태양광 보급 지원',
    rate: 1.0,
    limitKW: 30,
    limitRatio: 50,
    limitAmountMan: 5000,
    year: 2025,
    target: '해당 지역 주민',
    note: '지자체별 상이. 주민센터·시군구청 문의 필요',
  },
]

// ── 서식 파일 경로 안내 ─────────────────────────────────────────────
// 파일을 solar-advisor/public/forms/ 에 저장하면 formUrl이 자동 연결됩니다.
// 파일명 규칙: /forms/[id]_[서식명].pdf  (HWP도 가능)
// ──────────────────────────────────────────────────────────────────

export const PERMIT_STAGE1 = [
  { id: 'p1-1', text: '발전사업허가 신청서 (양식)', required: false, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p1-1_발전사업허가신청서.pdf',
    formNote: '산업통상자원부 → 민원 → 서식자료 → "발전사업허가신청서" 검색 후 저장',
    formDownload: 'https://www.motie.go.kr/www/bbs/view.do?bbs_cd_n=81' },
  { id: 'p1-2', text: '★ 사업계획서 (양식, 사업주 막도장) — 막도장 필수', required: true, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p1-2_태양광사업계획서.pdf',
    formNote: '산업통상자원부 → 민원 → 서식자료 → "태양광 사업계획서" 검색 후 저장',
    formDownload: 'https://www.motie.go.kr/www/bbs/view.do?bbs_cd_n=81' },
  { id: 'p1-3', text: '현장사진 — 전봇대명판 / 전체 드론사진', required: false, buildingOnly: false, landOnly: false,
    formNote: '직접 촬영 — 전봇대 명판·전체 부지·드론 사진 포함' },
  { id: 'p1-4', text: '★ 투자확약서', required: true, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p1-4_투자확약서.pdf',
    formNote: '산업통상자원부 → 민원 → 서식자료 → "투자확약서" 검색 후 저장',
    formDownload: 'https://www.motie.go.kr/www/bbs/view.do?bbs_cd_n=81' },
  { id: 'p1-5', text: '★ 잔액증명확인서 — 사업비 15% 이상 (100kW→최소 1,500만원) — 거래은행 발급', required: true, buildingOnly: false, landOnly: false,
    formNote: '거래 은행 방문 또는 인터넷뱅킹 → 잔액증명서 발급 (별도 서식 없음)' },
  { id: 'p1-6', text: '배치도/측면도 · 단선결선도', required: false, buildingOnly: false, landOnly: false,
    formNote: '설계사무소 작성 (CAD 도면) — 별도 서식 없음' },
  { id: 'p1-7', text: '토지대장 · 지적도등본', required: false, buildingOnly: false, landOnly: false,
    formUrl: 'https://www.gov.kr/portal/service/serviceInfo/PTR000050078',
    formNote: '정부24 → 토지대장 발급 / 지적도등본 발급' },
  { id: 'p1-7b', text: '토지이용계획확인서', required: false, buildingOnly: false, landOnly: false,
    formUrl: 'https://www.eum.go.kr',
    formNote: '토지이음(eum.go.kr) → 토지이용계획확인서 발급' },
  { id: 'p1-7c', text: '토지등기부등본', required: false, buildingOnly: false, landOnly: false,
    formUrl: 'https://www.iros.go.kr',
    formNote: '대법원 인터넷등기소(iros.go.kr) → 토지 등기사항전부증명서' },
  { id: 'p1-8', text: '건축물대장 · 현황도 · 건물등기부 (건물 설치 시)', required: false, buildingOnly: true, landOnly: false,
    formUrl: 'https://www.gov.kr/portal/service/serviceInfo/PTR000050063',
    formNote: '정부24 → 건축물대장 발급 / 인터넷등기소 → 건물등기부' },
  { id: 'p1-9', text: '사업주 주민등록등본 · 가족관계증명서 · 인감증명서', required: false, buildingOnly: false, landOnly: false,
    formUrl: 'https://www.gov.kr/portal/service/serviceInfo/PTR000050055',
    formNote: '정부24(주민등록등본·가족관계증명) / 인감증명서는 주민센터 방문 발급' },
  { id: 'p1-10', text: '토지사용승낙서 (토지주 다를 때)', required: false, buildingOnly: false, landOnly: true,
    formUrl: '/forms/p1-10_토지사용승낙서.pdf',
    formNote: '자유 서식 — 토지주 인감도장 날인 필수. 아래 서식 참고 후 수정 사용' },
  { id: 'p1-11', text: '모듈 · 인버터 · 접속함 자료', required: false, buildingOnly: false, landOnly: false,
    formNote: '제조사 제품사양서 · KS인증서 첨부 (별도 서식 없음)' },
]

export const PERMIT_STAGE2 = [
  { id: 'p2-1', text: '★ [개발행위] 사업계획서 — 면적/증량/체적 계산서 포함', required: true, buildingOnly: false, landOnly: false,
    formNote: '시·군·구청 개발행위허가 담당에서 서식 직접 수령 (지자체별 양식 상이)' },
  { id: 'p2-2', text: '[개발행위] 구조물검토서 · 배치도/측면도 · 토지 관련 서류 (13종)', required: false, buildingOnly: false, landOnly: false,
    formNote: '구조기술사 작성 / 설계사무소 도면 — 전문가 의뢰' },
  { id: 'p2-3', text: '[공사신고] 신청서 · 시방서 · 전기도면 · 감리배치확인서 · 구조검토서', required: false, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p2-3_공사계획신고서.pdf',
    formNote: '산업통상자원부 → 민원 → 서식자료 → "공사계획 신고서" 검색 후 저장',
    formDownload: 'https://www.motie.go.kr/www/bbs/view.do?bbs_cd_n=81' },
  { id: 'p2-4', text: '★ [PPA] PPA 신청서 (2024.06.10 신양식) + 개발행위허가증', required: true, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p2-4_PPA신청서.pdf',
    formNote: '한국전력 지역 지사 방문 또는 아래 링크에서 신양식 수령 (2024.06.10 이후 버전)',
    formDownload: 'https://home.kepco.co.kr/kepco/CM/F/htmlView/CMFBHP00101.do' },
  { id: 'p2-5', text: '★ [PPA] 사용전검사 종료 후 정계약', required: true, buildingOnly: false, landOnly: false,
    formUrl: 'https://home.kepco.co.kr/kepco/CM/F/htmlView/CMFBHP00101.do',
    formNote: '한국전력 PPA 정계약 — 사용전검사 완료 후 한전 지사 방문 진행' },
  { id: 'p2-6', text: '★ [사용전검사] 안전관리자선임필증 · 수검자표 · 한전 송전요청서 (1주일 전)', required: true, buildingOnly: false, landOnly: false,
    formUrl: 'https://safety.kesco.or.kr',
    formNote: '한국전기안전공사(safety.kesco.or.kr) → 사용전검사 온라인 신청 / 송전요청서는 한전 지사 제출' },
  { id: 'p2-7', text: '★ [에너지공단] 현장사진 7종 + 전체 22종 서류 — 현장 방문 3~4주', required: true, buildingOnly: false, landOnly: false,
    formUrl: 'https://rps.energy.or.kr',
    formNote: '한국에너지공단 RPS 시스템(rps.energy.or.kr) → 설비확인 신청 (온라인 접수)' },
  { id: 'p2-8', text: '★ 사업개시 신고 — 60일 이내 (미신고 벌금 60만원) — 에너지과', required: true, buildingOnly: false, landOnly: false,
    formUrl: '/forms/p2-8_사업개시신고서.pdf',
    formNote: '산업통상자원부 → 민원 → 서식자료 → "사업개시 신고서" 검색 후 저장',
    formDownload: 'https://www.motie.go.kr/www/bbs/view.do?bbs_cd_n=81' },
]
