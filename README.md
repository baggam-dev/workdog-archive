# workdog-archive

문서 관리 + AI 요약 웹앱입니다. (업무용 아카이브)

## 주요 기능
- 문서 업로드: `hwp`, `pdf`, `xlsx`, `xls`, `txt`
- 텍스트 추출: HWP 포함
- AI 요약: 한줄 요약 / 핵심 포인트 / 카테고리 / 태그
- 검색/필터: 제목, 태그, 카테고리, 파일 형식
- 문서 관리: 폴더, 메모, 중요 문서 표시
- 반응형 UI: 모바일 카드형, 데스크톱 테이블형 관리자 UI

## 기술 스택
- Node.js + Express
- File System 기반 저장
- OpenClaw Agent 연동
- 모델: GPT-5 계열(Codex), OAuth 방식

## 실행 방법
```bash
npm install
npm start
```

기본 포트: `3030`

## 프로젝트 구조(요약)
- `server.js` : API/서버 엔트리
- `public/` : 프론트엔드 정적 파일
- `data/` : 메타데이터(JSON)
- `uploads/` : 업로드 파일 저장소

## 참고
- HWP 추출 설정은 `HWP_SETUP.md`를 참고해 주세요.
