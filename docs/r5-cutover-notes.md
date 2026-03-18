# R5 Cut-over Notes (무중단 전환)

작성일: 2026-03-18 (UTC)

## 적용 방식
- `workdog-archive` 서버가 정적 프론트를 아래 우선순위로 서빙:
  1. `WORKDOG_FRONTEND_DIR` 환경변수 지정 경로
  2. `../workdog-archive-web/dist`가 존재하면 해당 React 빌드
  3. 없으면 기존 `public/`(레거시)

즉, 기본적으로 React 빌드가 존재하면 자동 cut-over 됩니다.

## 현재 상태
- React dist 경로: `/home/ubuntu/projects/apps/workdog-archive-web/dist`
- 서비스 URL: `http://168.107.14.124:3030`

## 롤백 방법 (즉시)
### 방법 A: 환경변수로 강제 레거시
```bash
pm2 restart workdog-archive-3030 --update-env
# (재시작 전에 WORKDOG_FRONTEND_DIR=/home/ubuntu/projects/apps/workdog-archive/public 설정)
```

### 방법 B: React dist 임시 비활성
- `workdog-archive-web/dist`를 다른 이름으로 이동 후 재시작
- 서버는 자동으로 `public/`로 fallback

## 검증 항목
- `/` 진입 정상
- `/folders` 라우트 정상 (SPA fallback)
- `/api/folders` JSON 응답 정상
- 업로드/메모/중요/삭제 동작 정상
