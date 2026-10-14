; Compile-only harness. Do not install this diagnostic binary.
; Invoke makensis with an absolute script path, or use its /NOCD option.
Unicode true
Name "Cay installer hook compile check"
OutFile "${__FILEDIR__}\..\src-tauri\target\installer-hooks-smoke.exe"
RequestExecutionLevel user
!include MUI2.nsh
!include "${__FILEDIR__}\..\src-tauri\windows\hooks.nsh"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
Section "Uninstall"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
