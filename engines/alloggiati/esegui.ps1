#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'RicevuteAlloggiati'),
    [switch]$Force
)

function Invoke-AlloggiatiRun {
    param([string]$Root, [switch]$ForceDownload)
    $ErrorActionPreference = 'Stop'
    Import-Module (Join-Path $PSScriptRoot 'alloggiati.psm1') -Force -DisableNameChecking
    $Root = [IO.Path]::GetFullPath($Root)
    if (-not [IO.Directory]::Exists($Root)) { Write-Host 'Esegui prima la configurazione.'; return 1 }
    $lock = $null
    $tls = [Net.ServicePointManager]::SecurityProtocol
    try {
        # Lock esclusivo condiviso con esecuzioni manuali: niente scaricamenti/pulizie concorrenti.
        try { $lock = [IO.File]::Open((Join-Path $Root 'esecuzione.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { return 0 }
        $config = Read-AlloggiatiJson (Join-Path $Root 'config.json')
        if ($null -eq $config -or @($config.profiles).Count -eq 0 -or -not [IO.File]::Exists($config.pythonPath)) {
            Write-Host 'Configurazione incompleta: riesegui configura.'; return 1
        }
        $previous = Read-AlloggiatiJson (Join-Path $Root 'stato.json')
        $profilesStatus = @()
        $failures = 0
        $now = [datetime]::UtcNow
        $today = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($now, 'W. Europe Standard Time').Date
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        foreach ($profile in @($config.profiles)) {
            $credential = $null
            $session = $null
            $old = @()
            if ($null -ne $previous) {
                $old = @($previous.profiles | Where-Object { $_.id -eq $profile.id } | Select-Object -First 1)
            }
            $last = $null
            if ($old.Count -gt 0 -and $old[0].lastScanUtc) {
                $last = [datetime]::Parse($old[0].lastScanUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            }
            $elapsedDays = 15
            if ($null -ne $last) {
                $lastRome = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($last, 'W. Europe Standard Time').Date
                $elapsedDays = ($today - $lastRome).Days
            }
            # Giorni del calendario italiano: cambio ora e secondi del task non spostano la cadenza.
            $due = $ForceDownload -or $null -eq $last -or $elapsedDays -ge 15
            $status = [ordered]@{
                id = $profile.id; label = $profile.label; lastScanUtc = $(if ($null -ne $last) { $last.ToString('o') } else { $null })
                nextScanUtc = $(if ($null -ne $last) { $last.AddDays(15).ToString('o') } else { $null })
                download = 'non dovuto'; delivery = 'non controllata'; newReceipts = 0
                missingDays = 0; errors = @(); archive = $null; pendingDelivery = $true
            }
            if (-not $due -and $old.Count -gt 0 -and
                $old[0].delivery -eq 'copia locale in Drive verificata; sincronizzazione cloud gestita da Drive') {
                # Tutto gia' consegnato: controllo di sola scadenza, senza credenziali, Python o PDF.
                $status.delivery = $old[0].delivery
                $status.pendingDelivery = $false
                $profilesStatus += [pscustomobject]$status
                Write-Host "$($profile.label): nessun recupero dovuto."
                continue
            }
            try {
                if ($profile.id -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw 'Invalid profile id' }
                $cache = Join-Path (Join-Path $Root 'archivio-locale') $profile.id
                [void][IO.Directory]::CreateDirectory($cache)
                $credential = Read-AlloggiatiCredential $Root $profile.id
                if ($due) {
                    Write-Host "$($profile.label): controllo ricevute degli ultimi 30 giorni..."
                    $session = New-AlloggiatiSession $credential
                    $errorMap = @{}
                    try { $errorMap = Get-AlloggiatiErrorMap $session }
                    catch { $status.errors += 'Tabella errori non disponibile: eventuali esiti sconosciuti saranno segnalati.' }
                    $dateErrors = 0
                    # Recupera dal giorno meno recente al piu' recente, escluso oggi.
                    for ($days = 30; $days -ge 1; $days--) {
                        $date = $today.AddDays(-$days)
                        $iso = $date.ToString('yyyy-MM-dd')
                        $cachePath = Join-Path $cache ($iso + '.pdf')
                        if ([IO.File]::Exists($cachePath)) {
                            $inspection = Invoke-AlloggiatiPdfTool $config.pythonPath @('inspect', $cachePath)
                            if ($inspection.ExitCode -eq 0 -and $inspection.Data.login -eq $credential.Username -and $inspection.Data.sentDate -eq $iso) { continue }
                            $dateErrors++
                            $status.errors += "$iso`: copia locale non valida o di altro account; conservata senza sovrascriverla."
                            continue
                        }
                        $temp = $cachePath + '.' + [guid]::NewGuid().ToString('N') + '.part'
                        try {
                            $pdf = Get-AlloggiatiReceipt $session $date $errorMap
                            if ($null -eq $pdf) { $status.missingDays++; continue }
                            [IO.File]::WriteAllBytes($temp, $pdf)
                            $inspection = Invoke-AlloggiatiPdfTool $config.pythonPath @('inspect', $temp)
                            if ($inspection.ExitCode -ne 0 -or $inspection.Data.login -ne $credential.Username -or $inspection.Data.sentDate -ne $iso) {
                                throw 'Unexpected PDF identity'
                            }
                            [IO.File]::Move($temp, $cachePath)
                            $status.newReceipts++
                        } catch {
                            $dateErrors++
                            $status.errors += "$iso`: $(Get-AlloggiatiSafeError $_)"
                        } finally {
                            if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
                        }
                    }
                    if ($dateErrors -eq 0) {
                        $status.lastScanUtc = $now.ToString('o')
                        $status.nextScanUtc = $now.AddDays(15).ToString('o')
                        $status.download = 'completato'
                    } else { $status.download = 'incompleto'; $failures++ }
                }
                # Il controllo quotidiano/accesso riprova la consegna locale a Drive senza riaccedere alla Questura.
                $archive = Invoke-AlloggiatiPdfTool $config.pythonPath @('sync', '--source-dir', $cache,
                    '--destination', $profile.destination, '--expected-login', $credential.Username)
                $status.archive = $archive.Data
                if ($archive.ExitCode -eq 0) {
                    $status.delivery = 'copia locale in Drive verificata; sincronizzazione cloud gestita da Drive'
                    $status.pendingDelivery = $false
                }
                else { $status.delivery = 'in attesa o da verificare'; $failures++ }
            } catch {
                $status.errors += Get-AlloggiatiSafeError $_
                $status.download = $(if ($due) { 'errore' } else { 'non dovuto' })
                $status.delivery = 'in attesa'
                $failures++
            } finally {
                if ($null -ne $credential) {
                    if ($credential.Password -is [Security.SecureString]) { $credential.Password.Dispose() }
                    if ($credential.WsKey -is [Security.SecureString]) { $credential.WsKey.Dispose() }
                }
                $session = $null
                $credential = $null
            }
            $profilesStatus += [pscustomobject]$status
            Write-Host "$($profile.label): $($status.download); $($status.delivery)."
        }
        $report = [ordered]@{ checkedUtc = [datetime]::UtcNow.ToString('o'); failures = $failures; profiles = $profilesStatus }
        Write-AlloggiatiJson (Join-Path $Root 'stato.json') $report
        $logRoot = Join-Path $Root 'log'
        [void][IO.Directory]::CreateDirectory($logRoot)
        $logFile = Join-Path $logRoot ($today.ToString('yyyy-MM') + '.log')
        $line = '{0} account={1} errori={2}' -f [datetime]::UtcNow.ToString('o'), $profilesStatus.Count, $failures
        [IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        return $(if ($failures -eq 0) { 0 } else { 1 })
    } catch {
        Write-Host (Get-AlloggiatiSafeError $_)
        return 1
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $tls
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-AlloggiatiRun -Root $StateRoot -ForceDownload:$Force)
}
