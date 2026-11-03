#requires -Version 5.1
# Funzioni SOAP derivate dalla prova verificata; nessun accesso interattivo.
function Stop-AlloggiatiProva {
    param([string]$Messaggio)
    $errore = [System.InvalidOperationException]::new($Messaggio)
    $errore.Data['AlloggiatiSafe'] = $true
    throw $errore
}

function New-AlloggiatiEnvelope {
    param(
        [ValidateSet('GenerateToken', 'Authentication_Test', 'Ricevuta', 'Tabella')]
        [string]$Operazione,
        [System.Collections.IDictionary]$Campi
    )
    $documento = [System.Xml.XmlDocument]::new()
    $envelope = $documento.CreateElement('soap', 'Envelope', 'http://schemas.xmlsoap.org/soap/envelope/')
    [void]$documento.AppendChild($envelope)
    $body = $documento.CreateElement('soap', 'Body', $envelope.NamespaceURI)
    [void]$envelope.AppendChild($body)
    $metodo = $documento.CreateElement($Operazione, 'AlloggiatiService')
    [void]$body.AppendChild($metodo)
    foreach ($nome in $Campi.Keys) {
        $elemento = $documento.CreateElement([string]$nome, 'AlloggiatiService')
        $elemento.InnerText = [string]$Campi[$nome]
        [void]$metodo.AppendChild($elemento)
    }
    return $documento.OuterXml
}

function Read-AlloggiatiResponse {
    param(
        [string]$Contenuto,
        [ValidateSet('GenerateToken', 'Authentication_Test', 'Ricevuta', 'Tabella')]
        [string]$Operazione
    )
    $settings = [System.Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 32MB
    $reader = $null
    $source = [System.IO.StringReader]::new($Contenuto)
    try {
        $reader = [System.Xml.XmlReader]::Create($source, $settings)
        $documento = [System.Xml.XmlDocument]::new()
        $documento.XmlResolver = $null
        $documento.Load($reader)
    } catch {
        Stop-AlloggiatiProva "[$Operazione] Risposta XML non valida. Nessun contenuto della risposta e' stato mostrato."
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        $source.Dispose()
    }
    $ns = [System.Xml.XmlNamespaceManager]::new($documento.NameTable)
    $ns.AddNamespace('soap', 'http://schemas.xmlsoap.org/soap/envelope/')
    $ns.AddNamespace('a', 'AlloggiatiService')
    if ($null -ne $documento.SelectSingleNode('/soap:Envelope/soap:Body/soap:Fault', $ns)) {
        Stop-AlloggiatiProva "[$Operazione] Il servizio ha restituito un errore SOAP."
    }
    $risposta = $documento.SelectSingleNode("/soap:Envelope/soap:Body/a:${Operazione}Response", $ns)
    if ($null -eq $risposta) {
        Stop-AlloggiatiProva "[$Operazione] Formato della risposta inatteso."
    }
    return ,$risposta
}

function Get-AlloggiatiField {
    param([System.Xml.XmlElement]$Nodo, [string]$Nome)
    if ($null -eq $Nodo) { return '' }
    if ($Nodo.HasAttribute($Nome)) { return $Nodo.GetAttribute($Nome) }
    $elemento = $Nodo.SelectSingleNode("*[local-name()='$Nome']")
    if ($null -ne $elemento) { return $elemento.InnerText }
    return ''
}

function Assert-AlloggiatiResult {
    param([System.Xml.XmlElement]$Risposta, [string]$NomeRisultato, [string]$Fase)
    $risultato = $Risposta.SelectSingleNode("*[local-name()='$NomeRisultato']")
    $esito = Get-AlloggiatiField -Nodo $risultato -Nome 'esito'
    if ($esito -notin @('true', '1')) {
        $codice = Get-AlloggiatiField -Nodo $risultato -Nome 'ErroreCod'
        if ($codice -notmatch '^\d{1,6}$') { $codice = 'non disponibile' }
        Stop-AlloggiatiProva "[$Fase] Operazione non riuscita o esito assente. Codice servizio: $codice."
    }
}

function Invoke-AlloggiatiRequest {
    param(
        [ValidateSet('GenerateToken', 'Authentication_Test', 'Ricevuta', 'Tabella')]
        [string]$Operazione,
        [System.Collections.IDictionary]$Campi
    )
    $envelope = New-AlloggiatiEnvelope -Operazione $Operazione -Campi $Campi
    try {
        # Destinazione fissa, HTTPS con validazione certificato e nessun redirect.
        $rispostaHttp = Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri 'https://alloggiatiweb.poliziadistato.it/service/Service.asmx' `
            -ContentType 'text/xml; charset=utf-8' `
            -Headers @{ SOAPAction = "`"AlloggiatiService/$Operazione`"" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($envelope)) `
            -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
    } catch {
        Stop-AlloggiatiProva "[$Operazione] Richiesta non completata: controllare connessione e disponibilita' del portale."
    } finally {
        $envelope = $null
    }
    if ([int]$rispostaHttp.StatusCode -ne 200) {
        Stop-AlloggiatiProva "[$Operazione] Il servizio non ha risposto con HTTP 200."
    }
    return Read-AlloggiatiResponse -Contenuto $rispostaHttp.Content -Operazione $Operazione
}

function ConvertFrom-AlloggiatiSecret {
    param([System.Security.SecureString]$Valore)
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Valore)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function ConvertFrom-AlloggiatiPdf {
    param([string]$Base64)
    try { $bytes = [System.Convert]::FromBase64String($Base64) }
    catch { Stop-AlloggiatiProva "[Ricevuta] Il contenuto ricevuto non e' un PDF decodificabile." }
    if ($bytes.Length -lt 5 -or [System.Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ne '%PDF-') {
        Stop-AlloggiatiProva '[Ricevuta] PDF vuoto o intestazione PDF assente.'
    }
    return ,$bytes
}

