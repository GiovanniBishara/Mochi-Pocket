#requires -Version 5.1
. (Join-Path $PSScriptRoot 'api.ps1')

function Write-AlloggiatiJson {
    param([string]$Path, [object]$Value)
    $parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
    [void][System.IO.Directory]::CreateDirectory($parent)
    $temporary = Join-Path $parent ([guid]::NewGuid().ToString('N') + '.tmp')
    $backup = $temporary + '.previous'
    try {
        [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 15), [System.Text.UTF8Encoding]::new($false))
        if ([System.IO.File]::Exists($Path)) {
            # In Windows PowerShell 5.1 $null viene convertito in stringa vuota per il backup.
            [System.IO.File]::Replace($temporary, $Path, $backup)
            [System.IO.File]::Delete($backup)
        }
        else { [System.IO.File]::Move($temporary, $Path) }
    } finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Read-AlloggiatiJson {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Get-AlloggiatiCredentialPath {
    param([string]$StateRoot, [string]$ProfileId)
    if ($ProfileId -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') {
        Stop-AlloggiatiProva '[Configurazione] Identificatore account non valido.'
    }
    return Join-Path (Join-Path $StateRoot 'credenziali') ($ProfileId + '.xml')
}

function Save-AlloggiatiCredential {
    param(
        [string]$StateRoot, [string]$ProfileId, [string]$Username,
        [System.Security.SecureString]$Password, [System.Security.SecureString]$WsKey
    )
    if ([string]::IsNullOrWhiteSpace($Username) -or $Password.Length -eq 0 -or $WsKey.Length -eq 0) {
        Stop-AlloggiatiProva '[Configurazione] Credenziali vuote.'
    }
    $path = Get-AlloggiatiCredentialPath $StateRoot $ProfileId
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $temporary + '.previous'
    try {
        # Su Windows Export-Clixml protegge SecureString con DPAPI dell'utente corrente.
        [pscustomobject]@{ Username = $Username.Trim(); Password = $Password; WsKey = $WsKey } |
            Export-Clixml -LiteralPath $temporary -Encoding UTF8 -ErrorAction Stop
        if ([System.IO.File]::Exists($path)) {
            [System.IO.File]::Replace($temporary, $path, $backup)
            [System.IO.File]::Delete($backup)
        }
        else { [System.IO.File]::Move($temporary, $path) }
    } finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Read-AlloggiatiCredential {
    param([string]$StateRoot, [string]$ProfileId)
    try {
        $credential = Import-Clixml -LiteralPath (Get-AlloggiatiCredentialPath $StateRoot $ProfileId) -ErrorAction Stop
        if ($credential.Password -isnot [System.Security.SecureString] -or
            $credential.WsKey -isnot [System.Security.SecureString] -or
            [string]::IsNullOrWhiteSpace($credential.Username)) { throw 'Invalid credential' }
        return $credential
    } catch { Stop-AlloggiatiProva '[Credenziali] Configurazione assente o non leggibile da questo utente Windows. Riesegui configura.' }
}

function New-AlloggiatiSession {
    param([object]$Credential)
    $password = $null
    $key = $null
    try {
        $password = ConvertFrom-AlloggiatiSecret $Credential.Password
        $key = (ConvertFrom-AlloggiatiSecret $Credential.WsKey).Trim()
        $response = Invoke-AlloggiatiRequest 'GenerateToken' ([ordered]@{
            Utente = $Credential.Username; Password = $password; WsKey = $key; result = ''
        })
        Assert-AlloggiatiResult $response 'result' 'Autenticazione'
        $token = Get-AlloggiatiField ($response.SelectSingleNode("*[local-name()='GenerateTokenResult']")) 'token'
        if ([string]::IsNullOrWhiteSpace($token)) { Stop-AlloggiatiProva '[Autenticazione] Token assente.' }
        $session = [pscustomobject]@{ Username = $Credential.Username; Token = $token }
        $check = Invoke-AlloggiatiRequest 'Authentication_Test' ([ordered]@{ Utente = $session.Username; token = $session.Token })
        Assert-AlloggiatiResult $check 'Authentication_TestResult' 'Verifica accesso'
        return $session
    } finally { $password = $null; $key = $null }
}

function Get-AlloggiatiErrorMap {
    param([object]$Session)
    $response = Invoke-AlloggiatiRequest 'Tabella' ([ordered]@{
        Utente = $Session.Username; token = $Session.Token; tipo = 'TipoErrore'; CSV = ''
    })
    Assert-AlloggiatiResult $response 'TabellaResult' 'Tabella errori'
    $csv = Get-AlloggiatiField $response 'CSV'
    $map = @{}
    foreach ($line in ($csv -split '\r?\n')) {
        $columns = $line.Split(';', 2)
        if ($columns.Length -eq 2 -and $columns[0].Trim('"', ' ') -match '^\d{1,6}$') {
            $map[$columns[0].Trim('"', ' ')] = $columns[1].Trim('"', ' ')
        }
    }
    return $map
}

function Test-AlloggiatiMissingReceipt {
    param([string]$Description)
    # Classificazione conservativa: non confondere un errore generico con un giorno senza invii.
    $normalized = [regex]::Replace($Description.ToUpperInvariant().Normalize([Text.NormalizationForm]::FormD), '\p{Mn}', '')
    $normalized = [regex]::Replace($normalized, '[^A-Z0-9]+', '_').Trim('_')
    return $normalized -match '^(NO_RICEVUTA|NESSUNA_RICEVUTA(_DISPONIBILE|_PRESENTE|_TROVATA|_PER_LA_DATA_INDICATA)?|(LA_)?RICEVUTA(_RICHIESTA)?_NON_(E_)?(PRESENTE|DISPONIBILE|TROVATA|ESISTENTE)(_PER_LA_DATA_RICHIESTA)?)$'
}

function Get-AlloggiatiReceipt {
    param([object]$Session, [datetime]$Date, [hashtable]$ErrorMap)
    $response = Invoke-AlloggiatiRequest 'Ricevuta' ([ordered]@{
        Utente = $Session.Username; token = $Session.Token; Data = $Date.ToString("yyyy-MM-dd'T'00:00:00"); PDF = ''
    })
    $result = $response.SelectSingleNode("*[local-name()='RicevutaResult']")
    $success = Get-AlloggiatiField $result 'esito'
    if ($success -notin @('true', '1')) {
        $code = Get-AlloggiatiField $result 'ErroreCod'
        $description = Get-AlloggiatiField $result 'ErroreDes'
        $detail = Get-AlloggiatiField $result 'ErroreDettaglio'
        # Verificato sul servizio: 51 e' ERRORE_RECUPERO_RICEVUTA (generico).
        # Solo il dettaglio esplicito di assenza rende normale la data senza ricevuta.
        if ($code -eq '51' -and (Test-AlloggiatiMissingReceipt $detail)) { return $null }
        if (Test-AlloggiatiMissingReceipt $description) { return $null }
        if ($null -ne $ErrorMap -and $ErrorMap.ContainsKey($code) -and (Test-AlloggiatiMissingReceipt $ErrorMap[$code])) { return $null }
        Assert-AlloggiatiResult $response 'RicevutaResult' 'Ricevuta'
    }
    return ,(ConvertFrom-AlloggiatiPdf (Get-AlloggiatiField $response 'PDF'))
}

function Invoke-AlloggiatiPdfTool {
    param([string]$PythonPath, [string[]]$Arguments)
    $process = [Diagnostics.Process]::new()
    try {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $PythonPath
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $parameters = @('-B', '-I', (Join-Path $PSScriptRoot 'ricevute.py')) + $Arguments
        $quoted = foreach ($value in $parameters) {
            if ($value -match '["\r\n]') { Stop-AlloggiatiProva '[PDF] Argomento locale non valido.' }
            '"' + ($value -replace '(\\+)$', '$1$1') + '"'
        }
        $start.Arguments = $quoted -join ' '
        $process.StartInfo = $start
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(300000)) {
            $process.Kill()
            Stop-AlloggiatiProva '[PDF] Tempo massimo di elaborazione superato.'
        }
        $raw = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
    } finally { $process.Dispose() }
    try { $data = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-AlloggiatiProva '[PDF] Impossibile leggere la risposta dello strumento PDF locale.' }
    return [pscustomobject]@{ ExitCode = $exitCode; Data = $data }
}

function Get-AlloggiatiSafeError {
    param([System.Management.Automation.ErrorRecord]$Record)
    if ($Record.Exception.Data.Contains('AlloggiatiSafe')) { return $Record.Exception.Message }
    return '[Errore locale] Controllare configurazione, spazio disponibile e permessi delle cartelle.'
}

Export-ModuleMember -Function Write-AlloggiatiJson, Read-AlloggiatiJson, Save-AlloggiatiCredential,
    Read-AlloggiatiCredential, New-AlloggiatiSession, Get-AlloggiatiErrorMap, Get-AlloggiatiReceipt,
    Invoke-AlloggiatiPdfTool, Get-AlloggiatiSafeError, Test-AlloggiatiMissingReceipt
