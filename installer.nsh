!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER

!macro customUnInstall
  Push $0
  ClearErrors
  ReadRegStr $0 HKCU "Software\Classes\dfy-dsh-notification\shell\open\command" ""
  # Only remove the exact packaged-app command registered by Electron.
  # A different installation, custom command, or development handler stays intact.
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\dfy-dsh-notification"
  ${EndIf}
  # The elevated runtime uses reg.exe /reg:64 for its machine-level fallback.
  ${If} ${RunningX64}
    SetRegView 64
    ClearErrors
    ReadRegStr $0 HKLM "Software\Classes\dfy-dsh-notification\shell\open\command" ""
    ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKLM "Software\Classes\dfy-dsh-notification"
    ${EndIf}
    SetRegView lastused
  ${EndIf}
  Pop $0
  # Missing keys or denied machine-level access must not interrupt uninstall.
  ClearErrors
!macroend

Var DeleteDesktopDataCheckbox

Function un.DesktopDataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "本地数据"
  Pop $0

  ${NSD_CreateLabel} 0 24u 100% 34u "桌面端已卸载。你可以保留运行时、缓存、窗口状态和开发设置，方便以后重新安装。"
  Pop $0

  ${NSD_CreateCheckbox} 0 66u 100% 24u "同时删除桌面端本地数据"
  Pop $DeleteDesktopDataCheckbox
  ${NSD_Uncheck} $DeleteDesktopDataCheckbox

  ${NSD_CreateLabel} 18u 96u 94% 36u "不会删除官方 Harness 的 ~/.dsh；其中的会话、配置、凭据、Profile 和扩展会继续保留。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.DesktopDataPageLeave
  ${NSD_GetState} $DeleteDesktopDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    SetShellVarContext current
    DetailPrint "Deleting DFY DSH Desktop local data..."
    RMDir /r "$PROFILE\.saltfish\dfy-dsh-desktop"
    RMDir /r "$PROFILE\.saltfish\deepseek-harness-desktop"
    # Remove the vendor directory only when no other Saltfish product uses it.
    RMDir "$PROFILE\.saltfish"
  ${EndIf}
FunctionEnd

!macro customUninstallPage
  UninstPage custom un.DesktopDataPageCreate un.DesktopDataPageLeave
!macroend

!endif
