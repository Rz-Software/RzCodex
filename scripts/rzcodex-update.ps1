[CmdletBinding()]
param(
    [ValidateSet("ScheduledUpdate", "LocalInstall", "ValidateOnly")]
    [string]$Mode = "ScheduledUpdate",
    [switch]$Publish,
    [switch]$ForceBuild,
    [string[]]$OwnedPath = @(),
    [string]$InvocationId = "",
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$CleanupBuildCache,
    [switch]$FullWorkspaceTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$ManifestPath = Join-Path $PSScriptRoot "rzcodex-setup.manifest.json"
$ManifestSchemaPath = Join-Path $PSScriptRoot "rzcodex-setup.schema.json"
$DeploymentModulePath = Join-Path $PSScriptRoot "rzcodex-deployment.psm1"
foreach ($requiredPath in @($ManifestPath, $ManifestSchemaPath, $DeploymentModulePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required versioned updater input is missing: $requiredPath"
    }
}
$ManifestJson = Get-Content -LiteralPath $ManifestPath -Raw
if (-not ($ManifestJson | Test-Json -SchemaFile $ManifestSchemaPath)) {
    throw "The versioned RzCodex deployment manifest failed schema validation."
}
$Manifest = $ManifestJson | ConvertFrom-Json
Import-Module $DeploymentModulePath -Force
$CodexRustRoot = Join-Path $RepoRoot "codex-rs"
$InstallRoot = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Manifest.installRoot))
$PointerPath = Join-Path $InstallRoot "current.txt"
$StateRoot = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Manifest.stateRoot))
$LogRoot = Join-Path $StateRoot "Logs\Updates"
$SnapshotParent = [IO.Path]::GetFullPath($env:USERPROFILE)
$SnapshotRoot = [IO.Path]::GetFullPath((Join-Path $SnapshotParent "rzc"))
$SharedTargetRoot = if ([string]::IsNullOrEmpty($env:CARGO_TARGET_DIR)) {
    Join-Path $CodexRustRoot "target"
} else {
    [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
$StatusPath = Join-Path $StateRoot "last-update.json"
$BranchName = "rz-main"
$LockPath = Join-Path $StateRoot "update.lock"
$BuildMetadataFilename = "rzcodex-build.json"

function Assert-ChildPath {
    param([string]$Parent, [string]$Child, [string]$Description)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Path]::GetFullPath($Child).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description is outside its managed root."
    }
}

Assert-ChildPath -Parent ([IO.Path]::GetFullPath($env:USERPROFILE)) -Child $InstallRoot -Description "The install root"
Assert-ChildPath -Parent ([IO.Path]::GetFullPath($env:LOCALAPPDATA)) -Child $StateRoot -Description "The deployment state root"
Assert-ChildPath -Parent $SnapshotParent -Child $SnapshotRoot -Description "The source snapshot root"
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    throw "RzCodex repository root is missing: $RepoRoot"
}

# Start-Process opens the redirect target ReadWrite + Inheritable and hands that
# handle to the whole child tree, so a surviving descendant can still hold the
# temp file open after the direct child exited. Readers must share with that
# writer (FileShare ReadWrite) or the read races the surviving descendant.
function Read-NativeOutputText {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream)
        try {
            return $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        # Validation children may outlive their direct test runner; inherited
        # updater pipes must not keep the failure path open.
        [switch]$IsolateOutputPipes
    )

    Push-Location -LiteralPath $WorkingDirectory
    $stdoutPath = $null
    $stderrPath = $null
    try {
        if ($IsolateOutputPipes) {
            $stdoutPath = [IO.Path]::GetTempFileName()
            $stderrPath = [IO.Path]::GetTempFileName()
            $process = Start-Process -FilePath $FilePath `
                -ArgumentList $ArgumentList `
                -WorkingDirectory $WorkingDirectory `
                -RedirectStandardOutput $stdoutPath `
                -RedirectStandardError $stderrPath `
                -NoNewWindow `
                -PassThru
            try {
                $process.WaitForExit()
                $exitCode = $process.ExitCode
            }
            finally {
                $process.Dispose()
            }
            if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) {
                $stdout = Read-NativeOutputText -Path $stdoutPath
                if ($stdout) {
                    Write-Output -NoEnumerate $stdout
                }
            }
            if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
                $stderr = Read-NativeOutputText -Path $stderrPath
                if ($stderr) {
                    [Console]::Error.Write($stderr)
                }
            }
        }
        else {
            & $FilePath @ArgumentList
            $exitCode = $LASTEXITCODE
        }
        if ($exitCode -ne 0) {
            throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally {
        if ($stdoutPath) {
            Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        }
        if ($stderrPath) {
            Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
        }
        Pop-Location
    }
}

function Get-GitText {
    param(
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )

    $gitArguments = @("-c", "core.longpaths=true") + @($ArgumentList)
    $output = (& git -C $WorkingDirectory @gitArguments | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git -C $WorkingDirectory $($ArgumentList -join ' ')"
    }
    Write-Output -NoEnumerate ([string]$output)
}

function Get-StringHash {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Write-AtomicJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $json = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

$script:UpdateStatus = [ordered]@{
    schemaVersion = 2
    invocationId = $InvocationId
    mode = $Mode
    result = "running"
    message = "RzCodex update started."
    sourceId = ""
    installedBuildId = ""
    previousBinaryPath = ""
    timestamp = (Get-Date).ToString("o")
    phases = [ordered]@{
        snapshot = "not_started"
        validation = "not_started"
        build = "not_started"
        publish = "not_started"
        activation = "not_started"
        cleanup = "not_started"
    }
}

function Set-UpdatePhase {
    param(
        [Parameter(Mandatory)][ValidateSet("snapshot", "validation", "build", "publish", "activation", "cleanup")][string]$Phase,
        [Parameter(Mandatory)][ValidateSet("running", "succeeded", "failed", "skipped", "warning")][string]$State,
        [string]$Message = ""
    )

    $script:UpdateStatus.phases[$Phase] = $State
    $script:UpdateStatus.timestamp = (Get-Date).ToString("o")
    if ($Message) {
        $script:UpdateStatus.message = $Message
    }
    Write-AtomicJson -Path $StatusPath -Value $script:UpdateStatus
}

function Complete-UpdateStatus {
    param(
        [Parameter(Mandatory)][string]$Result,
        [Parameter(Mandatory)][string]$Message
    )

    $script:UpdateStatus.result = $Result
    $script:UpdateStatus.message = $Message
    $script:UpdateStatus.timestamp = (Get-Date).ToString("o")
    Write-AtomicJson -Path $StatusPath -Value $script:UpdateStatus
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
    if ($release.tag_name -isnot [string] -or $release.tag_name -notmatch '^rust-v(?<Version>\d+\.\d+\.\d+)$') {
        throw "The latest published upstream Codex release has an unsupported tag: $($release.tag_name)"
    }
    return [pscustomobject]@{
        Tag = $release.tag_name
        Version = $Matches.Version
    }
}

function Get-InstalledBuildMetadata {
    if (-not (Test-Path -LiteralPath $PointerPath -PathType Leaf)) {
        return $null
    }
    $expectedFiles = @($Manifest.binaries) + @($Manifest.deploymentFiles)
    return (Resolve-RzCodexManagedBuild -InstallRoot $InstallRoot -PointerPath $PointerPath -ExpectedRelativePaths $expectedFiles).Metadata
}

function Assert-CleanScheduledCheckout {
    $branch = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("branch", "--show-current")
    if ($branch -ne $BranchName) {
        throw "Scheduled RzCodex update requires branch '$BranchName'; current branch is '$branch'."
    }
    $changes = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("status", "--porcelain=v1", "--untracked-files=all")
    if ($changes) {
        throw "Scheduled RzCodex update refused because the checkout has tracked, staged, or untracked changes."
    }
}

function Resolve-OwnedFiles {
    if ($OwnedPath.Count -eq 0) {
        if ($Mode -eq "LocalInstall") {
            throw "LocalInstall requires at least one explicit -OwnedPath file."
        }
        return @()
    }

    $repoPrefix = $RepoRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    $resolved = foreach ($path in $OwnedPath) {
        $absolutePath = if ([IO.Path]::IsPathRooted($path)) {
            [IO.Path]::GetFullPath($path)
        } else {
            [IO.Path]::GetFullPath((Join-Path $RepoRoot $path))
        }
        if (-not $absolutePath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Owned path is outside the RzCodex repository: $path"
        }
        if (Test-Path -LiteralPath $absolutePath -PathType Container) {
            throw "Owned paths must name individual files, not directories: $path"
        }
        $relativePath = [IO.Path]::GetRelativePath($RepoRoot, $absolutePath).Replace("\", "/")
        if ($relativePath -eq ".git" -or $relativePath.StartsWith(".git/") -or $relativePath.StartsWith("codex-rs/target/")) {
            throw "Owned path is not a source input: $relativePath"
        }
        & git -C $RepoRoot cat-file -e "HEAD:$relativePath" 2>$null
        $trackedAtHead = $LASTEXITCODE -eq 0
        if (-not $trackedAtHead -and -not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            throw "Owned path is neither a current file nor a file tracked at HEAD: $relativePath"
        }
        [pscustomobject]@{
            RelativePath = $relativePath
            AbsolutePath = $absolutePath
        }
    }
    return @($resolved | Sort-Object RelativePath -Unique)
}

function Get-OwnedFileState {
    param([Parameter(Mandatory)][object[]]$Files)

    $entries = @(foreach ($file in $Files) {
        if (Test-Path -LiteralPath $file.AbsolutePath -PathType Leaf) {
            $item = Get-Item -LiteralPath $file.AbsolutePath
            [ordered]@{
                path = $file.RelativePath
                state = "file"
                size = $item.Length
                sha256 = (Get-FileHash -LiteralPath $file.AbsolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } else {
            [ordered]@{
                path = $file.RelativePath
                state = "deleted"
                size = 0
                sha256 = ""
            }
        }
    })
    $json = ConvertTo-Json -InputObject $entries -Depth 4 -Compress
    return [pscustomobject]@{
        Entries = @($entries)
        Json = $json
        Hash = Get-StringHash $json
    }
}

function New-DetachedSnapshot {
    param([Parameter(Mandatory)][string]$Commit)

    $path = [IO.Path]::GetFullPath((Join-Path $SnapshotRoot "worktree"))
    if (Test-Path -LiteralPath $path) {
        throw "Managed source snapshot path already exists; refusing to reuse a stale worktree: $path"
    }
    $registeredPaths = @(Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("worktree", "list", "--porcelain") |
        Where-Object { $_ -like "worktree *" } |
        ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9).Trim()) })
    if (@($registeredPaths | Where-Object { $_ -eq $path }).Count -ne 0) {
        throw "Managed source snapshot path is already registered with Git; refusing to reuse it: $path"
    }
    $null = Invoke-NativeCommand -FilePath "git" -ArgumentList @(
        "-c", "core.longpaths=true",
        "worktree", "add", "--detach", $path, $Commit
    ) -WorkingDirectory $RepoRoot
    return $path
}

function Copy-OwnedFilesToSnapshot {
    param(
        [Parameter(Mandatory)][object[]]$Files,
        [Parameter(Mandatory)][string]$SnapshotPath
    )

    foreach ($file in $Files) {
        $destination = Join-Path $SnapshotPath $file.RelativePath
        if (Test-Path -LiteralPath $file.AbsolutePath -PathType Leaf) {
            $parent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            Copy-Item -LiteralPath $file.AbsolutePath -Destination $destination -Force
        } elseif (Test-Path -LiteralPath $destination -PathType Leaf) {
            Remove-Item -LiteralPath $destination -Force
        }
    }
}

function Get-SnapshotFingerprint {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)][string]$BaseCommit
    )

    $patchPath = Join-Path $StateRoot ("snapshot-{0}-{1}.patch" -f $PID, [Guid]::NewGuid().ToString("N"))
    try {
        $null = Invoke-NativeCommand -FilePath "git" -ArgumentList @(
            "-c", "core.longpaths=true",
            "diff", "--binary", "--no-ext-diff", "--output=$patchPath", $BaseCommit, "--"
        ) -WorkingDirectory $SnapshotPath
        $patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $untrackedText = Get-GitText -WorkingDirectory $SnapshotPath -ArgumentList @(
            "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"
        )
        $untracked = @($untrackedText -split "`r?`n" | Where-Object { $_ })
        $untrackedEntries = foreach ($relativePath in ($untracked | Sort-Object)) {
            $path = Join-Path $SnapshotPath $relativePath
            [ordered]@{
                path = $relativePath
                size = (Get-Item -LiteralPath $path).Length
                sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
        $description = [ordered]@{
            baseCommit = $BaseCommit
            patchSha256 = $patchHash
            untracked = @($untrackedEntries)
        } | ConvertTo-Json -Depth 5 -Compress
        return Get-StringHash $description
    }
    finally {
        Remove-Item -LiteralPath $patchPath -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-ReleaseVersionConflict {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)][string]$BaseVersion
    )

    $unmergedText = Get-GitText -WorkingDirectory $SnapshotPath -ArgumentList @("diff", "--name-only", "--diff-filter=U")
    $unmergedPaths = @($unmergedText -split "`r?`n" | Where-Object { $_ })
    if ($unmergedPaths.Count -ne 1 -or $unmergedPaths[0] -ne "codex-rs/Cargo.toml") {
        throw "Upstream release merge has unsupported conflicts: $($unmergedPaths -join ', ')"
    }
    $cargoTomlPath = Join-Path $SnapshotPath "codex-rs\Cargo.toml"
    $cargoToml = [IO.File]::ReadAllText($cargoTomlPath)
    $pattern = '(?m)^<<<<<<< HEAD\r?\nversion = "(?<Current>\d+\.\d+\.\d+)"\r?\n=======\r?\nversion = "(?<Incoming>\d+\.\d+\.\d+)"\r?\n>>>>>>> [^\r\n]+\r?\n'
    $matches = [regex]::Matches($cargoToml, $pattern)
    $markerCount = [regex]::Matches($cargoToml, '(?m)^<<<<<<< |^=======\r?$|^>>>>>>> ').Count
    if ($matches.Count -ne 1 -or $markerCount -ne 3 -or $matches[0].Groups["Incoming"].Value -ne $BaseVersion) {
        throw "Cargo.toml did not contain the exact supported release-version conflict."
    }
    $newline = if ($matches[0].Value.Contains("`r`n")) { "`r`n" } else { "`n" }
    $resolved = [regex]::new($pattern).Replace($cargoToml, "version = `"$BaseVersion`"$newline", 1)
    [IO.File]::WriteAllText($cargoTomlPath, $resolved)
    Invoke-NativeCommand -FilePath "cargo" -ArgumentList @("metadata", "--format-version", "1", "--no-deps") -WorkingDirectory (Join-Path $SnapshotPath "codex-rs")
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("add", "--", "codex-rs/Cargo.toml", "codex-rs/Cargo.lock") -WorkingDirectory $SnapshotPath
}

function Initialize-WindowsBuildEnvironment {
    $processorCount = [Environment]::ProcessorCount
    if ($processorCount -lt 1) {
        throw "Could not determine the logical processor count."
    }
    $env:CARGO_BUILD_JOBS = $processorCount.ToString()
    $rustSysroot = (& rustc --print sysroot).Trim()
    $hostTriple = (& rustc --print host-tuple).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $rustSysroot -or -not $hostTriple) {
        throw "Could not resolve the active Rust toolchain."
    }
    $rustLld = Join-Path $rustSysroot "lib\rustlib\$hostTriple\bin\rust-lld.exe"
    if (-not (Test-Path -LiteralPath $rustLld -PathType Leaf)) {
        throw "Rust's bundled linker was not found: $rustLld"
    }
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $rustLld
    $env:CARGO_TARGET_DIR = $SharedTargetRoot
}

function Initialize-RustyV8Artifacts {
    param([Parameter(Mandatory)][string]$SnapshotPath)

    $cargoLock = [IO.File]::ReadAllText((Join-Path $SnapshotPath "codex-rs\Cargo.lock"))
    $matches = [regex]::Matches($cargoLock, '(?ms)^\[\[package\]\]\r?\nname = "v8"\r?\nversion = "([^"]+)"')
    $versions = @($matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
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
    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

    $checksumsPath = Join-Path $artifactRoot $checksumsName
    $temporaryChecksumsPath = "$checksumsPath.$PID.tmp"
    Invoke-WebRequest -Uri "$baseUrl/$checksumsName" -OutFile $temporaryChecksumsPath
    Move-Item -LiteralPath $temporaryChecksumsPath -Destination $checksumsPath -Force
    $checksumEntries = @{}
    foreach ($line in [IO.File]::ReadAllLines($checksumsPath)) {
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            throw "Invalid rusty_v8 checksum entry."
        }
        $checksumEntries[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    }
    if ($checksumEntries.Count -ne 2 -or -not $checksumEntries.ContainsKey($archiveName) -or -not $checksumEntries.ContainsKey($bindingName)) {
        throw "The rusty_v8 checksum manifest does not contain exactly the expected artifacts."
    }
    foreach ($fileName in @($archiveName, $bindingName)) {
        $artifactPath = Join-Path $artifactRoot $fileName
        $expectedHash = $checksumEntries[$fileName]
        $valid = (Test-Path -LiteralPath $artifactPath -PathType Leaf) -and
            ((Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash)
        if (-not $valid) {
            $temporaryPath = "$artifactPath.$PID.tmp"
            Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $temporaryPath
            $actualHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $expectedHash) {
                throw "Checksum mismatch for downloaded rusty_v8 artifact: $fileName"
            }
            Move-Item -LiteralPath $temporaryPath -Destination $artifactPath -Force
        }
    }
    $env:RUSTY_V8_ARCHIVE = Join-Path $artifactRoot $archiveName
    $env:RUSTY_V8_SRC_BINDING_PATH = Join-Path $artifactRoot $bindingName
}

function Invoke-ValidationGate {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)][bool]$RunFullWorkspaceTests
    )

    $snapshotRustRoot = Join-Path $SnapshotPath "codex-rs"
    Invoke-NativeCommand -FilePath "just" -ArgumentList @("fmt-check") -WorkingDirectory $snapshotRustRoot -IsolateOutputPipes
    $rustArguments = @("test", "--profile", "validation")
    if ($RunFullWorkspaceTests) {
        Invoke-NativeCommand -FilePath "just" -ArgumentList $rustArguments -WorkingDirectory $snapshotRustRoot -IsolateOutputPipes
    } else {
        foreach ($package in @($Manifest.validation.rustPackages)) {
            $rustArguments += @("-p", $package)
        }
        Invoke-NativeCommand -FilePath "just" -ArgumentList $rustArguments -WorkingDirectory $snapshotRustRoot -IsolateOutputPipes
    }
    foreach ($arguments in @($Manifest.validation.javascript)) {
        Invoke-NativeCommand -FilePath "node" -ArgumentList @($arguments) -WorkingDirectory $SnapshotPath -IsolateOutputPipes
    }
}

function Test-InstalledBuildDirectory {
    param(
        [Parameter(Mandatory)][string]$BuildRoot,
        [Parameter(Mandatory)][string]$SourceId,
        [Parameter(Mandatory)][string]$AggregateHash
    )

    try {
        $metadata = Get-Content -LiteralPath (Join-Path $BuildRoot $BuildMetadataFilename) -Raw | ConvertFrom-Json
        if ($metadata.activationState -ne "complete" -or $metadata.sourceId -ne $SourceId -or $metadata.aggregateSha256 -ne $AggregateHash) {
            return $false
        }
        foreach ($record in @($metadata.files)) {
            $path = Join-Path $BuildRoot $record.path
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                return $false
            }
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.sha256) {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Install-CodexBuild {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)][string]$SourceId,
        [Parameter(Mandatory)][string]$SourceCommit,
        [Parameter(Mandatory)][string]$SourceTreeHash,
        [Parameter(Mandatory)][string]$BaseVersion,
        [Parameter(Mandatory)][bool]$DirtySnapshot
    )

    $releaseRoot = Join-Path $SharedTargetRoot "release"
    $stageRoot = Join-Path $InstallRoot (".staging-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    try {
        $records = @()
        foreach ($binaryName in @($Manifest.binaries)) {
            $source = Join-Path $releaseRoot $binaryName
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "Built RzCodex binary was not found: $source"
            }
            $destination = Join-Path $stageRoot $binaryName
            Copy-Item -LiteralPath $source -Destination $destination
            $records += [pscustomobject][ordered]@{
                path = $binaryName
                size = (Get-Item -LiteralPath $destination).Length
                sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
        foreach ($relativePath in @($Manifest.deploymentFiles)) {
            $source = Join-Path $SnapshotPath $relativePath
            Assert-ChildPath -Parent $SnapshotPath -Child $source -Description "Deployment source '$relativePath'"
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "Versioned deployment input was not found in the immutable snapshot: $relativePath"
            }
            $destination = Join-Path $stageRoot $relativePath
            Assert-ChildPath -Parent $stageRoot -Child $destination -Description "Deployment destination '$relativePath'"
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination
            $records += [pscustomobject][ordered]@{
                path = $relativePath
                size = (Get-Item -LiteralPath $destination).Length
                sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
        $records = @($records | Sort-Object path)
        $aggregateHash = Get-StringHash ($records | ConvertTo-Json -Depth 4 -Compress)
        $buildId = "$SourceId-$($aggregateHash.Substring(0, 12))"
        $finalRoot = Join-Path (Join-Path $InstallRoot "builds") $buildId

        $reportedVersion = (& (Join-Path $stageRoot "codex.exe") --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne "RzCodex $BaseVersion") {
            throw "The staged RzCodex binary reported '$reportedVersion'; expected 'RzCodex $BaseVersion'."
        }
        $metadata = [ordered]@{
            schemaVersion = 2
            product = "RzCodex"
            baseVersion = $BaseVersion
            sourceId = $SourceId
            sourceCommit = $SourceCommit
            sourceTreeSha256 = $SourceTreeHash
            dirtySnapshot = $DirtySnapshot
            aggregateSha256 = $aggregateHash
            buildId = $buildId
            builtAt = (Get-Date).ToString("o")
            activationState = "complete"
            files = $records
        }
        Write-AtomicJson -Path (Join-Path $stageRoot $BuildMetadataFilename) -Value $metadata

        New-Item -ItemType Directory -Path (Split-Path -Parent $finalRoot) -Force | Out-Null
        if (Test-Path -LiteralPath $finalRoot -PathType Container) {
            if (-not (Test-InstalledBuildDirectory -BuildRoot $finalRoot -SourceId $SourceId -AggregateHash $aggregateHash)) {
                throw "An existing versioned build has the same identity but different contents: $finalRoot"
            }
        } else {
            Move-Item -LiteralPath $stageRoot -Destination $finalRoot
            $stageRoot = $null
        }

        $destinationBinary = Join-Path $finalRoot "codex.exe"
        $pointerResult = Switch-RzCodexCurrentPointer `
            -PointerPath $PointerPath `
            -NewBinaryPath $destinationBinary `
            -PostActivationCheck {
                param($ActivePointerPath, $ExpectedBinaryPath)
                $activeBinaryPath = [IO.Path]::GetFullPath([IO.File]::ReadAllText($ActivePointerPath).Trim())
                if ($activeBinaryPath -ne [IO.Path]::GetFullPath($ExpectedBinaryPath)) {
                    throw "The active pointer does not resolve to the newly installed binary."
                }
                $activeBuild = Resolve-RzCodexManagedBuild -InstallRoot $InstallRoot -PointerPath $ActivePointerPath
                $activeVersion = (& $activeBuild.BinaryPath --version | Out-String).Trim()
                if ($LASTEXITCODE -ne 0 -or $activeVersion -ne "RzCodex $BaseVersion") {
                    throw "The active RzCodex binary reported '$activeVersion'; expected 'RzCodex $BaseVersion'."
                }
                $doctorStartInfo = [Diagnostics.ProcessStartInfo]::new()
                $doctorStartInfo.FileName = $activeBuild.BinaryPath
                $doctorStartInfo.UseShellExecute = $false
                $doctorStartInfo.CreateNoWindow = $true
                $doctorStartInfo.RedirectStandardOutput = $true
                $doctorStartInfo.RedirectStandardError = $true
                $doctorStartInfo.ArgumentList.Add("doctor")
                $doctorStartInfo.ArgumentList.Add("--json")
                $doctorProcess = [Diagnostics.Process]::new()
                $doctorProcess.StartInfo = $doctorStartInfo
                if (-not $doctorProcess.Start()) {
                    throw "The active RzCodex doctor process could not start."
                }
                $doctorStdout = $doctorProcess.StandardOutput.ReadToEndAsync()
                $doctorStderr = $doctorProcess.StandardError.ReadToEndAsync()
                $doctorProcess.WaitForExit()
                $doctorJson = $doctorStdout.GetAwaiter().GetResult()
                $null = $doctorStderr.GetAwaiter().GetResult()
                $doctorProcess.Dispose()
                $doctor = $doctorJson | ConvertFrom-Json
                if ($doctor.schemaVersion -ne 1 -or $doctor.codexVersion -ne $BaseVersion) {
                    throw "The active RzCodex doctor report has unexpected provenance: $($doctor.codexVersion)"
                }
            }
        return [pscustomobject]@{
            BuildId = $buildId
            BuildRoot = $finalRoot
            BinaryPath = $destinationBinary
            PreviousBinaryPath = $pointerResult.PreviousBinaryPath
        }
    }
    finally {
        if ($stageRoot -and (Test-Path -LiteralPath $stageRoot -PathType Container)) {
            $stagePrefix = $InstallRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar + ".staging-"
            $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
            if (-not $resolvedStage.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to clean a staging directory outside the managed install root."
            }
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}

function Remove-DetachedSnapshot {
    param([Parameter(Mandatory)][string]$SnapshotPath)

    $expectedPath = [IO.Path]::GetFullPath((Join-Path $SnapshotRoot "worktree"))
    $resolved = [IO.Path]::GetFullPath($SnapshotPath)
    if (-not [String]::Equals($resolved, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a source snapshot outside the managed worktree path: $resolved"
    }
    $null = Invoke-NativeCommand -FilePath "git" -ArgumentList @(
        "-c", "core.longpaths=true",
        "worktree", "remove", "--force", $resolved
    ) -WorkingDirectory $RepoRoot
}

function Invoke-ExplicitBuildCacheCleanup {
    $packages = @($Manifest.validation.rustPackages | Sort-Object -Unique)
    foreach ($package in $packages) {
        Invoke-NativeCommand -FilePath "cargo" -ArgumentList @("clean", "--release", "-p", $package) -WorkingDirectory $CodexRustRoot
    }
}

New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$deploymentLock = $null
try {
    $deploymentLock = Open-RzCodexDeploymentLock -Path $LockPath
}
catch {
    Write-Output "Another RzCodex deployment is already running; this invocation was skipped."
    exit 0
}
New-Item -ItemType Directory -Path $InstallRoot, $LogRoot, $SnapshotRoot -Force | Out-Null
$logPath = Join-Path $LogRoot ("update-{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $PID)
$transcriptStarted = $false
$snapshotPath = $null
$currentPhase = "snapshot"
$activationSucceeded = $false
$cleanupWarnings = @()

try {
    Start-Transcript -LiteralPath $logPath | Out-Null
    $transcriptStarted = $true

    foreach ($requiredCommand in @("git", "cargo", "just", "rustc", "node")) {
        if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
            throw "Required command is unavailable: $requiredCommand"
        }
    }
    if ($Mode -eq "ScheduledUpdate" -and -not $Publish) {
        throw "ScheduledUpdate requires explicit -Publish authorization."
    }
    if ($Mode -ne "ScheduledUpdate" -and $Publish) {
        throw "-Publish is valid only with ScheduledUpdate."
    }
    if ($Mode -eq "ScheduledUpdate" -and $FullWorkspaceTests) {
        throw "-FullWorkspaceTests is valid only with LocalInstall or ValidateOnly."
    }

    Initialize-WindowsBuildEnvironment
    $startCommit = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("rev-parse", "HEAD")
    $baseVersion = ""
    $releaseTag = ""
    $updateAvailable = $false

    if ($Mode -eq "ScheduledUpdate") {
        Assert-CleanScheduledCheckout
        $release = Resolve-UpstreamRelease
        $releaseTag = $release.Tag
        $baseVersion = $release.Version
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("fetch", "--force", "upstream", "refs/tags/${releaseTag}:refs/tags/${releaseTag}") -WorkingDirectory $RepoRoot
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("fetch", "origin", $BranchName) -WorkingDirectory $RepoRoot
        $releaseCommit = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("rev-list", "-n", "1", $releaseTag)
        & git -C $RepoRoot merge-base --is-ancestor $releaseCommit $startCommit
        if ($LASTEXITCODE -notin @(0, 1)) {
            throw "Could not compare $BranchName with upstream release $releaseTag."
        }
        $updateAvailable = $LASTEXITCODE -eq 1
        $installed = Get-InstalledBuildMetadata
        $alreadyCurrent = -not $updateAvailable -and -not $ForceBuild -and
            $null -ne $installed -and $installed.sourceCommit -eq $startCommit -and
            $installed.baseVersion -eq $baseVersion -and -not $installed.dirtySnapshot
        if ($alreadyCurrent) {
            foreach ($phase in @("snapshot", "validation", "build", "publish", "activation", "cleanup")) {
                Set-UpdatePhase -Phase $phase -State "skipped"
            }
            Complete-UpdateStatus -Result "current" -Message "RzCodex $baseVersion already contains upstream release $releaseTag."
            exit 0
        }
    }

    Set-UpdatePhase -Phase "snapshot" -State "running" -Message "Creating an immutable RzCodex source snapshot."
    $snapshotPath = New-DetachedSnapshot -Commit $startCommit
    $sourceCommit = $startCommit
    $dirtySnapshot = $false

    if ($Mode -eq "ScheduledUpdate" -and $updateAvailable) {
        Push-Location -LiteralPath $snapshotPath
        try {
            & git merge --no-commit --no-ff $releaseTag
            if ($LASTEXITCODE -ne 0) {
                Resolve-ReleaseVersionConflict -SnapshotPath $snapshotPath -BaseVersion $baseVersion
            }
            Invoke-NativeCommand -FilePath "git" -ArgumentList @("commit", "-m", "Merge upstream release $releaseTag into rz-main") -WorkingDirectory $snapshotPath
        }
        finally {
            Pop-Location
        }
        $sourceCommit = Get-GitText -WorkingDirectory $snapshotPath -ArgumentList @("rev-parse", "HEAD")
    } elseif ($Mode -ne "ScheduledUpdate") {
        $ownedFiles = Resolve-OwnedFiles
        $beforeState = Get-OwnedFileState -Files $ownedFiles
        Copy-OwnedFilesToSnapshot -Files $ownedFiles -SnapshotPath $snapshotPath
        $afterState = Get-OwnedFileState -Files $ownedFiles
        if ($beforeState.Hash -ne $afterState.Hash -or $beforeState.Json -ne $afterState.Json) {
            throw "An explicitly owned source file changed while the immutable snapshot was being created."
        }
        $dirtySnapshot = $ownedFiles.Count -gt 0
        $cargoToml = [IO.File]::ReadAllText((Join-Path $snapshotPath "codex-rs\Cargo.toml"))
        if ($cargoToml -notmatch '(?m)^version = "(?<Version>\d+\.\d+\.\d+)"\r?$') {
            throw "Could not resolve the RzCodex workspace version from the source snapshot."
        }
        $baseVersion = $Matches.Version
    }

    $sourceTreeHash = Get-SnapshotFingerprint -SnapshotPath $snapshotPath -BaseCommit $sourceCommit
    $sourceId = if ($dirtySnapshot) {
        "$($sourceCommit.Substring(0, 12))-local-$($sourceTreeHash.Substring(0, 12))"
    } else {
        $sourceCommit.Substring(0, 12)
    }
    $script:UpdateStatus.sourceId = $sourceId
    Set-UpdatePhase -Phase "snapshot" -State "succeeded" -Message "Immutable source snapshot $sourceId created."

    $currentPhase = "validation"
    Set-UpdatePhase -Phase "validation" -State "running" -Message "Running the mandatory RzCodex validation gate."
    $env:CARGO_TARGET_DIR = $SharedTargetRoot
    Initialize-RustyV8Artifacts -SnapshotPath $snapshotPath
    Invoke-ValidationGate -SnapshotPath $snapshotPath -RunFullWorkspaceTests $FullWorkspaceTests.IsPresent
    if ((Get-SnapshotFingerprint -SnapshotPath $snapshotPath -BaseCommit $sourceCommit) -ne $sourceTreeHash) {
        throw "Validation mutated the immutable source snapshot."
    }
    Set-UpdatePhase -Phase "validation" -State "succeeded" -Message "Mandatory validation gate passed."

    if ($Mode -eq "ValidateOnly") {
        foreach ($phase in @("build", "publish", "activation")) {
            Set-UpdatePhase -Phase $phase -State "skipped"
        }
        Complete-UpdateStatus -Result "validated" -Message "RzCodex source snapshot $sourceId passed the mandatory validation gate."
        exit 0
    }

    $currentPhase = "build"
    Set-UpdatePhase -Phase "build" -State "running" -Message "Building optimized RzCodex release binaries."
    $env:RZCODEX_BASE_VERSION = $baseVersion
    $env:RZCODEX_REPO_ROOT = $RepoRoot
    $env:RZCODEX_BUILD_SOURCE_ID = $sourceId
    $env:RZCODEX_SOURCE_COMMIT = $sourceCommit
    $env:RZCODEX_SOURCE_TREE_HASH = $sourceTreeHash
    Invoke-NativeCommand -FilePath "cargo" -ArgumentList @(
        "build", "--release",
        "-p", "codex-cli",
        "-p", "codex-code-mode-host",
        "-p", "codex-windows-sandbox",
        "--bin", "codex",
        "--bin", "codex-code-mode-host",
        "--bin", "codex-windows-sandbox-setup",
        "--bin", "codex-command-runner"
    ) -WorkingDirectory (Join-Path $snapshotPath "codex-rs")
    if ((Get-SnapshotFingerprint -SnapshotPath $snapshotPath -BaseCommit $sourceCommit) -ne $sourceTreeHash) {
        throw "The release build mutated the immutable source snapshot."
    }
    Set-UpdatePhase -Phase "build" -State "succeeded" -Message "Optimized RzCodex release binaries built successfully."

    $currentPhase = "publish"
    if ($Mode -eq "ScheduledUpdate" -and $updateAvailable) {
        Set-UpdatePhase -Phase "publish" -State "running" -Message "Publishing the validated upstream merge."
        Assert-CleanScheduledCheckout
        $currentCommit = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @("rev-parse", "HEAD")
        if ($currentCommit -ne $startCommit) {
            throw "The RzCodex checkout advanced while its immutable build was running; refusing to publish."
        }
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("push", "origin", "${sourceCommit}:refs/heads/${BranchName}") -WorkingDirectory $RepoRoot
        try {
            Invoke-NativeCommand -FilePath "git" -ArgumentList @("merge", "--ff-only", $sourceCommit) -WorkingDirectory $RepoRoot
            Set-UpdatePhase -Phase "publish" -State "succeeded" -Message "Validated merge published and local branch fast-forwarded."
        }
        catch {
            $cleanupWarnings += "Validated merge was pushed, but the local checkout could not fast-forward: $($_.Exception.Message)"
            Set-UpdatePhase -Phase "publish" -State "warning" -Message $cleanupWarnings[-1]
        }
    } else {
        Set-UpdatePhase -Phase "publish" -State "skipped" -Message "No commit or push was requested for this source snapshot."
    }

    $currentPhase = "activation"
    Set-UpdatePhase -Phase "activation" -State "running" -Message "Installing and atomically activating the versioned RzCodex build."
    $installedBuild = Install-CodexBuild `
        -SnapshotPath $snapshotPath `
        -SourceId $sourceId `
        -SourceCommit $sourceCommit `
        -SourceTreeHash $sourceTreeHash `
        -BaseVersion $baseVersion `
        -DirtySnapshot $dirtySnapshot
    $activationSucceeded = $true
    $script:UpdateStatus.installedBuildId = $installedBuild.BuildId
    $script:UpdateStatus.previousBinaryPath = $installedBuild.PreviousBinaryPath
    Set-UpdatePhase -Phase "activation" -State "succeeded" -Message "Versioned build $($installedBuild.BuildId) is active."

    $currentPhase = "cleanup"
    Set-UpdatePhase -Phase "cleanup" -State "running" -Message "Running explicit post-activation cleanup."
    if ($CleanupBuildCache) {
        try {
            Invoke-ExplicitBuildCacheCleanup
        }
        catch {
            $cleanupWarnings += "Scoped Cargo cache cleanup failed: $($_.Exception.Message)"
        }
    }
    if ($cleanupWarnings.Count -eq 0) {
        Set-UpdatePhase -Phase "cleanup" -State "succeeded" -Message "Post-activation cleanup completed."
        Complete-UpdateStatus -Result "installed" -Message "RzCodex $baseVersion build $($installedBuild.BuildId) validated, built, and installed successfully."
    } else {
        Set-UpdatePhase -Phase "cleanup" -State "warning" -Message ($cleanupWarnings -join " ")
        Complete-UpdateStatus -Result "installed_with_warnings" -Message "RzCodex $baseVersion build $($installedBuild.BuildId) is installed; cleanup or local synchronization reported warnings."
    }
}
catch {
    if ($script:UpdateStatus.phases[$currentPhase] -eq "running") {
        Set-UpdatePhase -Phase $currentPhase -State "failed" -Message $_.Exception.Message
    }
    if ($activationSucceeded) {
        Complete-UpdateStatus -Result "installed_with_warnings" -Message "The RzCodex build is active, but a later operation failed: $($_.Exception.Message)"
    } else {
        Complete-UpdateStatus -Result "failed" -Message $_.Exception.Message
    }
    throw
}
finally {
    if ($snapshotPath) {
        try {
            Remove-DetachedSnapshot -SnapshotPath $snapshotPath
        }
        catch {
            Write-Warning "Could not remove immutable source snapshot '$snapshotPath': $($_.Exception.Message)"
        }
    }
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
    if ($null -ne $deploymentLock) {
        $deploymentLock.Dispose()
    }
}
