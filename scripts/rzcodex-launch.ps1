[CmdletBinding(DefaultParameterSetName = "Codex")]
param(
    [Parameter(Mandatory, ParameterSetName = "Bridge")]
    [ValidateSet("antigravity", "codebuddy", "commandcode", "devin")]
    [string]$Bridge,

    [Parameter(Mandatory, ParameterSetName = "Update")]
    [switch]$Update,

    [Parameter(ParameterSetName = "Codex")]
    [AllowEmptyCollection()]
    [object[]]$PipelineInput,

    [Parameter(ParameterSetName = "Codex", ValueFromRemainingArguments)]
    [string[]]$CommandArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$BridgeHandoffExitCode = 75

function Assert-ChildPath {
    param([string]$Parent, [string]$Child, [string]$Description)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Path]::GetFullPath($Child).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description is outside its managed root."
    }
}

function Resolve-ManagedBuild {
    param([Parameter(Mandatory)][object]$DeploymentState)

    $installRoot = [IO.Path]::GetFullPath($DeploymentState.installRoot)
    $pointerPath = Join-Path $installRoot "current.txt"
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        throw "RzCodex is not installed: $pointerPath is missing."
    }
    $binaryPath = [IO.Path]::GetFullPath([IO.File]::ReadAllText($pointerPath).Trim())
    Assert-ChildPath -Parent $installRoot -Child $binaryPath -Description "The active binary"
    $buildRoot = Split-Path -Parent $binaryPath
    $metadataPath = Join-Path $buildRoot "rzcodex-build.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "RzCodex build metadata is missing: $metadataPath"
    }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.activationState -ne "complete" -or [string]::IsNullOrWhiteSpace($metadata.sourceId)) {
        throw "RzCodex build metadata is incomplete."
    }
    return [pscustomobject]@{ BinaryPath = $binaryPath; BuildRoot = $buildRoot; Metadata = $metadata }
}

function Assert-ManagedFile {
    param([Parameter(Mandatory)][object]$Build, [Parameter(Mandatory)][string]$RelativePath)

    $records = @($Build.Metadata.files | Where-Object { $_.path -eq $RelativePath })
    if ($records.Count -ne 1) {
        throw "RzCodex metadata does not declare exactly one '$RelativePath'."
    }
    $path = [IO.Path]::GetFullPath((Join-Path $Build.BuildRoot $RelativePath))
    Assert-ChildPath -Parent $Build.BuildRoot -Child $path -Description "Managed file '$RelativePath'"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Managed RzCodex file is missing: $RelativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $records[0].sha256) {
        throw "Managed RzCodex file failed integrity validation: $RelativePath"
    }
    return $path
}

function Assert-VersionedScripts {
    param([Parameter(Mandatory)][object]$Build)
    foreach ($record in @($Build.Metadata.files | Where-Object { $_.path -like "scripts/*" })) {
        Assert-ManagedFile -Build $Build -RelativePath $record.path | Out-Null
    }
    $manifestPath = Assert-ManagedFile -Build $Build -RelativePath "scripts/rzcodex-setup.manifest.json"
    $schemaPath = Assert-ManagedFile -Build $Build -RelativePath "scripts/rzcodex-setup.schema.json"
    $manifestJson = Get-Content -LiteralPath $manifestPath -Raw
    if (-not ($manifestJson | Test-Json -SchemaFile $schemaPath)) {
        throw "The active RzCodex deployment manifest failed schema validation."
    }
    return $manifestJson | ConvertFrom-Json
}

function Resolve-StrictManagedBuild {
    param([Parameter(Mandatory)][object]$DeploymentState)

    $preliminaryBuild = Resolve-ManagedBuild -DeploymentState $DeploymentState
    $manifest = Assert-VersionedScripts -Build $preliminaryBuild
    $modulePath = Assert-ManagedFile -Build $preliminaryBuild -RelativePath "scripts/rzcodex-deployment.psm1"
    Import-Module $modulePath -Force
    $expectedFiles = @($manifest.binaries) + @($manifest.deploymentFiles)
    return Resolve-RzCodexManagedBuild `
        -InstallRoot ([IO.Path]::GetFullPath($DeploymentState.installRoot)) `
        -PointerPath (Join-Path ([IO.Path]::GetFullPath($DeploymentState.installRoot)) "current.txt") `
        -ExpectedRelativePaths $expectedFiles
}

$stateRoot = Split-Path -Parent $PSScriptRoot
$deploymentStatePath = Join-Path $stateRoot "deployment.json"
if (-not (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf)) {
    throw "RzCodex deployment state is missing: $deploymentStatePath"
}
$deploymentState = Get-Content -LiteralPath $deploymentStatePath -Raw | ConvertFrom-Json
foreach ($requiredProperty in @("repoRoot", "codexHome", "installRoot")) {
    if ($deploymentState.$requiredProperty -isnot [string] -or [string]::IsNullOrWhiteSpace($deploymentState.$requiredProperty)) {
        throw "RzCodex deployment state is missing '$requiredProperty'."
    }
}

$env:CODEX_HOME = [IO.Path]::GetFullPath($deploymentState.codexHome)
$env:CODEX_SQLITE_HOME = $env:CODEX_HOME
$env:RZCODEX_SEPARATE_AGENT_ROLES = "1"
$env:RZCODEX_MANAGED_LAUNCH = "1"
foreach ($packageManagerVariable in @(
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_BUN",
    "CODEX_MANAGED_BY_VITE_PLUS",
    "CODEX_MANAGED_BY_PNPM",
    "CODEX_MANAGED_PACKAGE_ROOT"
)) {
    Remove-Item -LiteralPath "Env:$packageManagerVariable" -ErrorAction SilentlyContinue
}

switch ($PSCmdlet.ParameterSetName) {
    "Bridge" {
        while ($true) {
            $managedBuild = Resolve-StrictManagedBuild -DeploymentState $deploymentState
            $supervisor = Assert-ManagedFile -Build $managedBuild -RelativePath "scripts/rzcodex-bridge-supervisor.ps1"
            & $supervisor -Bridge $Bridge -ExpectedBuildRoot $managedBuild.BuildRoot
            $exitCode = $LASTEXITCODE
            if ($exitCode -ne $BridgeHandoffExitCode) {
                exit $exitCode
            }
        }
    }
    "Update" {
        $managedBuild = Resolve-StrictManagedBuild -DeploymentState $deploymentState
        $updater = Assert-ManagedFile -Build $managedBuild -RelativePath "scripts/rzcodex-update.ps1"
        & $updater -RepoRoot $deploymentState.repoRoot -Mode ScheduledUpdate -Publish
        exit $LASTEXITCODE
    }
    "Codex" {
        $managedBuild = Resolve-StrictManagedBuild -DeploymentState $deploymentState
        $binary = Assert-ManagedFile -Build $managedBuild -RelativePath "codex.exe"
        if ($binary -ne $managedBuild.BinaryPath) {
            throw "RzCodex current pointer does not target the declared codex.exe."
        }
        $PSNativeCommandUseErrorActionPreference = $false
        if ($PSBoundParameters.ContainsKey("PipelineInput")) {
            $PipelineInput | & $binary @CommandArguments
        } else {
            & $binary @CommandArguments
        }
        $exitCode = $LASTEXITCODE
        exit $exitCode
    }
}
