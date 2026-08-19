; Ticket 22: current-user Windows x64 installer hook.
; The bootstrapper is a hash-verified bundle resource. Tauri's network-download
; mode stays disabled so a mutable URL can never enter the package unnoticed.

; ${__FILEDIR__} inside a macro body expands at macro-insert time, when the
; current file is the generated installer.nsi. Capture this hook's own
; directory now, while the included file is being parsed.
!define XIAOJING_HOOK_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${If} $4 == ""
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    InitPluginsDir
    File "/oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" "${XIAOJING_HOOK_DIR}\..\resources\windows-prerequisites\MicrosoftEdgeWebview2Setup.exe"
    IfFileExists "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" 0 xiaojing_webview_missing
    DetailPrint "Installing the bundled Microsoft Edge WebView2 prerequisite..."
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
    ${If} $1 != 0
      Abort "Microsoft Edge WebView2 setup failed with exit code $1. The application was not installed."
    ${EndIf}
    Goto xiaojing_webview_done

    xiaojing_webview_missing:
      Abort "The verified Microsoft Edge WebView2 setup resource is missing. The application was not installed."
    xiaojing_webview_done:
  ${EndIf}
!macroend

; Intentionally no data-removal hooks. Tauri removes installed program files;
; %LOCALAPPDATA%\Xiaojing remains owned by the application data layer.
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
