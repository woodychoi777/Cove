# -*- coding: utf-8 -*-
Unicode True
!include "MUI2.nsh"
!include "x64.nsh"
Name "Cove"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Cove"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Cove"
VIAddVersionKey "FileDescription" "Cove Setup"
VIAddVersionKey "CompanyName" "woodychoi777"
VIAddVersionKey "LegalCopyright" "Copyright 2026 woodychoi"
VIAddVersionKey "FileVersion" "${VERSION}"
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Cove.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${ROOT}/LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Cove requires 64-bit Windows."
    Abort
  ${EndIf}
  SetShellVarContext current
  ; Never allow /D= to turn an arbitrary music folder into an installation target.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Cove"
  FindWindow $0 "Chrome_WidgetWin_1" "Cove"
  StrCmp $0 0 done
  MessageBox MB_OK|MB_ICONEXCLAMATION "Cove를 완전히 종료한 뒤 설치해 주세요. / Close Cove before installing."
  Abort
  done:
FunctionEnd
Section "Cove"
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Cove"
  CreateShortcut "$SMPROGRAMS\Cove\Cove.lnk" "$INSTDIR\Cove.exe"
  CreateShortcut "$SMPROGRAMS\Cove\Uninstall Cove.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Cove.lnk" "$INSTDIR\Cove.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "DisplayName" "Cove"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "Publisher" "woodychoi777"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove" "NoRepair" 1
SectionEnd
Function un.onInit
  SetShellVarContext current
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\Cove" 0 invalid
  FindWindow $0 "Chrome_WidgetWin_1" "Cove"
  StrCmp $0 0 done
  MessageBox MB_OK|MB_ICONEXCLAMATION "Cove를 완전히 종료한 뒤 제거해 주세요. / Close Cove before uninstalling."
  Abort
  invalid:
  MessageBox MB_OK|MB_ICONSTOP "설치 위치를 확인할 수 없어 파일을 보존합니다. / Unexpected installation location; no files removed."
  Abort
  done:
FunctionEnd
Section "Uninstall"
  ; AppData and Music/Cove belong to the user and are deliberately preserved.
  Delete "$DESKTOP\Cove.lnk"
  Delete "$SMPROGRAMS\Cove\Cove.lnk"
  Delete "$SMPROGRAMS\Cove\Uninstall Cove.lnk"
  RMDir "$SMPROGRAMS\Cove"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cove"
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
