# HWP 추출 1회 서버 설정 가이드

## 목적
`hwp5txt`를 설치해 `.hwp` 업로드 시 원문 텍스트 추출 성공률을 높입니다.

## 권장 설치 (Ubuntu)
```bash
sudo apt-get update
sudo apt-get install -y python3-pip
python3 -m pip install --user pyhwp
```

설치 확인:
```bash
~/.local/bin/hwp5txt --help
```

## 앱 연동 포인트
이 앱은 아래 순서로 hwp 추출을 시도합니다.
1. `hwp5txt`
2. `hwp.js`
3. `strings` fallback (저신뢰면 실패 처리)

`hwp5txt`가 PATH에 없어도 `~/.local/bin/hwp5txt`를 자동 탐색하도록 구현됨.

## PM2 재시작
```bash
pm2 restart workdog-archive-3030 --update-env
pm2 status workdog-archive-3030
```

## 검증 예시 (외부 주소)
```bash
curl -X POST "http://<PUBLIC_IP>:3030/api/folders/<FOLDER_ID>/documents" \
  -F "file=@/path/to/sample.hwp"
```

응답에서 아래를 확인:
- `extractStatus: "success"`
- `extractMethod: "hwp5txt"`
- `extractedText`에 본문 존재

## 실패 시 점검
- `hwp5txt not installed` → pyhwp 설치 필요
- `hwp.js: Header Signature ...` → 해당 hwp 포맷 비호환 가능
- `strings fallback low confidence ...` → 바이너리 잡음으로 신뢰도 부족
