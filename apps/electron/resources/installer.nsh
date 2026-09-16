; Copis 的 NSIS 升级扩展。
; 自动更新不使用 /S，因此保留标准安装进度页；下列宏会跳过普通安装交互并在结束后启动新版。

!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!macro customInstall
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    ; 所有文件已写入目标目录后才启动新版，避免从 NSIS 临时目录重启。
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    Quit
  ${endif}
!macroend
