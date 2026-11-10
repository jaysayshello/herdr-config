param(
    [string]$HomePath = $env:USERPROFILE,
    [datetime]$NowUtc = [datetime]::UtcNow,
    [datetime]$PeriodStartUtc,
    [switch]$SkipLiveQuota
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Convert-ToUtcDateTimeOffset {
    param([object]$Value)

    if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    [datetimeoffset]$parsed = [datetimeoffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [datetimeoffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $null
    }
    return $parsed.ToUniversalTime()
}

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

function Get-UsageCount {
    param(
        [object]$Object,
        [string]$Name
    )

    $result = [pscustomobject]@{ Present = $false; Value = [long]0 }
    if ($null -eq $Object) {
        return $result
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $result
    }

    $typeCode = [Type]::GetTypeCode($property.Value.GetType())
    $numericCodes = @(
        [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
        [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
        [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
    )
    if ($numericCodes -notcontains $typeCode) {
        return $result
    }

    [decimal]$number = 0
    if (-not [decimal]::TryParse(
        $property.Value.ToString([Globalization.CultureInfo]::InvariantCulture),
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        return $result
    }
    if ($number -lt 0 -or $number -gt [long]::MaxValue -or [decimal]::Truncate($number) -ne $number) {
        return $result
    }

    $result.Present = $true
    $result.Value = [long]$number
    return $result
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

function Convert-LocalBoundaryToUtc {
    param(
        [datetime]$Value,
        [TimeZoneInfo]$TimeZone
    )

    $localValue = [datetime]::SpecifyKind($Value, [DateTimeKind]::Unspecified)
    while ($TimeZone.IsInvalidTime($localValue)) {
        $localValue = $localValue.AddMinutes(1)
    }
    if ($TimeZone.IsAmbiguousTime($localValue)) {
        $offsets = $TimeZone.GetAmbiguousTimeOffsets($localValue)
        $earliestOffset = $offsets[0]
        foreach ($offset in $offsets) {
            if ($offset -gt $earliestOffset) {
                $earliestOffset = $offset
            }
        }
        return (New-Object datetimeoffset($localValue, $earliestOffset)).ToUniversalTime()
    }
    return [datetimeoffset]([TimeZoneInfo]::ConvertTimeToUtc($localValue, $TimeZone))
}

function Get-LocalDayPeriod {
    param([datetimeoffset]$Now)

    $timeZone = [TimeZoneInfo]::Local
    $localNow = [TimeZoneInfo]::ConvertTime($Now, $timeZone)
    $localStart = [datetime]::SpecifyKind($localNow.Date, [DateTimeKind]::Unspecified)
    $localEnd = $localStart.AddDays(1)
    return [pscustomobject]@{
        Start = Convert-LocalBoundaryToUtc -Value $localStart -TimeZone $timeZone
        End = Convert-LocalBoundaryToUtc -Value $localEnd -TimeZone $timeZone
    }
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

function Get-ResetTime {
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
    if ($number -lt 0 -or [decimal]::Truncate($number) -ne $number -or $number -gt 253402300799) {
        return $null
    }
    try {
        return [datetimeoffset]::FromUnixTimeSeconds([long]$number).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function New-QuotaWindow {
    param(
        [int]$WindowMinutes,
        [double]$UsedPercent,
        [datetimeoffset]$ResetsAt
    )

    return [ordered]@{
        windowMinutes = $WindowMinutes
        usedPercent = $UsedPercent
        remainingPercent = 100.0 - $UsedPercent
        resetsAt = $ResetsAt.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
}

function Get-SourceFiles {
    param(
        [string]$Root,
        [ValidateSet('Claude', 'OpenAI')]
        [string]$Provider
    )

    $files = New-Object 'System.Collections.Generic.List[string]'
    $hadError = $false

    try {
        $rootInfo = New-Object System.IO.DirectoryInfo($Root)
        if (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            return [pscustomobject]@{ Files = $files; HadError = $true }
        }

        $directories = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
        $directories.Push($rootInfo)
        while ($directories.Count -gt 0) {
            $directory = $directories.Pop()
            try {
                foreach ($child in $directory.GetDirectories()) {
                    try {
                        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                            $hadError = $true
                        }
                        else {
                            $directories.Push($child)
                        }
                    }
                    catch {
                        $hadError = $true
                    }
                }
                foreach ($file in $directory.GetFiles()) {
                    try {
                        $allowed = if ($Provider -eq 'Claude') {
                            $file.Extension -ieq '.jsonl'
                        }
                        else {
                            $file.Name -ilike 'rollout-*.jsonl'
                        }
                        if ($allowed -and ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                            $hadError = $true
                            continue
                        }
                        if ($allowed) {
                            $files.Add($file.FullName)
                        }
                    }
                    catch {
                        $hadError = $true
                    }
                }
            }
            catch {
                $hadError = $true
            }
        }
    }
    catch {
        $hadError = $true
    }

    $files.Sort([StringComparer]::OrdinalIgnoreCase)
    return [pscustomobject]@{ Files = $files; HadError = $hadError }
}

function Read-JsonLines {
    param(
        [string]$Path,
        [scriptblock]$OnRecord
    )

    $reader = $null
    try {
        $reader = [IO.File]::OpenText($Path)
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            try {
                $record = $line | ConvertFrom-Json -ErrorAction Stop
                & $OnRecord $record
            }
            catch {
                # A malformed or unsupported individual record does not poison its source.
            }
        }
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
    }
}

function Get-ClaudeUsage {
    param(
        [string]$Root,
        [datetimeoffset]$Cutoff,
        [datetimeoffset]$Through
    )

    if (-not [IO.Directory]::Exists($Root)) {
        return [ordered]@{ state = 'unavailable' }
    }

    try {
        $sourceSet = Get-SourceFiles -Root $Root -Provider Claude
        if ($sourceSet.HadError) {
            return [ordered]@{ state = 'error' }
        }

        $messages = @{}
        $readFailed = $false
        foreach ($path in $sourceSet.Files) {
            $wasRead = Read-JsonLines -Path $path -OnRecord {
                param($record)

                if ((Get-JsonProperty $record 'type') -cne 'assistant') {
                    return
                }
                $timestamp = Convert-ToUtcDateTimeOffset (Get-JsonProperty $record 'timestamp')
                $sessionId = Get-JsonProperty $record 'sessionId'
                $message = Get-JsonProperty $record 'message'
                $messageId = Get-JsonProperty $message 'id'
                $model = Get-SafeLabel (Get-JsonProperty $message 'model')
                $usage = Get-JsonProperty $message 'usage'
                if ($null -eq $timestamp -or -not ($sessionId -is [string]) -or [string]::IsNullOrWhiteSpace($sessionId) -or
                    -not ($messageId -is [string]) -or [string]::IsNullOrWhiteSpace($messageId) -or $null -eq $model -or $null -eq $usage) {
                    return
                }

                $inputCount = Get-UsageCount $usage 'input_tokens'
                $creationCount = Get-UsageCount $usage 'cache_creation_input_tokens'
                $readCount = Get-UsageCount $usage 'cache_read_input_tokens'
                $outputCount = Get-UsageCount $usage 'output_tokens'
                $completeness = @($inputCount, $creationCount, $readCount, $outputCount).Where({ $_.Present }).Count
                if ($completeness -eq 0) {
                    return
                }

                [long]$candidateTotal = $inputCount.Value + $creationCount.Value + $readCount.Value + $outputCount.Value
                $key = $sessionId + [char]0 + $messageId
                $usageKey = '{0:D20}|{1:D20}|{2:D20}|{3:D20}|{4}' -f $inputCount.Value, $creationCount.Value, $readCount.Value, $outputCount.Value, $model
                $candidate = [pscustomobject]@{
                    Timestamp = $timestamp
                    UsageTimestamp = $timestamp
                    Completeness = $completeness
                    UsageKey = $usageKey
                    Input = $inputCount.Value
                    Creation = $creationCount.Value
                    Read = $readCount.Value
                    Output = $outputCount.Value
                    Total = $candidateTotal
                    Model = $model
                }

                if (-not $messages.ContainsKey($key)) {
                    $messages[$key] = $candidate
                    return
                }

                $current = $messages[$key]
                if ($timestamp -lt $current.Timestamp) {
                    $current.Timestamp = $timestamp
                }
                $replaceUsage = $completeness -gt $current.Completeness
                if ($completeness -eq $current.Completeness) {
                    $replaceUsage = $candidateTotal -gt $current.Total -or
                        ($candidateTotal -eq $current.Total -and
                         ($timestamp -gt $current.UsageTimestamp -or
                          ($timestamp -eq $current.UsageTimestamp -and [string]::CompareOrdinal($usageKey, $current.UsageKey) -gt 0)))
                }
                if ($replaceUsage) {
                    $current.UsageTimestamp = $timestamp
                    $current.Completeness = $completeness
                    $current.UsageKey = $usageKey
                    $current.Input = $inputCount.Value
                    $current.Creation = $creationCount.Value
                    $current.Read = $readCount.Value
                    $current.Output = $outputCount.Value
                    $current.Total = $candidateTotal
                    $current.Model = $model
                }
            }
            if (-not $wasRead) {
                $readFailed = $true
            }
        }

        if ($readFailed) {
            return [ordered]@{ state = 'error' }
        }

        [long]$inputTotal = 0
        [long]$creationTotal = 0
        [long]$readTotal = 0
        [long]$outputTotal = 0
        $recordCount = 0
        $latestTimestamp = $null
        $latestModel = $null
        foreach ($entry in $messages.Values) {
            if ($entry.Timestamp -lt $Cutoff -or $entry.Timestamp -gt $Through) {
                continue
            }
            $inputTotal += $entry.Input
            $creationTotal += $entry.Creation
            $readTotal += $entry.Read
            $outputTotal += $entry.Output
            $recordCount++
            if ($null -eq $latestTimestamp -or $entry.Timestamp -gt $latestTimestamp -or
                ($entry.Timestamp -eq $latestTimestamp -and [string]::CompareOrdinal($entry.Model, $latestModel) -lt 0)) {
                $latestTimestamp = $entry.Timestamp
                $latestModel = $entry.Model
            }
        }

        if ($recordCount -eq 0) {
            return [ordered]@{ state = 'empty' }
        }

        [long]$total = $inputTotal + $creationTotal + $readTotal + $outputTotal
        return [ordered]@{
            state = 'ok'
            totalTokens = $total
            inputTokens = $inputTotal
            cacheCreationTokens = $creationTotal
            cacheReadTokens = $readTotal
            outputTokens = $outputTotal
            model = $latestModel
            sourceUpdatedAt = $latestTimestamp.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        }
    }
    catch {
        return [ordered]@{ state = 'error' }
    }
}

function Get-OpenAiUsage {
    param(
        [string]$Root,
        [datetimeoffset]$Cutoff,
        [datetimeoffset]$Through
    )

    if (-not [IO.Directory]::Exists($Root)) {
        return [ordered]@{ state = 'unavailable' }
    }

    try {
        $sourceSet = Get-SourceFiles -Root $Root -Provider OpenAI
        if ($sourceSet.HadError) {
            return [ordered]@{ state = 'error' }
        }

        $responses = @{}
        $threadSettings = @{}
        $turnContexts = @{}
        $readFailed = $false

        foreach ($path in $sourceSet.Files) {
            $wasRead = Read-JsonLines -Path $path -OnRecord {
                param($record)

                $recordType = Get-JsonProperty $record 'type'
                $timestamp = Convert-ToUtcDateTimeOffset (Get-JsonProperty $record 'timestamp')
                if ($null -eq $timestamp) {
                    return
                }
                $payload = Get-JsonProperty $record 'payload'

                if ($recordType -ceq 'event_msg' -and (Get-JsonProperty $payload 'type') -ceq 'thread_settings_applied') {
                    $threadId = Get-JsonProperty $payload 'thread_id'
                    $settings = Get-JsonProperty $payload 'thread_settings'
                    if ($threadId -is [string] -and -not [string]::IsNullOrWhiteSpace($threadId) -and $null -ne $settings) {
                        $candidateModel = Get-SafeLabel (Get-JsonProperty $settings 'model')
                        $candidateTier = Get-SafeLabel (Get-JsonProperty $settings 'service_tier') 40
                        $providerValue = Get-JsonProperty $settings 'model_provider_id'
                        $providerKnown = $providerValue -is [string] -and -not [string]::IsNullOrWhiteSpace($providerValue)
                        if ($null -ne $candidateModel -or $null -ne $candidateTier -or $providerKnown) {
                            $threadSettings[$threadId] = [pscustomobject]@{
                                Model = $candidateModel
                                ServiceTier = $candidateTier
                                ProviderKnown = $providerKnown
                                IsOpenAIProvider = $providerKnown -and [string]::Equals($providerValue, 'openai', [StringComparison]::OrdinalIgnoreCase)
                            }
                        }
                    }
                    return
                }

                if ($recordType -ceq 'turn_context') {
                    $turnId = Get-JsonProperty $payload 'turn_id'
                    $candidateModel = Get-SafeLabel (Get-JsonProperty $payload 'model')
                    if ($turnId -is [string] -and -not [string]::IsNullOrWhiteSpace($turnId) -and $null -ne $candidateModel) {
                        $turnContexts[$turnId] = $candidateModel
                    }
                    return
                }

                if ($recordType -cne 'token_usage_record' -or $null -eq $payload) {
                    return
                }
                $usage = Get-JsonProperty $payload 'usage'
                if ($null -eq $usage) {
                    return
                }

                $inputCount = Get-UsageCount $usage 'input_tokens'
                $cachedCount = Get-UsageCount $usage 'cached_input_tokens'
                $cacheWriteCount = Get-UsageCount $usage 'cache_write_input_tokens'
                $outputCount = Get-UsageCount $usage 'output_tokens'
                $reasoningCount = Get-UsageCount $usage 'reasoning_output_tokens'
                $totalCount = Get-UsageCount $usage 'total_tokens'
                $completeness = @($inputCount, $cachedCount, $cacheWriteCount, $outputCount, $reasoningCount, $totalCount).Where({ $_.Present }).Count
                if ($completeness -eq 0) {
                    return
                }

                [long]$calculatedTotal = 0
                if ($totalCount.Present) {
                    $calculatedTotal = $totalCount.Value
                }
                elseif ($inputCount.Present -and $outputCount.Present) {
                    $calculatedTotal = $inputCount.Value + $outputCount.Value
                }
                else {
                    return
                }

                $responseId = Get-JsonProperty $payload 'response_id'
                if ($responseId -is [string] -and -not [string]::IsNullOrWhiteSpace($responseId)) {
                    $key = 'response:' + $responseId
                }
                else {
                    $sessionId = Get-JsonProperty $payload 'session_id'
                    $turnId = Get-JsonProperty $payload 'turn_id'
                    if (-not ($sessionId -is [string]) -or [string]::IsNullOrWhiteSpace($sessionId) -or
                        -not ($turnId -is [string]) -or [string]::IsNullOrWhiteSpace($turnId)) {
                        return
                    }
                    $ordinalCount = Get-UsageCount $payload 'ordinal'
                    if (-not $ordinalCount.Present) {
                        $ordinalCount = Get-UsageCount $record 'ordinal'
                    }
                    if ($ordinalCount.Present) {
                        $key = 'ordinal:{0}|{1}|{2}' -f $sessionId, $turnId, $ordinalCount.Value
                    }
                    else {
                        $key = 'fallback:{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}' -f
                            $sessionId, $turnId, $timestamp.ToString('o'), $inputCount.Value, $cachedCount.Value,
                            $cacheWriteCount.Value, $outputCount.Value, $reasoningCount.Value, $calculatedTotal
                    }
                }

                $recordThreadId = Get-JsonProperty $payload 'thread_id'
                $recordTurnId = Get-JsonProperty $payload 'turn_id'
                $attributedModel = $null
                $attributedTier = $null
                if ($recordThreadId -is [string] -and $threadSettings.ContainsKey($recordThreadId)) {
                    $recordSettings = $threadSettings[$recordThreadId]
                    if ($recordSettings.ProviderKnown -and -not $recordSettings.IsOpenAIProvider) {
                        return
                    }
                    $attributedModel = $recordSettings.Model
                    $attributedTier = $recordSettings.ServiceTier
                }
                if ($recordTurnId -is [string] -and $turnContexts.ContainsKey($recordTurnId)) {
                    $attributedModel = $turnContexts[$recordTurnId]
                }

                $usageKey = '{0:D20}|{1:D20}|{2:D20}|{3:D20}|{4:D20}' -f
                    $inputCount.Value, $cachedCount.Value, $outputCount.Value, $reasoningCount.Value, $calculatedTotal
                $candidate = [pscustomobject]@{
                    Timestamp = $timestamp
                    UsageTimestamp = $timestamp
                    Completeness = $completeness
                    UsageKey = $usageKey
                    Input = $inputCount.Value
                    Cached = $cachedCount.Value
                    Output = $outputCount.Value
                    Reasoning = $reasoningCount.Value
                    Total = $calculatedTotal
                    Model = $attributedModel
                    ServiceTier = $attributedTier
                }

                if (-not $responses.ContainsKey($key)) {
                    $responses[$key] = $candidate
                    return
                }
                $current = $responses[$key]
                $earliestTimestamp = if ($timestamp -lt $current.Timestamp) { $timestamp } else { $current.Timestamp }
                $replace = $completeness -gt $current.Completeness
                if ($completeness -eq $current.Completeness) {
                    $replace = $calculatedTotal -gt $current.Total -or
                        ($calculatedTotal -eq $current.Total -and
                         ($timestamp -gt $current.UsageTimestamp -or
                          ($timestamp -eq $current.UsageTimestamp -and [string]::CompareOrdinal($usageKey, $current.UsageKey) -gt 0)))
                }
                if ($replace) {
                    $candidate.Timestamp = $earliestTimestamp
                    $responses[$key] = $candidate
                }
                else {
                    $current.Timestamp = $earliestTimestamp
                }
            }
            if (-not $wasRead) {
                $readFailed = $true
            }
        }

        if ($readFailed) {
            return [ordered]@{ state = 'error' }
        }

        if ($responses.Count -eq 0) {
            return [ordered]@{ state = 'empty' }
        }

        [long]$inputTotal = 0
        [long]$cachedTotal = 0
        [long]$outputTotal = 0
        [long]$reasoningTotal = 0
        [long]$total = 0
        $latestTimestamp = $null
        $latestModel = $null
        $latestModelTimestamp = $null
        $latestTier = $null
        $latestTierTimestamp = $null
        $recordCount = 0
        foreach ($entry in $responses.Values) {
            if ($entry.Timestamp -lt $Cutoff -or $entry.Timestamp -gt $Through) {
                continue
            }
            $recordCount++
            $inputTotal += $entry.Input
            $cachedTotal += $entry.Cached
            $outputTotal += $entry.Output
            $reasoningTotal += $entry.Reasoning
            $total += $entry.Total
            if ($null -eq $latestTimestamp -or $entry.Timestamp -gt $latestTimestamp) {
                $latestTimestamp = $entry.Timestamp
            }
            if ($null -ne $entry.Model -and
                ($null -eq $latestModelTimestamp -or $entry.Timestamp -gt $latestModelTimestamp -or
                 ($entry.Timestamp -eq $latestModelTimestamp -and [string]::CompareOrdinal($entry.Model, $latestModel) -lt 0))) {
                $latestModel = $entry.Model
                $latestModelTimestamp = $entry.Timestamp
            }
            if ($null -ne $entry.ServiceTier -and
                ($null -eq $latestTierTimestamp -or $entry.Timestamp -gt $latestTierTimestamp -or
                 ($entry.Timestamp -eq $latestTierTimestamp -and [string]::CompareOrdinal($entry.ServiceTier, $latestTier) -lt 0))) {
                $latestTier = $entry.ServiceTier
                $latestTierTimestamp = $entry.Timestamp
            }
        }

        if ($recordCount -eq 0) {
            return [ordered]@{ state = 'empty' }
        }

        $result = [ordered]@{
            state = 'ok'
            totalTokens = $total
            inputTokens = $inputTotal
            cachedInputTokens = $cachedTotal
            outputTokens = $outputTotal
            reasoningOutputTokens = $reasoningTotal
        }
        if ($null -ne $latestModel) {
            $result['model'] = $latestModel
        }
        if ($null -ne $latestTier) {
            $result['serviceTier'] = $latestTier
        }
        $result['sourceUpdatedAt'] = $latestTimestamp.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        return $result
    }
    catch {
        return [ordered]@{ state = 'error' }
    }
}

function New-EmptyQuota {
    param(
        [ValidateSet('unavailable', 'error')]
        [string]$State
    )

    return [ordered]@{
        state = $State
        windows = @()
    }
}

function Get-ClaudeQuota {
    param(
        [string]$HomeRoot,
        [datetimeoffset]$Now
    )

    $emptyResult = [pscustomobject]@{
        Quota = New-EmptyQuota -State unavailable
        Model = $null
    }
    try {
        $path = [IO.Path]::Combine($HomeRoot, '.config', 'herdr-app', 'data', 't3-usage', 'claude-quota.json')
        if (-not [IO.File]::Exists($path)) {
            return $emptyResult
        }

        $snapshot = [IO.File]::ReadAllText($path) | ConvertFrom-Json -ErrorAction Stop
        if ((Get-JsonProperty $snapshot 'schema') -ne 1) {
            throw 'Unsupported Claude quota snapshot.'
        }
        $observedAt = Convert-ToUtcDateTimeOffset (Get-JsonProperty $snapshot 'observedAt')
        if ($null -eq $observedAt -or $observedAt -gt $Now) {
            throw 'Invalid Claude quota observation time.'
        }

        $model = Get-SafeLabel (Get-JsonProperty $snapshot 'modelId')
        $rateLimits = Get-JsonProperty $snapshot 'rateLimits'
        $windows = New-Object 'System.Collections.Generic.List[object]'
        foreach ($definition in @(
            [pscustomobject]@{ Name = 'fiveHour'; Minutes = 300 },
            [pscustomobject]@{ Name = 'sevenDay'; Minutes = 10080 }
        )) {
            $candidate = Get-JsonProperty $rateLimits $definition.Name
            if ($null -eq $candidate) {
                continue
            }
            $used = Get-FinitePercent (Get-JsonProperty $candidate 'usedPercent')
            $reset = Get-ResetTime (Get-JsonProperty $candidate 'resetsAt')
            if ($null -eq $used -or $null -eq $reset) {
                throw 'Invalid Claude quota window.'
            }
            if ($reset -le $Now) {
                continue
            }
            $windows.Add((New-QuotaWindow -WindowMinutes $definition.Minutes -UsedPercent $used -ResetsAt $reset))
        }

        if ($windows.Count -eq 0) {
            return [pscustomobject]@{
                Quota = New-EmptyQuota -State unavailable
                Model = $model
            }
        }

        $ageMinutes = ($Now - $observedAt).TotalMinutes
        $quota = [ordered]@{
            state = if ($ageMinutes -le 60) { 'ok' } else { 'stale' }
            observedAt = $observedAt.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
            windows = @($windows.ToArray())
        }
        return [pscustomobject]@{ Quota = $quota; Model = $model }
    }
    catch {
        return [pscustomobject]@{
            Quota = New-EmptyQuota -State error
            Model = $null
        }
    }
}

function Stop-CodexProcess {
    param([Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return
    }
    try {
        if (-not $Process.HasExited) {
            $taskKill = [IO.Path]::Combine($env:SystemRoot, 'System32', 'taskkill.exe')
            if ([IO.File]::Exists($taskKill)) {
                $killerInfo = New-Object Diagnostics.ProcessStartInfo
                $killerInfo.FileName = $taskKill
                $killerInfo.Arguments = '/PID {0} /T /F' -f $Process.Id
                $killerInfo.UseShellExecute = $false
                $killerInfo.CreateNoWindow = $true
                $killerInfo.RedirectStandardOutput = $true
                $killerInfo.RedirectStandardError = $true
                $killer = New-Object Diagnostics.Process
                $killer.StartInfo = $killerInfo
                try {
                    [void]$killer.Start()
                    [void]$killer.StandardOutput.ReadToEndAsync()
                    [void]$killer.StandardError.ReadToEndAsync()
                    [void]$killer.WaitForExit(1000)
                }
                finally {
                    $killer.Dispose()
                }
            }
            if (-not $Process.HasExited) {
                $Process.Kill()
            }
        }
    }
    catch {
        try {
            if (-not $Process.HasExited) {
                $Process.Kill()
            }
        }
        catch {
        }
    }
}

function Read-CodexResponse {
    param(
        [Diagnostics.Process]$Process,
        [int]$Id,
        [datetime]$DeadlineUtc
    )

    while ($true) {
        $remaining = [int][Math]::Ceiling(($DeadlineUtc - [datetime]::UtcNow).TotalMilliseconds)
        if ($remaining -le 0) {
            throw 'Codex app-server timed out.'
        }
        $read = $Process.StandardOutput.ReadLineAsync()
        if (-not $read.Wait($remaining)) {
            throw 'Codex app-server timed out.'
        }
        $line = $read.Result
        if ($null -eq $line) {
            throw 'Codex app-server closed.'
        }
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $message = $line | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw 'Codex app-server protocol failed.'
        }
        $messageId = Get-JsonProperty $message 'id'
        if ($null -ne $messageId -and [string]::Equals(
            $messageId.ToString(),
            $Id.ToString([Globalization.CultureInfo]::InvariantCulture),
            [StringComparison]::Ordinal
        )) {
            return $message
        }
    }
}

function Write-CodexMessage {
    param(
        [Diagnostics.Process]$Process,
        [object]$Message
    )

    $line = $Message | ConvertTo-Json -Depth 8 -Compress
    $Process.StandardInput.WriteLine($line)
    $Process.StandardInput.Flush()
}

function Invoke-CodexQuotaRead {
    param(
        [string]$Executable,
        [string]$HomeRoot,
        [datetimeoffset]$Now,
        [datetime]$DeadlineUtc
    )

    $process = $null
    try {
        if ([datetime]::UtcNow -ge $DeadlineUtc) {
            throw 'Codex app-server timed out.'
        }

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Executable
        $startInfo.Arguments = 'app-server --stdio'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables['CODEX_HOME'] = [IO.Path]::Combine($HomeRoot, '.codex')

        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            throw 'Codex app-server failed to start.'
        }
        $stderrDrain = $process.StandardError.ReadToEndAsync()

        Write-CodexMessage -Process $process -Message ([ordered]@{
            id = 1
            method = 'initialize'
            params = [ordered]@{
                clientInfo = [ordered]@{ name = 'herdr'; title = 'Herdr'; version = '1.0' }
            }
        })
        $initialized = Read-CodexResponse -Process $process -Id 1 -DeadlineUtc $DeadlineUtc
        if ($null -ne (Get-JsonProperty $initialized 'error')) {
            throw 'Codex initialization failed.'
        }

        Write-CodexMessage -Process $process -Message ([ordered]@{
            method = 'initialized'
            params = [ordered]@{}
        })
        Write-CodexMessage -Process $process -Message ([ordered]@{
            id = 2
            method = 'account/rateLimits/read'
            params = [ordered]@{ excludeResetCreditDetails = $true }
        })
        $reply = Read-CodexResponse -Process $process -Id 2 -DeadlineUtc $DeadlineUtc
        if ($null -ne (Get-JsonProperty $reply 'error')) {
            throw 'Codex quota read failed.'
        }
        $result = Get-JsonProperty $reply 'result'
        if ($null -eq $result) {
            throw 'Codex quota response was empty.'
        }

        $snapshot = $null
        $byLimitId = Get-JsonProperty $result 'rateLimitsByLimitId'
        if ($null -ne $byLimitId) {
            $codexLimit = $byLimitId.PSObject.Properties['codex']
            if ($null -ne $codexLimit) {
                $snapshot = $codexLimit.Value
            }
        }
        if ($null -eq $snapshot) {
            $snapshot = Get-JsonProperty $result 'rateLimits'
        }
        if ($null -eq $snapshot) {
            return [pscustomobject]@{
                Quota = New-EmptyQuota -State unavailable
                Model = $null
            }
        }

        $windowByDuration = @{}
        foreach ($slot in @('primary', 'secondary')) {
            $candidate = Get-JsonProperty $snapshot $slot
            if ($null -eq $candidate) {
                continue
            }
            $durationCount = Get-UsageCount $candidate 'windowDurationMins'
            if (-not $durationCount.Present -or @(300, 10080) -notcontains [int]$durationCount.Value) {
                continue
            }
            $used = Get-FinitePercent (Get-JsonProperty $candidate 'usedPercent')
            $reset = Get-ResetTime (Get-JsonProperty $candidate 'resetsAt')
            if ($null -eq $used -or $null -eq $reset -or $reset -le $Now) {
                continue
            }
            $duration = [int]$durationCount.Value
            if (-not $windowByDuration.ContainsKey($duration)) {
                $windowByDuration[$duration] = New-QuotaWindow -WindowMinutes $duration -UsedPercent $used -ResetsAt $reset
            }
        }

        $windows = @(
            $windowByDuration.GetEnumerator() |
                Sort-Object { [int]$_.Key } |
                ForEach-Object { $_.Value }
        )
        if ($windows.Count -eq 0) {
            return [pscustomobject]@{
                Quota = New-EmptyQuota -State unavailable
                Model = Get-SafeLabel (Get-JsonProperty $snapshot 'normalModelSlug')
            }
        }

        $quota = [ordered]@{
            state = 'ok'
            observedAt = $Now.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
            windows = $windows
        }
        $plan = Get-SafeLabel (Get-JsonProperty $snapshot 'planType') 40
        if ($null -ne $plan) {
            $quota['plan'] = $plan
        }
        $ordinaryUsageAllowed = Get-JsonProperty $result 'ordinaryUsageAllowed'
        if ($ordinaryUsageAllowed -is [bool]) {
            $quota['ordinaryUsageAllowed'] = $ordinaryUsageAllowed
        }
        return [pscustomobject]@{
            Quota = $quota
            Model = Get-SafeLabel (Get-JsonProperty $snapshot 'normalModelSlug')
        }
    }
    finally {
        if ($null -ne $process) {
            try {
                $process.StandardInput.Close()
            }
            catch {
            }
            try {
                if (-not $process.HasExited) {
                    [void]$process.WaitForExit(250)
                }
            }
            catch {
            }
            Stop-CodexProcess -Process $process
            try {
                [void]$process.WaitForExit(1000)
            }
            catch {
            }
            $process.Dispose()
        }
    }
}

# Fallback ported from Alevsk/herdr-agent-usage (MIT): when the live read fails, use the
# latest `rate_limits` snapshot Codex already wrote to its rollouts in the last 7 days.
# It is a past observation, so it is always reported as stale with its timestamp.
function Get-CodexRolloutQuota {
    param(
        [string]$HomeRoot,
        [datetimeoffset]$Now
    )

    try {
        $root = [IO.Path]::Combine($HomeRoot, '.codex', 'sessions')
        if (-not [IO.Directory]::Exists($root)) {
            return $null
        }
        $cutoff = $Now.AddDays(-7)
        $sourceSet = Get-SourceFiles -Root $root -Provider OpenAI
        $state = @{ Latest = $null; LatestAt = $null }
        foreach ($path in $sourceSet.Files) {
            if ([IO.File]::GetLastWriteTimeUtc($path) -lt $cutoff.UtcDateTime) {
                continue
            }
            $null = Read-JsonLines -Path $path -OnRecord {
                param($record)

                if ((Get-JsonProperty $record 'type') -cne 'event_msg') {
                    return
                }
                $payload = Get-JsonProperty $record 'payload'
                if ((Get-JsonProperty $payload 'type') -cne 'token_count') {
                    return
                }
                $limits = Get-JsonProperty $payload 'rate_limits'
                $timestamp = Convert-ToUtcDateTimeOffset (Get-JsonProperty $record 'timestamp')
                if ($null -eq $limits -or $null -eq $timestamp -or $timestamp -lt $cutoff -or $timestamp -gt $Now) {
                    return
                }
                if ($null -eq $state.LatestAt -or $timestamp -gt $state.LatestAt) {
                    $state.Latest = $limits
                    $state.LatestAt = $timestamp
                }
            }
        }
        if ($null -eq $state.Latest) {
            return $null
        }

        $windows = New-Object 'System.Collections.Generic.List[object]'
        foreach ($name in @('primary', 'secondary')) {
            $candidate = Get-JsonProperty $state.Latest $name
            if ($null -eq $candidate) {
                continue
            }
            $used = Get-FinitePercent (Get-JsonProperty $candidate 'used_percent')
            $minutes = Get-UsageCount $candidate 'window_minutes'
            $reset = Get-ResetTime (Get-JsonProperty $candidate 'resets_at')
            # A window that already reset says nothing about the current one.
            if ($null -eq $used -or -not $minutes.Present -or $minutes.Value -le 0 -or $null -eq $reset -or $reset -le $Now) {
                continue
            }
            $windows.Add((New-QuotaWindow -WindowMinutes ([int]$minutes.Value) -UsedPercent $used -ResetsAt $reset))
        }
        if ($windows.Count -eq 0) {
            return $null
        }
        $sorted = @($windows.ToArray() | Sort-Object { $_.windowMinutes })
        $quota = [ordered]@{
            state = 'stale'
            observedAt = $state.LatestAt.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
            windows = $sorted
        }
        $plan = Get-SafeLabel (Get-JsonProperty $state.Latest 'plan_type') 40
        if ($null -ne $plan) {
            $quota['plan'] = $plan
        }
        return [pscustomobject]@{ Quota = $quota; Model = $null }
    }
    catch {
        return $null
    }
}

function Get-OpenAiQuota {
    param(
        [string]$HomeRoot,
        [datetimeoffset]$Now,
        [switch]$Skip
    )

    $live = Get-OpenAiLiveQuota -HomeRoot $HomeRoot -Now $Now -Skip:$Skip
    if ($live.Quota.state -eq 'ok') {
        return $live
    }
    $fallback = Get-CodexRolloutQuota -HomeRoot $HomeRoot -Now $Now
    if ($null -ne $fallback) {
        return $fallback
    }
    return $live
}

function Get-OpenAiLiveQuota {
    param(
        [string]$HomeRoot,
        [datetimeoffset]$Now,
        [switch]$Skip
    )

    if ($Skip) {
        return [pscustomobject]@{
            Quota = New-EmptyQuota -State unavailable
            Model = $null
        }
    }

    $candidates = New-Object 'System.Collections.Generic.List[string]'
    $staged = [IO.Path]::Combine($HomeRoot, '.codex', 'plugins', '.plugin-appserver', 'codex.exe')
    if ([IO.File]::Exists($staged)) {
        $candidates.Add($staged)
    }
    try {
        $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($null -ne $package) {
            $packaged = [IO.Path]::Combine($package.InstallLocation, 'app', 'resources', 'codex.exe')
            if ([IO.File]::Exists($packaged) -and -not $candidates.Contains($packaged)) {
                $candidates.Add($packaged)
            }
        }
    }
    catch {
    }

    if ($candidates.Count -eq 0) {
        return [pscustomobject]@{
            Quota = New-EmptyQuota -State unavailable
            Model = $null
        }
    }

    $deadline = [datetime]::UtcNow.AddSeconds(12)
    foreach ($candidate in $candidates) {
        try {
            return Invoke-CodexQuotaRead -Executable $candidate -HomeRoot $HomeRoot -Now $Now -DeadlineUtc $deadline
        }
        catch {
            if ([datetime]::UtcNow -ge $deadline) {
                break
            }
        }
    }
    return [pscustomobject]@{
        Quota = New-EmptyQuota -State error
        Model = $null
    }
}

function Add-QuotaToUsage {
    param(
        [System.Collections.IDictionary]$Usage,
        [object]$QuotaResult
    )

    if (-not $Usage.Contains('model') -and $null -ne $QuotaResult.Model) {
        $Usage['model'] = $QuotaResult.Model
    }
    $Usage['quota'] = $QuotaResult.Quota
    return $Usage
}

try {
    $effectiveNow = Convert-ToEffectiveUtc $NowUtc
    if ([string]::IsNullOrWhiteSpace($HomePath)) {
        throw 'Invalid collector parameters.'
    }

    if ($PSBoundParameters.ContainsKey('PeriodStartUtc')) {
        $periodStart = Convert-ToEffectiveUtc $PeriodStartUtc
        $periodEnd = $periodStart.AddDays(1)
        if ($effectiveNow -lt $periodStart -or $effectiveNow -ge $periodEnd) {
            throw 'The fixed period must contain the fixed current time.'
        }
    }
    else {
        $period = Get-LocalDayPeriod -Now $effectiveNow
        $periodStart = $period.Start
        $periodEnd = $period.End
    }

    $claudeRoot = [IO.Path]::Combine($HomePath, '.claude', 'projects')
    $openAiRoot = [IO.Path]::Combine($HomePath, '.codex', 'sessions')
    $claudeUsage = Get-ClaudeUsage -Root $claudeRoot -Cutoff $periodStart -Through $effectiveNow
    $openAiUsage = Get-OpenAiUsage -Root $openAiRoot -Cutoff $periodStart -Through $effectiveNow
    $claudeQuota = Get-ClaudeQuota -HomeRoot $HomePath -Now $effectiveNow
    $openAiQuota = Get-OpenAiQuota -HomeRoot $HomePath -Now $effectiveNow -Skip:$SkipLiveQuota

    $document = [ordered]@{
        schema = 2
        generatedAt = $effectiveNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        periodStart = $periodStart.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        periodEnd = $periodEnd.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        claude = Add-QuotaToUsage -Usage $claudeUsage -QuotaResult $claudeQuota
        openai = Add-QuotaToUsage -Usage $openAiUsage -QuotaResult $openAiQuota
    }
}
catch {
    $fallbackNow = [datetimeoffset]::UtcNow
    $fallbackStart = New-Object datetimeoffset(
        $fallbackNow.Year,
        $fallbackNow.Month,
        $fallbackNow.Day,
        0,
        0,
        0,
        [timespan]::Zero
    )
    $document = [ordered]@{
        schema = 2
        generatedAt = $fallbackNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        periodStart = $fallbackStart.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        periodEnd = $fallbackStart.AddDays(1).ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        claude = [ordered]@{
            state = 'error'
            quota = New-EmptyQuota -State error
        }
        openai = [ordered]@{
            state = 'error'
            quota = New-EmptyQuota -State error
        }
    }
}

$document | ConvertTo-Json -Depth 8 -Compress
