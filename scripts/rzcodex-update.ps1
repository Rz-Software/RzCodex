[CmdletBinding()]
param(
    [switch]$ForceBuild,
    [switch]$RunTests,
    [string]$InvocationId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CodexRustRoot = Join-Path $RepoRoot "codex-rs"
$InstallRoot = Join-Path $env:USERPROFILE ".codex\forked-bin"
$PointerPath = Join-Path $InstallRoot "current.txt"
$BuildMetadataFilename = "rzcodex-build.json"
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
        invocationId = $InvocationId
    }
    $status | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding utf8
}

function Resolve-UpstreamRelease {
    try {
        $release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/openai/codex/releases/latest" `
            -Headers @{
                Accept = "application/vnd.github+json"
                "User-Agent" = "RzCodex-Updater"
                "X-GitHub-Api-Version" = "2022-11-28"
            }
    }
    catch {
        throw "Could not resolve the latest published upstream Codex release: $($_.Exception.Message)"
    }
    $tagName = $release.tag_name
    if ($tagName -isnot [string] -or $tagName -notmatch '^rust-v(?<Version>\d+\.\d+\.\d+)$') {
        throw "The latest published upstream Codex release has an unsupported tag: $tagName"
    }
    $parsedVersion = $null
    if (-not [System.Version]::TryParse($Matches.Version, [ref]$parsedVersion)) {
        throw "The latest published upstream Codex release has an invalid version: $($Matches.Version)"
    }
    return [pscustomobject]@{
        Tag = $tagName
        Version = $parsedVersion.ToString(3)
    }
}

function Get-InstalledBuildMetadata {
    if (-not (Test-Path -LiteralPath $PointerPath -PathType Leaf)) {
        return $null
    }

    try {
        $installedBinary = [System.IO.File]::ReadAllText($PointerPath).Trim()
        if (-not (Test-Path -LiteralPath $installedBinary -PathType Leaf)) {
            return $null
        }
        $metadataPath = Join-Path (Split-Path -Parent $installedBinary) $BuildMetadataFilename
        if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
            return $null
        }
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        if ($metadata.commit -isnot [string] -or $metadata.baseVersion -isnot [string]) {
            return $null
        }
        return $metadata
    }
    catch {
        return $null
    }
}

function Test-BinaryInputsChanged {
    param(
        [Parameter(Mandatory)]
        [object]$InstalledMetadata
    )

    $installedCommit = $InstalledMetadata.commit
    & git -C $RepoRoot rev-parse --verify --quiet "${installedCommit}^{commit}" *> $null
    if ($LASTEXITCODE -ne 0) {
        return $true
    }

    & git -C $RepoRoot diff --quiet "$installedCommit..HEAD" -- codex-rs
    if ($LASTEXITCODE -eq 0) {
        return $false
    }
    if ($LASTEXITCODE -eq 1) {
        return $true
    }
    throw "Could not compare current Rust binary inputs with installed commit $installedCommit."
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

function Initialize-WindowsBuildEnvironment {
    $logicalProcessorCount = [System.Environment]::ProcessorCount
    if ($logicalProcessorCount -lt 1) {
        throw "Could not determine the logical processor count."
    }
    $env:CARGO_BUILD_JOBS = $logicalProcessorCount.ToString()

    $rustSysroot = (& rustc --print sysroot).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $rustSysroot) {
        throw "Could not resolve the active Rust sysroot."
    }
    $hostTriple = (& rustc --print host-tuple).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $hostTriple) {
        throw "Could not resolve the active Rust host triple."
    }
    $rustLld = Join-Path $rustSysroot "lib\rustlib\$hostTriple\bin\rust-lld.exe"
    if (-not (Test-Path -LiteralPath $rustLld -PathType Leaf)) {
        throw "Rust's bundled linker was not found: $rustLld"
    }
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $rustLld
}

function Initialize-RustyV8Artifacts {
    $cargoLockPath = Join-Path $CodexRustRoot "Cargo.lock"
    $cargoLock = [System.IO.File]::ReadAllText($cargoLockPath)
    $versionMatches = [regex]::Matches(
        $cargoLock,
        '(?ms)^\[\[package\]\]\r?\nname = "v8"\r?\nversion = "([^"]+)"'
    )
    $versions = @($versionMatches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    if ($versions.Count -ne 1) {
        throw "Expected exactly one v8 crate version in Cargo.lock; found $($versions.Count)."
    }

    $target = "x86_64-pc-windows-msvc"
    $profile = "ptrcomp_sandbox_release"
    $version = $versions[0]
    $releaseTag = "rusty-v8-v$version"
    $baseUrl = "https://github.com/openai/codex/releases/download/$releaseTag"
    $artifactRoot = Join-Path $StateRoot "rusty-v8\$version"
    $archiveName = "rusty_v8_${profile}_${target}.lib.gz"
    $bindingName = "src_binding_${profile}_${target}.rs"
    $checksumsName = "rusty_v8_${profile}_${target}.sha256"
    $checksumsPath = Join-Path $artifactRoot $checksumsName
    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

    $temporaryChecksumsPath = "$checksumsPath.$PID.tmp"
    Invoke-WebRequest -Uri "$baseUrl/$checksumsName" -OutFile $temporaryChecksumsPath
    Move-Item -LiteralPath $temporaryChecksumsPath -Destination $checksumsPath -Force

    $checksumEntries = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($checksumsPath)) {
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            throw "Invalid rusty_v8 checksum entry: $line"
        }
        $checksumEntries[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    }
    if ($checksumEntries.Count -ne 2 -or
        -not $checksumEntries.ContainsKey($archiveName) -or
        -not $checksumEntries.ContainsKey($bindingName)) {
        throw "The rusty_v8 checksum manifest must contain exactly the expected archive and binding."
    }

    foreach ($fileName in @($archiveName, $bindingName)) {
        $artifactPath = Join-Path $artifactRoot $fileName
        $expectedHash = $checksumEntries[$fileName]
        $artifactValid = (Test-Path -LiteralPath $artifactPath -PathType Leaf) -and
            ((Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash)
        if (-not $artifactValid) {
            $temporaryArtifactPath = "$artifactPath.$PID.tmp"
            Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $temporaryArtifactPath
            $downloadedHash = (Get-FileHash -LiteralPath $temporaryArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($downloadedHash -ne $expectedHash) {
                throw "Checksum mismatch for downloaded rusty_v8 artifact: $fileName"
            }
            Move-Item -LiteralPath $temporaryArtifactPath -Destination $artifactPath -Force
        }
    }

    $env:RUSTY_V8_ARCHIVE = Join-Path $artifactRoot $archiveName
    $env:RUSTY_V8_SRC_BINDING_PATH = Join-Path $artifactRoot $bindingName
}

function Install-CodexBinary {
    param(
        [Parameter(Mandatory)]
        [string]$Commit,

        [Parameter(Mandatory)]
        [string]$BaseVersion
    )

    $releaseRoot = Join-Path $CodexRustRoot "target\release"
    $requiredBinaries = @(
        "codex.exe",
        "codex-code-mode-host.exe",
        "codex-command-runner.exe",
        "codex-windows-sandbox-setup.exe"
    )
    foreach ($binaryName in $requiredBinaries) {
        $sourceBinary = Join-Path $releaseRoot $binaryName
        if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
            throw "Built Codex binary was not found: $sourceBinary"
        }
    }

    $versionRoot = Join-Path $InstallRoot $Commit
    $destinationBinary = Join-Path $versionRoot "codex.exe"
    New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null

    foreach ($binaryName in $requiredBinaries) {
        $sourceBinary = Join-Path $releaseRoot $binaryName
        $installedBinary = Join-Path $versionRoot $binaryName
        $temporaryBinary = "$installedBinary.$PID.tmp"
        Copy-Item -LiteralPath $sourceBinary -Destination $temporaryBinary -Force
        Move-Item -LiteralPath $temporaryBinary -Destination $installedBinary -Force
    }

    $reportedVersion = (& $destinationBinary --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne "RzCodex $BaseVersion") {
        throw "The newly built RzCodex binary reported '$reportedVersion'; expected 'RzCodex $BaseVersion'."
    }

    $buildMetadata = [ordered]@{
        product = "RzCodex"
        baseVersion = $BaseVersion
        commit = $Commit
    }
    $metadataPath = Join-Path $versionRoot $BuildMetadataFilename
    $temporaryMetadataPath = "$metadataPath.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryMetadataPath,
        (($buildMetadata | ConvertTo-Json) + [Environment]::NewLine)
    )
    Move-Item -LiteralPath $temporaryMetadataPath -Destination $metadataPath -Force

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

    foreach ($requiredCommand in @("git", "cargo", "just", "rustc")) {
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

    Initialize-WindowsBuildEnvironment

    $upstreamRelease = Resolve-UpstreamRelease
    $releaseTag = $upstreamRelease.Tag
    Invoke-NativeCommand -FilePath "git" -ArgumentList @(
        "fetch",
        "--force",
        "upstream",
        "refs/tags/${releaseTag}:refs/tags/${releaseTag}"
    ) -WorkingDirectory $RepoRoot
    $releaseCommit = (& git -C $RepoRoot rev-list -n 1 $releaseTag).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $releaseCommit) {
        throw "Could not resolve upstream Codex release tag $releaseTag."
    }

    & git -C $RepoRoot merge-base --is-ancestor $releaseCommit HEAD
    $ancestorExitCode = $LASTEXITCODE
    if ($ancestorExitCode -notin @(0, 1)) {
        throw "Could not compare rz-main with upstream release $releaseTag."
    }
    $updateAvailable = $ancestorExitCode -eq 1
    $baseVersion = $upstreamRelease.Version
    $currentCommit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $currentCommit) {
        throw "Could not resolve the current RzCodex commit."
    }
    $installedMetadata = Get-InstalledBuildMetadata
    $binaryInputsChanged = $null -eq $installedMetadata -or
        $installedMetadata.baseVersion -ne $baseVersion -or
        (Test-BinaryInputsChanged -InstalledMetadata $installedMetadata)
    $buildRequired = $ForceBuild -or
        $updateAvailable -or
        $binaryInputsChanged

    if (-not $buildRequired) {
        $message = if ($installedMetadata.commit -eq $currentCommit) {
            "RzCodex $baseVersion already contains upstream release $releaseTag."
        }
        else {
            "RzCodex $baseVersion already contains upstream release $releaseTag; Rust binary inputs are unchanged since installed commit $($installedMetadata.commit)."
        }
        Write-UpdateStatus -Result "current" -Message $message -Commit $currentCommit
        exit 0
    }

    if ($updateAvailable) {
        $mergeStarted = $true
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("merge", "--no-commit", "--no-ff", $releaseTag) -WorkingDirectory $RepoRoot
    }

    $env:RZCODEX_BASE_VERSION = $baseVersion
    $env:RZCODEX_REPO_ROOT = $RepoRoot
    Invoke-NativeCommand -FilePath "just" -ArgumentList @("fmt-check") -WorkingDirectory $CodexRustRoot
    if ($RunTests) {
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-core", "agent::role::tests") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-config", "subagent_routes") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-core", "managed_subagent_route_overrides_role_model_provider_and_reasoning") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-cli", "subagents_cmd::tests::parses_route_selection") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-tui", "route_picker_description_snapshot") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-core", "collaboration_calls_without_encrypted_arguments_use_plaintext_messages") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-models-manager", "managed_preset_uses_lazy_tool_discovery_with_direct_tools") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-tui", "chatwidget::tests::exec_flow::exec_history_extends_previous_when_consecutive") -WorkingDirectory $CodexRustRoot
        Invoke-NativeCommand -FilePath "just" -ArgumentList @("test", "-p", "codex-tui", "history_cell::tests::coalesces_reads_across_multiple_calls") -WorkingDirectory $CodexRustRoot
    }
    Initialize-RustyV8Artifacts
    Invoke-NativeCommand -FilePath "cargo" -ArgumentList @(
        "build",
        "--release",
        "-p", "codex-cli",
        "-p", "codex-code-mode-host",
        "-p", "codex-windows-sandbox",
        "--bin", "codex",
        "--bin", "codex-code-mode-host",
        "--bin", "codex-windows-sandbox-setup",
        "--bin", "codex-command-runner"
    ) -WorkingDirectory $CodexRustRoot

    if ($mergeStarted) {
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("commit", "-m", "Merge upstream release $releaseTag into rz-main") -WorkingDirectory $RepoRoot
        $mergeStarted = $false
    }

    Invoke-NativeCommand -FilePath "git" -ArgumentList @("push", "origin", $BranchName) -WorkingDirectory $RepoRoot
    $installedCommit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve the installed RzCodex commit."
    }
    Install-CodexBinary -Commit $installedCommit -BaseVersion $baseVersion
    Write-UpdateStatus -Result "updated" -Message "RzCodex $baseVersion built, pushed, and installed successfully." -Commit $installedCommit
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
