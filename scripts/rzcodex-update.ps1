[CmdletBinding()]
param(
    [switch]$ForceBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CodexRustRoot = Join-Path $RepoRoot "codex-rs"
$InstallRoot = Join-Path $env:USERPROFILE ".codex\forked-bin"
$PointerPath = Join-Path $InstallRoot "current.txt"
$StateRoot = Join-Path $env:LOCALAPPDATA "RzCodex"
$LogRoot = Join-Path $StateRoot "Logs"
$StatusPath = Join-Path $StateRoot "last-update.json"
$BranchName = "rz-main"
$MutexName = "Local\RzCodexAutoUpdate"

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter(Mandatory)]
        [string[]]$ArgumentList,

        [Parameter(Mandatory)]
        [string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Write-UpdateStatus {
    param(
        [Parameter(Mandatory)]
        [string]$Result,

        [Parameter(Mandatory)]
        [string]$Message,

        [string]$Commit = ""
    )

    $status = [ordered]@{
        timestamp = (Get-Date).ToString("o")
        result = $Result
        message = $Message
        commit = $Commit
    }
    $status | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding utf8
}

function Test-MergeInProgress {
    Push-Location -LiteralPath $RepoRoot
    try {
        & git rev-parse --verify --quiet MERGE_HEAD *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        Pop-Location
    }
}

function Install-CodexBinary {
    param(
        [Parameter(Mandatory)]
        [string]$Commit
    )

    $sourceBinary = Join-Path $CodexRustRoot "target\release\codex.exe"
    if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
        throw "Built Codex binary was not found: $sourceBinary"
    }

    $versionRoot = Join-Path $InstallRoot $Commit
    $destinationBinary = Join-Path $versionRoot "codex.exe"
    New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null

    $temporaryBinary = "$destinationBinary.$PID.tmp"
    Copy-Item -LiteralPath $sourceBinary -Destination $temporaryBinary -Force
    Move-Item -LiteralPath $temporaryBinary -Destination $destinationBinary -Force

    & $destinationBinary --version
    if ($LASTEXITCODE -ne 0) {
        throw "The newly built Codex binary failed its version smoke test."
    }

    $temporaryPointer = "$PointerPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporaryPointer, $destinationBinary)
    Move-Item -LiteralPath $temporaryPointer -Destination $PointerPath -Force

    $installRootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\") + "\"
    $obsoleteVersions = Get-ChildItem -LiteralPath $InstallRoot -Directory |
        Where-Object { $_.Name -match "^[0-9a-f]{12}$" -and $_.Name -ne $Commit } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 2

    foreach ($obsoleteVersion in $obsoleteVersions) {
        $obsoletePath = [System.IO.Path]::GetFullPath($obsoleteVersion.FullName)
        if (-not $obsoletePath.StartsWith($installRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a Codex build outside the install root: $obsoletePath"
        }
        try {
            Remove-Item -LiteralPath $obsoletePath -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove inactive Codex build '$obsoletePath': $($_.Exception.Message)"
        }
    }
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
$logPath = Join-Path $LogRoot ("update-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$mutex = [System.Threading.Mutex]::new($false, $MutexName)
$lockAcquired = $false
$mergeStarted = $false
$transcriptStarted = $false

try {
    $lockAcquired = $mutex.WaitOne(0)
    if (-not $lockAcquired) {
        Write-UpdateStatus -Result "skipped" -Message "Another RzCodex update is already running."
        exit 0
    }

    Start-Transcript -LiteralPath $logPath | Out-Null
    $transcriptStarted = $true

    foreach ($requiredCommand in @("git", "cargo", "just")) {
        if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
            throw "Required command is unavailable: $requiredCommand"
        }
    }

    $currentBranch = (& git -C $RepoRoot branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $BranchName) {
        throw "RzCodex must be on branch '$BranchName'; current branch is '$currentBranch'."
    }

    $workingTreeChanges = @(& git -C $RepoRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the RzCodex working tree."
    }
    if ($workingTreeChanges.Count -ne 0) {
        throw "RzCodex has working-tree changes; automatic update refused."
    }

    Invoke-NativeCommand -FilePath "git" -ArgumentList @("fetch", "upstream", "main", "--tags", "--prune") -WorkingDirectory $RepoRoot

    & git -C $RepoRoot merge-base --is-ancestor upstream/main HEAD
    $ancestorExitCode = $LASTEXITCODE
    if ($ancestorExitCode -notin @(0, 1)) {
        throw "Could not compare rz-main with upstream/main."
    }
    $updateAvailable = $ancestorExitCode -eq 1
    $buildRequired = $ForceBuild -or $updateAvailable -or -not (Test-Path -LiteralPath $PointerPath -PathType Leaf)

    if (-not $buildRequired) {
        $currentCommit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
        Write-UpdateStatus -Result "current" -Message "RzCodex already contains upstream/main." -Commit $currentCommit
        exit 0
    }

    if ($updateAvailable) {
        $mergeStarted = $true
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("merge", "--no-commit", "--no-ff", "upstream/main") -WorkingDirectory $RepoRoot
    }

    Invoke-NativeCommand -FilePath "just" -ArgumentList @("fmt-check") -WorkingDirectory $CodexRustRoot
    Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-core", "agent::role::tests") -WorkingDirectory $CodexRustRoot
    Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-tui", "chatwidget::tests::exec_flow::exec_history_extends_previous_when_consecutive") -WorkingDirectory $CodexRustRoot
    Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-tui", "history_cell::tests::coalesces_reads_across_multiple_calls") -WorkingDirectory $CodexRustRoot
    Invoke-NativeCommand -FilePath "cargo" -ArgumentList @("build", "--release", "-p", "codex-cli") -WorkingDirectory $CodexRustRoot

    if ($mergeStarted) {
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("commit", "-m", "Merge upstream/main into rz-main") -WorkingDirectory $RepoRoot
        $mergeStarted = $false
    }

    Invoke-NativeCommand -FilePath "git" -ArgumentList @("push", "origin", $BranchName) -WorkingDirectory $RepoRoot
    $installedCommit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve the installed RzCodex commit."
    }
    Install-CodexBinary -Commit $installedCommit
    Write-UpdateStatus -Result "updated" -Message "RzCodex built, pushed, and installed successfully." -Commit $installedCommit
}
catch {
    if ($mergeStarted -or (Test-MergeInProgress)) {
        & git -C $RepoRoot merge --abort
    }
    Write-UpdateStatus -Result "failed" -Message $_.Exception.Message
    throw
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
    if ($lockAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
