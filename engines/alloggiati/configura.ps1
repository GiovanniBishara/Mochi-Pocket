#requires -Version 5.1
<#
.SYNOPSIS
  Configura il recupero delle ricevute Alloggiati Web per Mochi Pocket.

.DESCRIPTION
  Per ogni struttura chiede nome utente, password e chiave del web service di
  Alloggiati Web. Le credenziali sono salvate cifrate con DPAPI: leggibili solo
  da questo utente Windows su questo PC. Scrive config.json con le cartelle in cui
  copiare le ricevute e, se richiesto, pianifica il controllo ogni giorno.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File engines\alloggiati\configura.ps1
#>
[CmdletBinding()]
param(
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'MochiPocket\alloggiati'),
    [string]$PythonPath = ''
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'alloggiati.psm1') -Force -DisableNameChecking
[void][IO.Directory]::CreateDirectory($StateRoot)

if (-not $PythonPath) {
    $found = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $PythonPath = $found.Source }
}
if (-not $PythonPath -or -not [IO.File]::Exists($PythonPath)) {
    $PythonPath = Read-Host 'Percorso completo di python.exe'
}

$profiles = @()
do {
    Write-Host ''
    $label = Read-Host 'Nome della struttura (come vuoi vederlo in Mochi)'
    $id = ($label.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
    if ($id -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { Write-Host 'Nome non valido, riprova.'; continue }
    $destination = Read-Host 'Cartella dove copiare le ricevute PDF (es. una cartella di Google Drive)'
    $user = Read-Host 'Alloggiati Web: nome utente'
    $password = Read-Host 'Alloggiati Web: password' -AsSecureString
    $wskey = Read-Host 'Alloggiati Web: chiave web service (WsKey)' -AsSecureString
    Save-AlloggiatiCredential -StateRoot $StateRoot -ProfileId $id -Username $user -Password $password -WsKey $wskey
    $password.Dispose(); $wskey.Dispose()
    $profiles += [ordered]@{ id = $id; label = $label; destination = $destination }
    Write-Host "Struttura '$label' salvata."
} while ((Read-Host 'Aggiungere un''altra struttura? (s/n)') -match '^[sS]')

Write-AlloggiatiJson (Join-Path $StateRoot 'config.json') ([ordered]@{ pythonPath = $PythonPath; profiles = $profiles })
Write-Host "Configurazione salvata in $StateRoot"

if ((Read-Host 'Controllare le ricevute ogni giorno alle 9 anche con Mochi chiuso? (s/n)') -match '^[sS]') {
    $script = Join-Path $PSScriptRoot 'esegui.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -StateRoot `"$StateRoot`""
    $trigger = New-ScheduledTaskTrigger -Daily -At 9am
    Register-ScheduledTask -TaskName 'Mochi Pocket - Alloggiati' -Action $action -Trigger $trigger -Force | Out-Null
    Write-Host 'Pianificato. Il recupero vero avviene ogni 15 giorni; i controlli intermedi non accedono al portale.'
}
