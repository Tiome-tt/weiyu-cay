!include nsDialogs.nsh
!include FileFunc.nsh
!include LogicLib.nsh

Var CayDataDialog
Var CayDataInput
Var CayDataPath
Var CayDataArgs
Var CayDataPageVisited

; Keep the standard Modern UI directory declaration, then add the data page.
; Tauri includes this file before declaring its pages. Compile coverage guards
; this small wrapper when upgrading the bundled NSIS/Modern UI version.
!macroundef MUI_PAGE_DIRECTORY
!macro MUI_PAGE_DIRECTORY
  !verbose push
  !verbose ${MUI_VERBOSE}
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGEDECLARATION_DIRECTORY
  !verbose pop
  !insertmacro CAY_DATA_PAGE
!macroend

!macro CAY_DATA_PAGE
Page custom CayDataPageCreate CayDataPageLeave

Function CayDataPageCreate
  IfSilent cay_data_skip
  ${GetParameters} $CayDataArgs
  ClearErrors
  ${GetOptions} $CayDataArgs "/P" $0
  IfErrors +2
    Goto cay_data_skip
  ClearErrors
  ${GetOptions} $CayDataArgs "/UPDATE" $0
  IfErrors +2
    Goto cay_data_skip
  !insertmacro MUI_HEADER_TEXT "数据保存位置" "选择首次使用的数据文件夹"
  nsDialogs::Create 1018
  StrCpy $CayDataPageVisited 1
  Pop $CayDataDialog
  ${If} $CayDataDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 18u "微屿 · 数据保存位置"
  Pop $0
  ${NSD_CreateLabel} 0 26u 100% 48u "可选择空文件夹保存笔记、附件和图片。留空使用系统默认位置。$\r$\n此选择仅对首次使用生效；已有资料库保持原位置，请在设置中迁移。"
  Pop $0
  ${NSD_CreateText} 0 82u 76% 14u "$CayDataPath"
  Pop $CayDataInput
  ${NSD_CreateButton} 79% 82u 21% 14u "浏览…"
  Pop $0
  ${NSD_OnClick} $0 CayChooseDataFolder
  nsDialogs::Show
  Return
cay_data_skip:
  Abort
FunctionEnd

Function CayChooseDataFolder
  Pop $0
  nsDialogs::SelectFolderDialog "选择空的数据文件夹" "$CayDataPath"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $CayDataInput $0
  ${EndIf}
FunctionEnd

Function CayDataPageLeave
  ${NSD_GetText} $CayDataInput $CayDataPath
  ${If} $CayDataPath == ""
    Return
  ${EndIf}
  ${GetRoot} "$CayDataPath" $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "请输入完整的数据文件夹路径，或留空使用默认位置。"
    Abort
  ${EndIf}
  IfFileExists "$CayDataPath\*.*" 0 cay_data_valid
  FindFirst $0 $1 "$CayDataPath\*.*"
cay_data_entries:
  ${If} $1 != ""
  ${AndIf} $1 != "."
  ${AndIf} $1 != ".."
    FindClose $0
    MessageBox MB_ICONEXCLAMATION "请选择空文件夹，已有文件不会被覆盖或移动。"
    Abort
  ${EndIf}
  FindNext $0 $1
  IfErrors cay_data_done cay_data_entries
cay_data_done:
  FindClose $0
cay_data_valid:
FunctionEnd
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $CayDataPageVisited == 1
    WriteRegStr HKCU "Software\app.simplenotes.desktop" "InstallDataPath" "$CayDataPath"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Only the initial preference is removed; never remove any library directory.
  DeleteRegValue HKCU "Software\app.simplenotes.desktop" "InstallDataPath"
!macroend
