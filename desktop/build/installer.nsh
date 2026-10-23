; electron-builder 26.15.3's default check matches any process under $INSTDIR when PowerShell
; is available, including the running uninstaller itself. That causes a false "cannot be closed"
; dialog and leaves the uninstaller file locked. Check by exact process name instead.
!include "LogicLib.nsh"

!macro customCheckAppRunning
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq Infinite Canvas.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"Infinite Canvas.exe\""`
  Pop $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${EndIf}
    nsExec::Exec `"$CmdPath" /C taskkill /F /IM "Infinite Canvas.exe" /T`
    Pop $R0
    Sleep 1000
  ${EndIf}
!macroend
