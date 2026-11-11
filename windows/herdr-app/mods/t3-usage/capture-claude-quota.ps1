param(
    [string]$HomePath = $env:USERPROFILE,
    [datetime]$NowUtc = [datetime]::UtcNow,
    [string]$InputJson
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-JsonProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-SafeLabel {
    param(
        [object]$Value,
        [int]$MaximumLength = 80
    )

    if (-not ($Value -is [string]) -or $Value.Length -lt 1 -or $Value.Length -gt $MaximumLength) {
        return $null
    }
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        return $null
    }
    return $Value
}

function Get-FinitePercent {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    $typeCode = [Type]::GetTypeCode($Value.GetType())
    $numericCodes = @(
        [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
        [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
        [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
    )
    if ($numericCodes -notcontains $typeCode) {
        return $null
    }
    [double]$number = 0
    if (-not [double]::TryParse(
        $Value.ToString(),
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        return $null
    }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0 -or $number -gt 100) {
        return $null
    }
    return $number
}

function Get-ResetEpoch {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    $typeCode = [Type]::GetTypeCode($Value.GetType())
    $numericCodes = @(
        [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
        [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
        [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
    )
    if ($numericCodes -notcontains $typeCode) {
        return $null
    }
    [decimal]$number = 0
    if (-not [decimal]::TryParse(
        $Value.ToString(),
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        return $null
    }
    if ($number -lt 0 -or $number -gt 253402300799 -or [decimal]::Truncate($number) -ne $number) {
        return $null
    }
    try {
        [void][datetimeoffset]::FromUnixTimeSeconds([long]$number)
        return [long]$number
    }
    catch {
        return $null
    }
}

function Convert-ToEffectiveUtc {
    param([datetime]$Value)

    if ($Value.Kind -eq [DateTimeKind]::Local) {
        return [datetimeoffset]$Value.ToUniversalTime()
    }
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
        return [datetimeoffset]([datetime]::SpecifyKind($Value, [DateTimeKind]::Utc))
    }
    return [datetimeoffset]$Value
}

function Write-AtomicUtf8 {
    param(
        [string]$Path,
        [string]$Content
    )

    $directory = [IO.Path]::GetDirectoryName($Path)
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $encoding = New-Object Text.UTF8Encoding($false)
    $committed = $false
    try {
        [IO.File]::WriteAllText($temporary, $Content, $encoding)
        for ($attempt = 0; $attempt -lt 3 -and -not $committed; $attempt++) {
            try {
                if ([IO.File]::Exists($Path)) {
                    [IO.File]::Replace($temporary, $Path, $null)
                }
                else {
                    [IO.File]::Move($temporary, $Path)
                }
                $committed = $true
            }
            catch {
                if ($attempt -eq 2) {
                    throw
                }
            }
        }
    }
    finally {
        if (-not $committed -and [IO.File]::Exists($temporary)) {
            [IO.File]::Delete($temporary)
        }
    }
}

# Claude reads the status line as UTF-8; the separator is built from its code point because
# Windows PowerShell 5.1 reads a BOM-less script as ANSI.
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch {}
$dot = ' ' + [char]0x00B7 + ' '

try {
    if ([string]::IsNullOrWhiteSpace($HomePath)) {
        throw 'Invalid home.'
    }
    $raw = if ($PSBoundParameters.ContainsKey('InputJson')) {
        $InputJson
    }
    else {
        [Console]::In.ReadToEnd()
    }
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw.Length -gt 2097152) {
        throw 'Invalid status-line input.'
    }
    $inputObject = $raw | ConvertFrom-Json -ErrorAction Stop
    $now = Convert-ToEffectiveUtc $NowUtc
    $rateLimits = Get-JsonProperty $inputObject 'rate_limits'
    $projectedLimits = [ordered]@{}
    $statusParts = New-Object 'System.Collections.Generic.List[string]'

    foreach ($definition in @(
        [pscustomobject]@{ Source = 'five_hour'; Target = 'fiveHour'; Label = '5h' },
        [pscustomobject]@{ Source = 'seven_day'; Target = 'sevenDay'; Label = '7d' }
    )) {
        $sourceWindow = Get-JsonProperty $rateLimits $definition.Source
        if ($null -eq $sourceWindow) {
            continue
        }
        $used = Get-FinitePercent (Get-JsonProperty $sourceWindow 'used_percentage')
        $reset = Get-ResetEpoch (Get-JsonProperty $sourceWindow 'resets_at')
        if ($null -eq $used -or $null -eq $reset) {
            continue
        }
        $projectedLimits[$definition.Target] = [ordered]@{
            usedPercent = $used
            resetsAt = $reset
        }
        $shown = $used.ToString('0.#', [Globalization.CultureInfo]::InvariantCulture)
        $statusParts.Add(('{0} {1}%' -f $definition.Label, $shown))
    }

    $projection = [ordered]@{
        schema = 1
        observedAt = $now.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        rateLimits = $projectedLimits
    }
    $model = Get-JsonProperty $inputObject 'model'
    $modelId = Get-SafeLabel (Get-JsonProperty $model 'id')
    if ($null -ne $modelId) {
        $projection['modelId'] = $modelId
    }
    $version = Get-SafeLabel (Get-JsonProperty $inputObject 'version') 40
    if ($null -ne $version) {
        $projection['version'] = $version
    }

    $destination = [IO.Path]::Combine($HomePath, '.config', 'herdr-app', 'data', 't3-usage', 'claude-quota.json')
    $json = $projection | ConvertTo-Json -Depth 5 -Compress
    Write-AtomicUtf8 -Path $destination -Content $json

    # As herdr-agent-usage's status line: "<model> · <usage>".
    $displayName = Get-JsonProperty $model 'display_name'
    $label = if ($displayName -is [string] -and $displayName.Length -le 40 -and $displayName -match '^[A-Za-z0-9 ._()-]+$') { $displayName } else { 'Claude' }
    if ($statusParts.Count -gt 0) {
        Write-Output ($label + $dot + ($statusParts -join $dot))
    }
    else {
        Write-Output ($label + $dot + 'quota after first reply')
    }
}
catch {
    Write-Output 'Claude quota unavailable'
}
