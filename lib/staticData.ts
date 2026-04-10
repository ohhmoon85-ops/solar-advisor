export interface OrdinanceData {
  주거이격: string
  농지설치: string
  소음: string
  지붕보조금: string
  계통: string
  비고: string
}

export const STATIC_ORDINANCE: Record<string, OrdinanceData> = {
  서울: { 주거이격: '규정없음', 농지설치: '불허', 소음: '해당없음', 지붕보조금: '30%(10kW)', 계통: '보통', 비고: 'BIPV 우대' },
  경기: { 주거이격: '100m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '20%(100kW)', 계통: '포화', 비고: '사전 계통 협의 필수' },
  충남: { 주거이격: '200m', 농지설치: '허용', 소음: '40dB', 지붕보조금: '25%(500kW)', 계통: '포화★', 비고: '발전사업허가 전 한전 협의 의무' },
  전남: { 주거이격: '250m', 농지설치: '허용', 소음: '40dB', 지붕보조금: '30%(1,000kW)', 계통: '포화★★', 비고: '일부 구역 50m 추가 이격' },
  경북: { 주거이격: '150m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '20%(500kW)', 계통: '여유', 비고: '산지 규제 강화' },
  강원: { 주거이격: '200m', 농지설치: '불허', 소음: '45dB', 지붕보조금: '35%(200kW)', 계통: '여유', 비고: '지붕형 보조금 최고' },
  전북: { 주거이격: '200m', 농지설치: '허용', 소음: '45dB', 지붕보조금: '25%(500kW)', 계통: '여유', 비고: '영농형 선도. 일부 50m 추가' },
  제주: { 주거이격: '300m', 농지설치: '불허', 소음: '40dB', 지붕보조금: '40%(50kW)', 계통: '포화★★★', 비고: '신규 사실상 중단' },
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

export const PERMIT_STAGE1 = [
  { id: 'p1-1', text: '발전사업허가 신청서 (양식)', required: false, buildingOnly: false, landOnly: false },
  { id: 'p1-2', text: '★ 사업계획서 (양식, 사업주 막도장) — 막도장 필수', required: true, buildingOnly: false, landOnly: false },
  { id: 'p1-3', text: '현장사진 — 전봇대명판 / 전체 드론사진', required: false, buildingOnly: false, landOnly: false },
  { id: 'p1-4', text: '★ 투자확약서', required: true, buildingOnly: false, landOnly: false },
  { id: 'p1-5', text: '★ 잔액증명확인서 — 사업비 15% 이상 (100kW→최소 1,500만원) — 거래은행 발급', required: true, buildingOnly: false, landOnly: false },
  { id: 'p1-6', text: '배치도/측면도 · 단선결선도', required: false, buildingOnly: false, landOnly: false },
  { id: 'p1-7', text: '토지대장 · 토지등기부 · 지적도등본 · 토지이용계획확인서', required: false, buildingOnly: false, landOnly: false },
  { id: 'p1-8', text: '건물일 경우: 건축물대장 · 현황도 · 등기부 (건물 설치 시)', required: false, buildingOnly: true, landOnly: false },
  { id: 'p1-9', text: '사업주 주민등록등본 · 가족관계증명서 · 인감증명서', required: false, buildingOnly: false, landOnly: false },
  { id: 'p1-10', text: '범죄경력 신원조회 동의서 · 토지사용승낙서 (토지주 다를 때)', required: false, buildingOnly: false, landOnly: true },
  { id: 'p1-11', text: '모듈 · 인버터 · 접속함 자료', required: false, buildingOnly: false, landOnly: false },
]

export const PERMIT_STAGE2 = [
  { id: 'p2-1', text: '★ [개발행위] 사업계획서 — 면적/증량/체적 계산서 포함', required: true, buildingOnly: false, landOnly: false },
  { id: 'p2-2', text: '[개발행위] 구조물검토서 · 배치도/측면도 · 토지 관련 서류 (13종)', required: false, buildingOnly: false, landOnly: false },
  { id: 'p2-3', text: '[공사신고] 신청서 · 시방서 · 전기도면 · 감리배치확인서 · 구조검토서', required: false, buildingOnly: false, landOnly: false },
  { id: 'p2-4', text: '★ [PPA] PPA 신청서 (2024.06.10 신양식) + 개발행위허가증', required: true, buildingOnly: false, landOnly: false },
  { id: 'p2-5', text: '★ [PPA] 사용전검사 종료 후 정계약', required: true, buildingOnly: false, landOnly: false },
  { id: 'p2-6', text: '★ [사용전검사] 안전관리자선임필증 · 수검자표 · 한전 송전요청서 (1주일 전)', required: true, buildingOnly: false, landOnly: false },
  { id: 'p2-7', text: '★ [에너지공단] 현장사진 7종 + 전체 22종 서류 — 현장 방문 3~4주', required: true, buildingOnly: false, landOnly: false },
  { id: 'p2-8', text: '★ 사업개시 신고 — 60일 이내 (미신고 벌금 60만원) — 에너지과', required: true, buildingOnly: false, landOnly: false },
]
