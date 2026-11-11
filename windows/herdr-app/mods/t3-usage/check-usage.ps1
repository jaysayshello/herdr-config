$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

$collector = Join-Path $PSScriptRoot 'collect-usage.ps1'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('t3-usage-check-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$fixedNow = [datetime]'2026-11-10T12:00:00Z'
# A fixed "local day" so the day boundary is deterministic: records before 2026-11-09T12:30Z are yesterday.
$fixedPeriodStart = [datetime]'2026-11-09T12:30:00Z'
$capture = Join-Path $PSScriptRoot 'capture-claude-quota.ps1'

function Epoch {
    param([string]$Iso)
    return [datetimeoffset]::Parse($Iso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds()
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Message
    )
    if ($Actual -ne $Expected) {
        throw ('{0} (expected {1}, got {2})' -f $Message, $Expected, $Actual)
    }
}

function Assert-Properties {
    param(
        [object]$Object,
        [string[]]$Expected,
        [string]$Message
    )
    $actualNames = @($Object.PSObject.Properties.Name | Sort-Object)
    $expectedNames = @($Expected | Sort-Object)
    Assert-Equal ($actualNames -join '|') ($expectedNames -join '|') $Message
}

function Add-JsonRecord {
    param(
        [string]$Path,
        [object]$Record
    )
    $line = $Record | ConvertTo-Json -Depth 10 -Compress
    [IO.File]::AppendAllText($Path, $line + [Environment]::NewLine, $utf8)
}

function Add-RawLine {
    param(
        [string]$Path,
        [string]$Line
    )
    [IO.File]::AppendAllText($Path, $Line + [Environment]::NewLine, $utf8)
}

function Invoke-Collector {
    param([string]$FakeHome)

    # Live quota is always skipped: the check never starts a broker or touches the network.
    $lines = @(& $collector -HomePath $FakeHome -NowUtc $fixedNow -PeriodStartUtc $fixedPeriodStart -SkipLiveQuota)
    Assert-Equal $lines.Count 1 'collector must emit exactly one stdout object'
    Assert-True (-not $lines[0].Contains("`r") -and -not $lines[0].Contains("`n")) 'collector JSON must be compact'
    try {
        return $lines[0] | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw 'collector output was not valid JSON'
    }
}

function Assert-Envelope {
    param([object]$Document)

    Assert-Properties $Document @('schema', 'generatedAt', 'periodStart', 'periodEnd', 'claude', 'openai') 'unexpected top-level schema'
    Assert-Equal $Document.schema 2 'schema version'
    Assert-True ($Document.periodStart.StartsWith('2026-11-09T12:30:00')) 'fixed period start'
    Assert-True ($Document.periodEnd.StartsWith('2026-11-10T12:30:00')) 'period ends one day later'
    foreach ($provider in @($Document.claude, $Document.openai)) {
        Assert-True (@('ok', 'stale', 'unavailable', 'error') -contains $provider.quota.state) 'invalid quota state'
        foreach ($window in @($provider.quota.windows)) {
            Assert-True ($window.usedPercent -ge 0 -and $window.usedPercent -le 100) 'quota percent out of range'
            Assert-Equal ($window.usedPercent + $window.remainingPercent) 100 'used + remaining must be 100'
        }
    }
    [datetimeoffset]$parsed = [datetimeoffset]::MinValue
    Assert-True ([datetimeoffset]::TryParse($Document.generatedAt, [ref]$parsed)) 'generatedAt must be ISO time'
    Assert-True (@('ok', 'empty', 'unavailable', 'error') -contains $Document.claude.state) 'invalid Claude state'
    Assert-True (@('ok', 'empty', 'unavailable', 'error') -contains $Document.openai.state) 'invalid OpenAI state'
}

try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)

    # Full aggregation fixture.
    $fullHome = Join-Path $fixtureRoot 'full-home'
    $claudeDirectory = Join-Path $fullHome '.claude\projects\project-a'
    $openAiDirectory = Join-Path $fullHome '.codex\sessions\2026\11\10'
    [void][IO.Directory]::CreateDirectory($claudeDirectory)
    [void][IO.Directory]::CreateDirectory($openAiDirectory)
    $claudeFile = Join-Path $claudeDirectory 'session.jsonl'
    $openAiFile = Join-Path $openAiDirectory 'rollout-fixture.jsonl'

    Add-RawLine $claudeFile '{malformed fixture line'
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-09T10:00:00Z'; sessionId = 'session-secret-a'
        message = [ordered]@{ id = 'message-secret-a'; model = 'claude-sonnet-4-5'; usage = [ordered]@{ input_tokens = 100; output_tokens = 10 }; content = 'RAW_PROMPT_SENTINEL' }
    })
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-09T11:00:00Z'; sessionId = 'session-secret-a'
        message = [ordered]@{ id = 'message-secret-a'; model = 'claude-sonnet-4-5'; usage = [ordered]@{ input_tokens = 100; cache_creation_input_tokens = 20; cache_read_input_tokens = 30; output_tokens = 10 } }
    })
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-09T12:00:00Z'; sessionId = 'session-secret-b'
        message = [ordered]@{ id = 'message-secret-a'; model = 'claude-haiku-4-5'; usage = [ordered]@{ input_tokens = 7; cache_creation_input_tokens = 0; cache_read_input_tokens = 0; output_tokens = 3 } }
    })
    # Equal-completeness duplicate keeps the largest final usage, but its earliest timestamp.
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-09T13:00:00Z'; sessionId = 'session-corrected'
        message = [ordered]@{ id = 'message-corrected'; model = 'claude-opus-4-5'; usage = [ordered]@{ input_tokens = 2; cache_creation_input_tokens = 0; cache_read_input_tokens = 0; output_tokens = 2 } }
    })
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-10T11:00:00Z'; sessionId = 'session-corrected'
        message = [ordered]@{ id = 'message-corrected'; model = 'claude-opus-4-5'; usage = [ordered]@{ input_tokens = 5; cache_creation_input_tokens = 0; cache_read_input_tokens = 0; output_tokens = 4 } }
    })

    # Global dedupe precedes window filtering: its earliest duplicate is outside the window.
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-02T10:00:00Z'; sessionId = 'session-window'
        message = [ordered]@{ id = 'message-window'; model = 'claude-sonnet-4-5'; usage = [ordered]@{ input_tokens = 1; output_tokens = 1 } }
    })
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-10T10:00:00Z'; sessionId = 'session-window'
        message = [ordered]@{ id = 'message-window'; model = 'claude-sonnet-4-5'; usage = [ordered]@{ input_tokens = 9999; cache_creation_input_tokens = 9999; cache_read_input_tokens = 9999; output_tokens = 9999 } }
    })
    Add-JsonRecord $claudeFile ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-10T11:00:00Z'; sessionId = 'malicious-label'
        message = [ordered]@{ id = 'not-counted'; model = 'C:\private\TOKEN_SENTINEL'; usage = [ordered]@{ input_tokens = 9999; output_tokens = 9999 } }
    })

    Add-RawLine $openAiFile 'not-json OPENAI_RAW_SENTINEL'
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-09T08:00:00Z'; type = 'event_msg'
        payload = [ordered]@{ type = 'thread_settings_applied'; thread_id = 'thread-secret-a'; thread_settings = [ordered]@{ model = 'gpt-5-main'; model_provider_id = 'openai'; service_tier = 'default' } }
    })
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-09T08:01:00Z'; type = 'turn_context'
        payload = [ordered]@{ thread_id = 'thread-secret-a'; turn_id = 'turn-secret-a'; model = 'gpt-5-codex' }
    })
    $responseOneInitial = [ordered]@{
        timestamp = '2026-11-09T08:01:30Z'; ordinal = 1; type = 'token_usage_record'
        payload = [ordered]@{
            thread_id = 'thread-secret-a'; turn_id = 'turn-secret-a'; session_id = 'openai-session-a'; response_id = 'response-secret-a'
            usage = [ordered]@{ input_tokens = 20; cached_input_tokens = 10; cache_write_input_tokens = 0; output_tokens = 10; reasoning_output_tokens = 2; total_tokens = 30 }
        }
    }
    $responseOne = [ordered]@{
        timestamp = '2026-11-09T08:02:00Z'; ordinal = 1; type = 'token_usage_record'
        payload = [ordered]@{
            thread_id = 'thread-secret-a'; turn_id = 'turn-secret-a'; session_id = 'openai-session-a'; response_id = 'response-secret-a'
            usage = [ordered]@{ input_tokens = 100; cached_input_tokens = 80; cache_write_input_tokens = 0; output_tokens = 20; reasoning_output_tokens = 5; total_tokens = 120 }
            turn_token_usage = [ordered]@{ input_tokens = 9000; cached_input_tokens = 8000; output_tokens = 9000; reasoning_output_tokens = 9000; total_tokens = 18000 }
            thread_token_usage = [ordered]@{ input_tokens = 90000; cached_input_tokens = 80000; output_tokens = 90000; reasoning_output_tokens = 90000; total_tokens = 180000 }
        }
    }
    Add-JsonRecord $openAiFile $responseOneInitial
    Add-JsonRecord $openAiFile $responseOne
    Add-JsonRecord $openAiFile $responseOne
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T08:00:00Z'; type = 'event_msg'
        payload = [ordered]@{ type = 'thread_settings_applied'; thread_id = 'thread-secret-b'; thread_settings = [ordered]@{ model = 'gpt-5-mini'; model_provider_id = 'openai'; service_tier = 'flex' } }
    })
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T08:01:00Z'; ordinal = 2; type = 'token_usage_record'
        payload = [ordered]@{
            thread_id = 'thread-secret-b'; turn_id = 'turn-secret-b'; session_id = 'openai-session-b'; response_id = 'response-secret-b'
            usage = [ordered]@{ input_tokens = 50; cached_input_tokens = 10; cache_write_input_tokens = 0; output_tokens = 10; reasoning_output_tokens = 2; total_tokens = 60 }
        }
    })
    $fallbackResponse = [ordered]@{
        timestamp = '2026-11-10T10:00:00Z'; type = 'token_usage_record'
        payload = [ordered]@{
            thread_id = 'thread-secret-b'; turn_id = 'turn-secret-c'; session_id = 'openai-session-b'
            usage = [ordered]@{ input_tokens = 10; cached_input_tokens = 3; cache_write_input_tokens = 0; output_tokens = 5; reasoning_output_tokens = 1; total_tokens = 15 }
        }
    }
    Add-JsonRecord $openAiFile $fallbackResponse
    Add-JsonRecord $openAiFile $fallbackResponse
    # Ordinal identity merges corrected copies while preserving distinct equal-count responses.
    $ordinalInitial = [ordered]@{
        timestamp = '2026-11-10T10:30:00Z'; type = 'token_usage_record'
        payload = [ordered]@{
            ordinal = 10; thread_id = 'thread-secret-b'; turn_id = 'turn-ordinal'; session_id = 'openai-session-b'
            usage = [ordered]@{ input_tokens = 2; cached_input_tokens = 1; cache_write_input_tokens = 0; output_tokens = 1; reasoning_output_tokens = 0; total_tokens = 3 }
        }
    }
    $ordinalCorrected = [ordered]@{
        timestamp = '2026-11-10T10:50:00Z'; type = 'token_usage_record'
        payload = [ordered]@{
            ordinal = 10; thread_id = 'thread-secret-b'; turn_id = 'turn-ordinal'; session_id = 'openai-session-b'
            usage = [ordered]@{ input_tokens = 5; cached_input_tokens = 2; cache_write_input_tokens = 0; output_tokens = 2; reasoning_output_tokens = 1; total_tokens = 7 }
        }
    }
    $ordinalDistinct = [ordered]@{
        timestamp = '2026-11-10T10:20:00Z'; type = 'token_usage_record'
        payload = [ordered]@{
            ordinal = 11; thread_id = 'thread-secret-b'; turn_id = 'turn-ordinal'; session_id = 'openai-session-b'
            usage = [ordered]@{ input_tokens = 5; cached_input_tokens = 2; cache_write_input_tokens = 0; output_tokens = 2; reasoning_output_tokens = 1; total_tokens = 7 }
        }
    }
    Add-JsonRecord $openAiFile $ordinalInitial
    Add-JsonRecord $openAiFile $ordinalCorrected
    Add-JsonRecord $openAiFile $ordinalDistinct
    # Explicitly non-OpenAI settings exclude that thread's token records.
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T11:00:00Z'; type = 'event_msg'
        payload = [ordered]@{ type = 'thread_settings_applied'; thread_id = 'thread-external'; thread_settings = [ordered]@{ model = 'external-model'; model_provider_id = 'azure'; service_tier = 'premium' } }
    })
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T11:01:00Z'; type = 'token_usage_record'
        payload = [ordered]@{ thread_id = 'thread-external'; turn_id = 'turn-external'; session_id = 'external-session'; response_id = 'external-response'; usage = [ordered]@{ input_tokens = 88888; cached_input_tokens = 77777; cache_write_input_tokens = 0; output_tokens = 88888; reasoning_output_tokens = 77777; total_tokens = 177776 } }
    })
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-01T10:00:00Z'; ordinal = 4; type = 'token_usage_record'
        payload = [ordered]@{ thread_id = 'old-thread'; turn_id = 'old-turn'; session_id = 'old-session'; response_id = 'old-response'; usage = [ordered]@{ input_tokens = 9999; cached_input_tokens = 9999; output_tokens = 9999; reasoning_output_tokens = 9999; total_tokens = 19998 } }
    })

    # These valid-looking records are outside both strict source roots and must be ignored.
    Add-JsonRecord (Join-Path $fullHome 'outside.jsonl') ([ordered]@{ type = 'assistant'; timestamp = '2026-11-10T10:00:00Z'; sessionId = 'outside'; message = [ordered]@{ id = 'outside'; model = 'outside'; usage = [ordered]@{ input_tokens = 77777; output_tokens = 77777 } } })
    $archiveDirectory = Join-Path $fullHome '.codex\archived_sessions'
    [void][IO.Directory]::CreateDirectory($archiveDirectory)
    Add-JsonRecord (Join-Path $archiveDirectory 'rollout-outside.jsonl') ([ordered]@{ timestamp = '2026-11-10T10:00:00Z'; type = 'token_usage_record'; payload = [ordered]@{ thread_id = 'outside'; turn_id = 'outside'; session_id = 'outside'; response_id = 'outside'; usage = [ordered]@{ input_tokens = 77777; cached_input_tokens = 0; output_tokens = 77777; reasoning_output_tokens = 0; total_tokens = 155554 } } })

    # Codex rollout quota snapshots (fallback ported from herdr-agent-usage): the latest one wins,
    # windows that already reset are dropped, and the result is stale, never current.
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T09:00:00Z'; type = 'event_msg'
        payload = [ordered]@{ type = 'token_count'; rate_limits = [ordered]@{ plan_type = 'plus'; primary = [ordered]@{ used_percent = 90; window_minutes = 300; resets_at = (Epoch '2026-11-10T13:00:00Z') } } }
    })
    Add-JsonRecord $openAiFile ([ordered]@{
        timestamp = '2026-11-10T11:30:00Z'; type = 'event_msg'
        payload = [ordered]@{ type = 'token_count'; rate_limits = [ordered]@{
            plan_type = 'plus'
            primary = [ordered]@{ used_percent = 42; window_minutes = 300; resets_at = (Epoch '2026-11-10T14:00:00Z') }
            secondary = [ordered]@{ used_percent = 7; window_minutes = 10080; resets_at = (Epoch '2026-11-10T11:45:00Z') }
        } }
    })

    # Claude status-line capture keeps only the quota projection, never the rest of the payload.
    $statusInput = [ordered]@{
        session_id = 'session-secret-status'; transcript_path = 'C:\private\TRANSCRIPT_SENTINEL.jsonl'
        workspace = [ordered]@{ current_dir = 'C:\private\WORKSPACE_SENTINEL' }
        model = [ordered]@{ id = 'claude-opus-4-5'; display_name = 'Opus' }
        rate_limits = [ordered]@{
            five_hour = [ordered]@{ used_percentage = 23.5; resets_at = (Epoch '2026-11-10T15:00:00Z') }
            seven_day = [ordered]@{ used_percentage = 41.2; resets_at = (Epoch '2026-11-14T00:00:00Z') }
        }
    } | ConvertTo-Json -Depth 5 -Compress
    $statusText = @(& $capture -HomePath $fullHome -NowUtc $fixedNow.AddMinutes(-10) -InputJson $statusInput)
    Assert-Equal $statusText.Count 1 'status line prints one line'
    Assert-True ($statusText[0].StartsWith('Opus ') -and $statusText[0].Contains('5h 23.5%') -and $statusText[0].Contains('7d 41.2%')) 'status line shows model and windows'
    $snapshotText = [IO.File]::ReadAllText((Join-Path $fullHome '.config\herdr-app\data\t3-usage\claude-quota.json'))
    foreach ($forbidden in @('TRANSCRIPT_SENTINEL', 'WORKSPACE_SENTINEL', 'session-secret-status')) {
        Assert-True (-not $snapshotText.Contains($forbidden)) ('capture persisted forbidden data: ' + $forbidden)
    }

    $full = Invoke-Collector $fullHome
    Assert-Envelope $full
    # Only today's records count: yesterday's (before the fixed period start) are excluded.
    Assert-Properties $full.claude @('state', 'totalTokens', 'inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens', 'model', 'sourceUpdatedAt', 'quota') 'unexpected Claude success schema'
    Assert-Equal $full.claude.state 'ok' 'Claude state'
    Assert-Equal $full.claude.inputTokens 5 'Claude input aggregation'
    Assert-Equal $full.claude.cacheCreationTokens 0 'Claude cache creation aggregation'
    Assert-Equal $full.claude.cacheReadTokens 0 'Claude cache read aggregation'
    Assert-Equal $full.claude.outputTokens 4 'Claude output aggregation'
    Assert-Equal $full.claude.totalTokens 9 'Claude total aggregation'
    Assert-Equal $full.claude.model 'claude-opus-4-5' 'Claude latest model'
    Assert-True ($full.claude.sourceUpdatedAt.StartsWith('2026-11-09T13:00:00')) 'Claude source-through uses earliest duplicate time'
    Assert-Equal $full.claude.quota.state 'ok' 'fresh Claude snapshot is current'
    Assert-Equal @($full.claude.quota.windows).Count 2 'Claude windows'
    Assert-Equal $full.claude.quota.windows[0].windowMinutes 300 'shortest Claude window first'
    Assert-Equal $full.claude.quota.windows[0].usedPercent 23.5 'Claude 5h used'

    Assert-Properties $full.openai @('state', 'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'model', 'serviceTier', 'sourceUpdatedAt', 'quota') 'unexpected OpenAI success schema'
    Assert-Equal $full.openai.state 'ok' 'OpenAI state'
    Assert-Equal $full.openai.inputTokens 70 'OpenAI input aggregation'
    Assert-Equal $full.openai.cachedInputTokens 17 'OpenAI cached input aggregation'
    Assert-Equal $full.openai.outputTokens 19 'OpenAI output aggregation'
    Assert-Equal $full.openai.reasoningOutputTokens 5 'OpenAI reasoning aggregation'
    Assert-Equal $full.openai.totalTokens 89 'OpenAI total must not add cached input'
    Assert-Equal $full.openai.model 'gpt-5-mini' 'OpenAI settings model attribution'
    Assert-Equal $full.openai.serviceTier 'flex' 'OpenAI service tier attribution'
    Assert-True ($full.openai.sourceUpdatedAt.StartsWith('2026-11-10T10:30:00')) 'OpenAI source-through time'
    Assert-Equal $full.openai.quota.state 'stale' 'rollout quota is a past observation'
    Assert-True ($full.openai.quota.observedAt.StartsWith('2026-11-10T11:30:00')) 'latest rollout snapshot wins'
    Assert-Equal @($full.openai.quota.windows).Count 1 'already-reset window is dropped'
    Assert-Equal $full.openai.quota.windows[0].usedPercent 42 'rollout 5h used'
    Assert-Equal $full.openai.quota.plan 'plus' 'rollout plan'

    $serialized = $full | ConvertTo-Json -Depth 10 -Compress
    foreach ($forbidden in @('RAW_PROMPT_SENTINEL', 'OPENAI_RAW_SENTINEL', 'TOKEN_SENTINEL', 'session-secret', 'message-secret', 'thread-secret', 'turn-secret', 'response-secret', $fixtureRoot)) {
        Assert-True (-not $serialized.Contains($forbidden)) ('collector leaked forbidden data: ' + $forbidden)
    }

    # Existing/readable sources containing no usable records are empty; missing roots are unavailable.
    $emptyHome = Join-Path $fixtureRoot 'empty-home'
    $emptyClaude = Join-Path $emptyHome '.claude\projects'
    [void][IO.Directory]::CreateDirectory($emptyClaude)
    Add-RawLine (Join-Path $emptyClaude 'only-malformed.jsonl') '{broken'
    # A two-hour-old Claude snapshot is reported as stale, not current.
    $staleInput = '{"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":' + (Epoch '2026-11-10T13:00:00Z') + '}}}'
    $null = & $capture -HomePath $emptyHome -NowUtc $fixedNow.AddHours(-2) -InputJson $staleInput
    $empty = Invoke-Collector $emptyHome
    Assert-Envelope $empty
    Assert-Properties $empty.claude @('state', 'quota') 'empty Claude must not carry metrics'
    Assert-Properties $empty.openai @('state', 'quota') 'unavailable OpenAI must not carry metrics'
    Assert-Equal $empty.claude.state 'empty' 'malformed readable Claude source should be empty'
    Assert-Equal $empty.openai.state 'unavailable' 'missing OpenAI source should be unavailable'
    Assert-Equal $empty.claude.quota.state 'stale' 'old Claude snapshot is stale'
    Assert-Equal $empty.openai.quota.state 'unavailable' 'no OpenAI quota source is unavailable'

    # One locked OpenAI source makes the provider error even when another source is readable.
    $isolationHome = Join-Path $fixtureRoot 'isolation-home'
    $isolationClaudeDirectory = Join-Path $isolationHome '.claude\projects\p'
    $isolationOpenAiDirectory = Join-Path $isolationHome '.codex\sessions\2026\11\10'
    [void][IO.Directory]::CreateDirectory($isolationClaudeDirectory)
    [void][IO.Directory]::CreateDirectory($isolationOpenAiDirectory)
    Add-JsonRecord (Join-Path $isolationClaudeDirectory 'valid.jsonl') ([ordered]@{
        type = 'assistant'; timestamp = '2026-11-10T09:00:00Z'; sessionId = 'isolation-session'
        message = [ordered]@{ id = 'isolation-message'; model = 'claude-sonnet-4-5'; usage = [ordered]@{ input_tokens = 1; cache_creation_input_tokens = 0; cache_read_input_tokens = 0; output_tokens = 1 } }
    })
    Add-JsonRecord (Join-Path $isolationOpenAiDirectory 'rollout-readable.jsonl') ([ordered]@{
        timestamp = '2026-11-10T08:00:00Z'; type = 'token_usage_record'
        payload = [ordered]@{ thread_id = 'readable-thread'; turn_id = 'readable-turn'; session_id = 'readable-session'; response_id = 'readable-response'; usage = [ordered]@{ input_tokens = 3; cached_input_tokens = 1; cache_write_input_tokens = 0; output_tokens = 2; reasoning_output_tokens = 1; total_tokens = 5 } }
    })
    $lockedPath = Join-Path $isolationOpenAiDirectory 'rollout-locked.jsonl'
    Add-RawLine $lockedPath '{}'
    $lock = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $isolated = Invoke-Collector $isolationHome
    }
    finally {
        $lock.Dispose()
    }
    Assert-Envelope $isolated
    Assert-Equal $isolated.claude.state 'ok' 'OpenAI read failure must not affect Claude'
    Assert-Properties $isolated.openai @('state', 'quota') 'errored OpenAI must not carry metrics'
    Assert-Equal $isolated.openai.state 'error' 'one unreadable OpenAI source must error despite another readable source'
    Assert-Equal $isolated.claude.quota.state 'unavailable' 'no Claude snapshot is unavailable, not 0%'

    exit 0
}
catch {
    [Console]::Error.WriteLine('t3-usage fixture check failed: ' + $_.Exception.Message)
    exit 1
}
finally {
    if ([IO.Directory]::Exists($fixtureRoot)) {
        [IO.Directory]::Delete($fixtureRoot, $true)
    }
}
