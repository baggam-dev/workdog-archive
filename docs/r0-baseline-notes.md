# R0 Baseline Notes

작성일: 2026-03-18 (UTC)

## 운영 기준
- 앱 URL: `http://168.107.14.124:3030`
- 프로세스: PM2 `workdog-archive-3030`
- 백엔드: Express (`server.js`)
- 프론트: `public/index.html` 기반

## 현재 UI/기능 기준
- 관리자형 문서 테이블(정렬/필터/중요/액션 팝오버)
- 모바일 카드 뷰 유지
- 접근성 키보드 이동(↑↓/Home/End/Enter/Space)
- 상태 라인(loading/empty/error)

## 전환 전 가정
- API 계약은 v1 문서 기준 유지 (`docs/api-contract-v1.md`)
- 회귀 테스트는 R0 체크리스트 기준 (`docs/regression-checklist-r0.md`)
- React 전환 중에도 URL/포트(3030) 유지 목표
