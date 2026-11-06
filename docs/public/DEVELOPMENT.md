# Cove 개발 안내

Node.js 24 이상, `npm ci` 후 `npm test`로 기본 검사를 실행합니다. 모든 변경 검사는 임시 서재와 합성 음원을 사용합니다.

```sh
npm start
# 다른 버전과 분리한 개발 서버
PORT=49417 SORISEOJAE_DATA_DIR=/tmp/cove-preview node src/server.mjs
```

Playwright와 Chrome을 별도로 설치하고 `PLAYWRIGHT_MODULE`에 Playwright의 `index.mjs` 절대 경로를 지정하면 통합 검사를 실행할 수 있습니다. 고정 포트를 쓰므로 순차 실행하세요.

```sh
RUN_HTTP_TESTS=1 node --test --test-concurrency=1 tests/http-import.test.mjs
RUN_BROWSER_TESTS=1 node --test --test-concurrency=1 tests/import-simplicity-browser.test.mjs tests/comments-popover-browser.test.mjs tests/public-readiness-browser.test.mjs tests/playlists-browser.test.mjs tests/long-audio-browser.test.mjs tests/shuffle-repeat-browser.test.mjs
RUN_DESKTOP_TESTS=1 node --test --test-concurrency=1 tests/public-readiness-desktop.test.mjs tests/auto-import-settings.test.mjs
```

기본 `npm test`에서는 브라우저·HTTP·설치 앱 검사를 생략합니다. 과거 기능의 브라우저 검사는 당시 화면 문구를 기준으로 하므로 최신 화면을 변경할 때 진입점과 기대값도 함께 확인하세요.

Mac 패키지는 Apple Silicon Mac에서 빌드합니다. Command Line Tools의 clang, iconutil, codesign, hdiutil과 Node 헤더가 필요합니다. 헤더가 기본 `/opt/homebrew/include/node`에 없다면 `COVE_NODE_INCLUDE`로 지정하세요. Xcode 전체와 iOS 도구는 필요하지 않습니다.

```sh
npm run desktop:build
npm run desktop:dmg
shasum -a 256 dist/Cove-0.1.19-mac-arm64.dmg
node scripts/prepare-public-release.mjs
```

앱은 임시 `.desktop-build/`에서 제품 코드와 production 의존성만 모아 빌드하고 ad-hoc 서명합니다. 개발자 서재 기본값을 포함하지 않습니다. 로컬 서명 검사는 `codesign --verify --deep --strict dist/Cove.app`으로 수행합니다. Apple 공증·다른 Mac·다운로드 검역 속성을 포함한 설치 검증을 대신하지 않습니다.

공개 준비 스크립트는 명시한 제품 소스·검사·공개 문서만 `dist/cove-public-source/`에 복사하고 `dist/PUBLIC_FILES.txt`와 스캔 결과를 생성합니다. 원래 작업 폴더 전체를 업로드하지 마세요. 실제 GitHub 게시와 릴리스 업로드는 별도 검토 후 수행합니다.

알람 관리 권한, 실제 잠자기 깨우기, 다른 출력 장치, 다른 Mac/포맷의 청취는 기기에서 추가 확인해야 합니다. 개발 설정 `COVE_PROFILE_DIR`, `COVE_DATA_DIR`는 실사용 앱과 분리한 Electron 검사에만 사용합니다.

Windows x64 실행 폴더와 설치 EXE는 NSIS가 있는 Mac 또는 Windows에서 `npm run windows:build`로 생성합니다. [Windows 빌드·검증](WINDOWS.md)을 참고하세요. 게시 전 `npm run public:prepare`로 공개 후보를 다시 생성하고 검사 결과를 확인하세요. `.github/workflows/check.yml`은 Mac 기본 검사와 Windows 빌드·실행 검사를 정의하며 자동 릴리스 게시 권한은 없습니다.
