# Cove 흰 배경·블루 헤드폰 로고

2026-10-24 · Cove 흰 배경·블루 헤드폰 v4

정방향 헤드폰을 사용한다. 이전 보물함·레코드·가로 헤드폰 안보다 최신 승인안을 우선한다.

- 단일 도형 원본: `public/icons.js`의 `cove-brand`. 승인 `mark-draft.svg`와 같은 96×96 도형이며 개별 선 굵기 5/3, 채움, 이어컵 각도를 유지한다.
- `soriseojae-mark-v4.svg`: 투명 마크·SVG 파비콘. 기본 #244E79, 어두운 화면 #9EBFF5. 앱 인라인 마크도 기존 밝기 토큰을 따른다.
- `soriseojae-app-v4.svg`: 승인 앱 원본과 같은 흰 배경 #FFFFFF·블루 #244E79. 512 기준 translate(54 54) scale(4.2), 모서리 112.
- `soriseojae-app-v4-192.png`, `soriseojae-app-v4-512.png`: 설치용. 전체 배경은 모서리까지 불투명 흰색이다.
- `soriseojae-apple-v4.png`: Apple touch 180px. 같은 불투명 흰 배경이다.
- `soriseojae-favicon-v4.png`: 투명 배경 32px 대체 파비콘.

```bash
PLAYWRIGHT_MODULE=/설치된/playwright/index.mjs node scripts/render-brand-icons.mjs
```

생성기는 공통 도형으로 SVG/PNG를 만든다. Playwright/Chrome은 생성 시에만 필요하다. HTML/manifest는 v4를 참조하며 이전 자산은 캐시 호환을 위해 보존한다. 이미 설치된 앱의 OS 아이콘 갱신은 별도 확인하지 않았다. 데이터 경로·앱 이름·저장 키는 그대로다.

공통 도형과 설치 아이콘은 제품 소스의 MIT 라이선스를 따릅니다.
