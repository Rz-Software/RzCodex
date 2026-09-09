[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("antigravity", "codebuddy", "commandcode", "devin")]
    [string]$Bridge,

    [Parameter(Mandatory)]
    [string]$ExpectedBuildRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$BridgeHandoffExitCode = 75

function Expand-ManifestPath {
    param([Parameter(Mandatory)][string]$Value)
    return [Environment]::ExpandEnvironmentVariables($Value)
}

function Test-ActiveBuildChanged {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$ExpectedBuildRoot
    )

    $pointerPath = Join-Path $InstallRoot "current.txt"
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        throw "RzCodex current pointer disappeared while supervising $Bridge."
    }
    $currentBinary = [IO.Path]::GetFullPath([IO.File]::ReadAllText($pointerPath).Trim())
    $currentBuildRoot = [IO.Path]::GetFullPath((Split-Path -Parent $currentBinary))
    return $currentBuildRoot -ne $ExpectedBuildRoot
}

function Rotate-BoundedLog {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][long]$IncomingBytes,
        [Parameter(Mandatory)][long]$MaximumBytes,
        [Parameter(Mandatory)][int]$RetainedLogs
    )

    $currentLength = if (Test-Path -LiteralPath $Path -PathType Leaf) {
        (Get-Item -LiteralPath $Path).Length
    } else {
        0
    }
    if ($currentLength + $IncomingBytes -le $MaximumBytes) {
        return
    }

    for ($index = $RetainedLogs; $index -ge 1; $index--) {
        $source = if ($index -eq 1) { $Path } else { "$Path.$($index - 1)" }
        $destination = "$Path.$index"
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force
        }
    }
}

function Write-BoundedLogLine {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Stream,
        [AllowEmptyString()][string]$Line,
        [Parameter(Mandatory)][long]$MaximumBytes,
        [Parameter(Mandatory)][int]$RetainedLogs
    )

    $entry = "{0:o} [{1}] {2}{3}" -f (Get-Date), $Stream, $Line, [Environment]::NewLine
    $incomingBytes = [Text.Encoding]::UTF8.GetByteCount($entry)
    Rotate-BoundedLog -Path $Path -IncomingBytes $incomingBytes -MaximumBytes $MaximumBytes -RetainedLogs $RetainedLogs
    [IO.File]::AppendAllText($Path, $entry, [Text.UTF8Encoding]::new($false))
}

function Invoke-BridgeProcess {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][long]$MaximumLogBytes,
        [Parameter(Mandatory)][int]$RetainedLogs
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.ArgumentList.Add($BridgePath)
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the $Bridge bridge process."
    }

    $stdoutOpen = $true
    $stderrOpen = $true
    $stdoutTask = $process.StandardOutput.ReadLineAsync()
    $stderrTask = $process.StandardError.ReadLineAsync()
    try {
        while (-not $process.HasExited -or $stdoutOpen -or $stderrOpen) {
            $handled = $false
            if ($stdoutOpen -and $stdoutTask.IsCompleted) {
                $line = $stdoutTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $stdoutOpen = $false
                } else {
                    Write-BoundedLogLine -Path $LogPath -Stream "stdout" -Line $line -MaximumBytes $MaximumLogBytes -RetainedLogs $RetainedLogs
                    $stdoutTask = $process.StandardOutput.ReadLineAsync()
                }
                $handled = $true
            }
            if ($stderrOpen -and $stderrTask.IsCompleted) {
                $line = $stderrTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $stderrOpen = $false
                } else {
                    Write-BoundedLogLine -Path $LogPath -Stream "stderr" -Line $line -MaximumBytes $MaximumLogBytes -RetainedLogs $RetainedLogs
                    $stderrTask = $process.StandardError.ReadLineAsync()
                }
                $handled = $true
            }
            if (-not $handled) {
                Start-Sleep -Milliseconds 100
            }
        }
        $process.WaitForExit()
        return $process.ExitCode
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
        $process.Dispose()
    }
}

$actualBuildRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ($actualBuildRoot -ne [IO.Path]::GetFullPath($ExpectedBuildRoot)) {
    throw "The bridge supervisor was not launched from the expected active build."
}
$manifestPath = Join-Path $PSScriptRoot "rzcodex-setup.manifest.json"
$manifestSchemaPath = Join-Path $PSScriptRoot "rzcodex-setup.schema.json"
$manifestJson = Get-Content -LiteralPath $manifestPath -Raw
if (-not ($manifestJson | Test-Json -SchemaFile $manifestSchemaPath)) {
    throw "The versioned bridge manifest failed schema validation."
}
$manifest = $manifestJson | ConvertFrom-Json
$bridgeConfig = $manifest.bridges.$Bridge
if ($null -eq $bridgeConfig) {
    throw "Bridge '$Bridge' is not defined in the deployment manifest."
}
$bridgePath = Join-Path $PSScriptRoot $bridgeConfig.script
if (-not (Test-Path -LiteralPath $bridgePath -PathType Leaf)) {
    throw "Versioned bridge script is missing: $bridgePath"
}
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$stateRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $manifest.stateRoot))
$deploymentStatePath = Join-Path $stateRoot "deployment.json"
if (-not (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf)) {
    throw "RzCodex deployment state is missing: $deploymentStatePath"
}
$deploymentState = Get-Content -LiteralPath $deploymentStatePath -Raw | ConvertFrom-Json
$installRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $manifest.installRoot))
$logRoot = Join-Path $stateRoot "Logs\Bridges"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot "$Bridge.log"
$restartDelay = [int]$manifest.supervisor.initialRestartDelaySeconds

while ($true) {
    if (Test-ActiveBuildChanged -InstallRoot $installRoot -ExpectedBuildRoot $actualBuildRoot) {
        Write-BoundedLogLine -Path $logPath -Stream "supervisor" -Line "active build changed during restart backoff; handing off before launching another bridge" -MaximumBytes $manifest.supervisor.maximumLogBytes -RetainedLogs $manifest.supervisor.retainedLogs
        exit $BridgeHandoffExitCode
    }
    $startedAt = Get-Date
    Write-BoundedLogLine -Path $logPath -Stream "supervisor" -Line "starting versioned bridge $Bridge" -MaximumBytes $manifest.supervisor.maximumLogBytes -RetainedLogs $manifest.supervisor.retainedLogs
    $exitCode = Invoke-BridgeProcess `
        -NodePath $nodeCommand.Source `
        -BridgePath $bridgePath `
        -Arguments @($bridgeConfig.arguments) `
        -WorkingDirectory $deploymentState.repoRoot `
        -LogPath $logPath `
        -MaximumLogBytes $manifest.supervisor.maximumLogBytes `
        -RetainedLogs $manifest.supervisor.retainedLogs
    $runtimeSeconds = ((Get-Date) - $startedAt).TotalSeconds
    Write-BoundedLogLine -Path $logPath -Stream "supervisor" -Line "bridge exited code=$exitCode runtime_seconds=$([Math]::Round($runtimeSeconds, 1))" -MaximumBytes $manifest.supervisor.maximumLogBytes -RetainedLogs $manifest.supervisor.retainedLogs

    if (Test-ActiveBuildChanged -InstallRoot $installRoot -ExpectedBuildRoot $actualBuildRoot) {
        Write-BoundedLogLine -Path $logPath -Stream "supervisor" -Line "active build changed; handing off after the bridge process exited" -MaximumBytes $manifest.supervisor.maximumLogBytes -RetainedLogs $manifest.supervisor.retainedLogs
        exit $BridgeHandoffExitCode
    }

    $shouldRestart = $bridgeConfig.restartPolicy -eq "always" -or
        ($bridgeConfig.restartPolicy -eq "on-failure" -and $exitCode -ne 0)
    if (-not $shouldRestart) {
        exit $exitCode
    }
    if ($runtimeSeconds -ge $manifest.supervisor.stableRuntimeSeconds) {
        $restartDelay = [int]$manifest.supervisor.initialRestartDelaySeconds
    }
    Start-Sleep -Seconds $restartDelay
    $restartDelay = [Math]::Min(
        [int]$manifest.supervisor.maximumRestartDelaySeconds,
        $restartDelay * 2
    )
}
