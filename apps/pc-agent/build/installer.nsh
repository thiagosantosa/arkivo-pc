; Arkivo para PC — passos extras do instalador NSIS (incluído pelo electron-builder via nsis.include).
; Libera a porta TCP 47800 (servidor local do modo direto) SOMENTE no perfil de rede "Privada"
; e SOMENTE para o executável do Arkivo. Em redes "Públicas" o celular usa o relay.
; Requer instalação com elevação (nsis.perMachine: true).

!macro customInstall
  DetailPrint "Configurando o Firewall do Windows para o Arkivo (porta 47800, rede privada)..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Arkivo para PC (LAN 47800)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Arkivo para PC (LAN 47800)" dir=in action=allow protocol=TCP localport=47800 profile=private program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes description="Recebe backups do celular na mesma rede Wi-Fi"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Aviso: não foi possível criar a regra de firewall (código $0). O envio direto pode pedir permissão na primeira execução."
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Arkivo para PC (LAN 47800)"'
  Pop $0
!macroend
