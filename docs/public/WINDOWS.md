# Windows 설치 후보

Windows 10/11 x64용 `Cove-Setup-0.1.19-x64.exe`입니다. Mac에서 Electron 45.0.0과 NSIS 3.13으로 생성한 미서명 설치 후보이며, 실제 Windows 설치·오디오 재생은 아직 검증하지 않았습니다. GitHub에 올리기 전 아래 검사를 Windows에서 수행하세요.

## 사용과 보관

설치는 현재 사용자의 `%LOCALAPPDATA%\Programs\Cove`에 고정합니다. 서재 기본 제안 위치는 사용자의 Music\Cove이며, 시작 시 다른 빈 폴더나 기존 서재를 선택할 수 있습니다. 사용자 설정·대기열·밝기는 `%APPDATA%\Cove` 프로필에 보관합니다. 업데이트/제거 과정은 이 두 보관 위치를 지우지 않습니다.

설치와 제거 전에 Cove를 완전히 종료하세요. 앱이 떠 있으면 설치/제거를 중단합니다. 알람이 켜져 창만 숨겨진 경우 파일 → Cove 종료를 사용하세요. 제거기는 패키지의 파일 목록만 지우고, 나중에 같은 설치 폴더 안에 생긴 다른 파일은 보존합니다.

알람은 앱 실행 중에만 울립니다. Windows 잠자기 깨우기는 구현하지 않았습니다. 미디어 명령은 Chromium Media Session을 사용하며 Mac의 MediaPlayer 네이티브 모듈은 포함하지 않습니다. 폴더 선택·탐색기 열기, 파일 추가·가사·기록·플레이리스트·대기열은 공통 구현입니다.

## 실기기 확인

1. 새 사용자에서 설치 → 첫 서재 만들기 → 파일/폴더/드래그 추가. EXE만으로 설치가 완료되고 Node.js가 별도로 필요하지 않은지 확인합니다.
2. 한글/공백/특수문자 경로, Music 밖의 폴더, 하위 폴더 자동 감지, 같은 이름의 다른 파일, 중복·잘못된 LRC를 확인합니다.
3. FLAC·MP3·M4A/AAC·ALAC·Ogg의 실제 소리, 긴 음원 탐색, 이전/다음·셔플·반복, 가사 현재 줄, 볼륨·음소거를 확인합니다.
4. 재생 중 코멘트·곡 정보 초안, 저장 실패 후 복구, 앱 재시작 시 설정/대기열 복원과 자동 재생 안 함을 확인합니다.
5. 알람 곡 선택·미리 듣기·순서·키보드 종료를 확인합니다. 화면 잠금/오디오 출력 장치는 따로 확인합니다.
6. 작은 창·실제 200% 확대·키보드 초점·팝오버/대화상자 닫기와 복귀를 확인합니다.
7. 서재/프로필을 백업하고 같은 설치 EXE로 업데이트한 뒤 기록·가사·음원 체크섬을 대조합니다. 제거 후에도 서재와 프로필이 남는지, 재설치 후 기존 서재를 다시 여는지 확인합니다.

저장소의 Checks and Windows package 워크플로는 실제 Windows runner에서 빌드와 합성 FLAC 재생 시작을 자동 검사하도록 준비했습니다. 이 로컬 준비 작업에서는 워크플로를 실행하지 않았습니다.

## 빌드

`npm ci` 후 NSIS를 설치합니다. Mac은 `brew install nsis`, Windows는 공식 NSIS 또는 `choco install nsis`를 사용할 수 있습니다. `makensis`를 PATH에 넣거나 `COVE_MAKENSIS`에 실행 파일의 전체 경로를 지정한 뒤 `npm run windows:build`를 실행합니다. Wine과 Xcode는 Windows 빌드에 필요하지 않습니다.

산출물은 `dist/Cove-win32-x64/`와 `dist/Cove-Setup-0.1.19-x64.exe`입니다. 실행 EXE는 64비트이며, 설치기 부트스트랩은 NSIS의 32비트 PE로 64비트 Windows에서 64비트 앱을 설치합니다. [NSIS 라이선스](NSIS-LICENSE.txt)를 함께 제공합니다.

참고: [Electron Packager](https://electron.github.io/packager/main/), [NSIS 스크립트/제거기](https://nsis.sourceforge.io/Docs/Chapter4.html). 인증서 서명과 Microsoft Store 배포는 별도 작업입니다.
