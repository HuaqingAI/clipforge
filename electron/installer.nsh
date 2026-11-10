; Resource downloads are part of installation, never part of the first paid action.
!macro customInstall
  DetailPrint "正在联网准备 ClipForge 工具与模型，请完成安装准备窗口。"
  ${If} ${Silent}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-runtime --silent' $0
  ${Else}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-runtime' $0
  ${EndIf}
  ${If} $0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "ClipForge 运行资源尚未安装完成（退出码 $0）。请检查网络、磁盘空间，并关闭已运行的 ClipForge 后重新运行安装程序。已下载的资源将在重试时复用。"
    ${EndIf}
    SetErrorLevel 1
    Abort "工具与模型安装未完成。"
  ${EndIf}
!macroend
