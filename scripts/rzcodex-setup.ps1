[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$InstallTasks,
    [switch]$InstallUserPath,
    [switch]$KeepUpdaterDisabled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:ScheduledTaskStopTimeout = [TimeSpan]::FromSeconds(30)
$script:ScheduledTaskStopPollMilliseconds = 100

function Expand-ManifestPath {
    param([Parameter(Mandatory)][string]$Value)
    return [Environment]::ExpandEnvironmentVariables($Value)
}

function Write-AtomicText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Contents
    )

    $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporaryPath, $Contents, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Copy-AtomicFile {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $temporaryPath = "$Destination.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    Copy-Item -LiteralPath $Source -Destination $temporaryPath
    Move-Item -LiteralPath $temporaryPath -Destination $Destination -Force
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child,
        [Parameter(Mandatory)][string]$Description
    )

    $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    $resolvedChild = [IO.Path]::GetFullPath($Child)
    if (-not $resolvedChild.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description must remain inside $Parent"
    }
}

function Test-RzCodexScheduledTaskRunning {
    param([Parameter(Mandatory)][object]$Task)

    return [string]$Task.State -eq "Running"
}

function Stop-RzCodexScheduledTaskInstance {
    param([Parameter(Mandatory)][string]$TaskName)

    Stop-ScheduledTask -TaskName $TaskName
    $deadline = [DateTimeOffset]::UtcNow.Add($script:ScheduledTaskStopTimeout)
    while ($true) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $bTaskMissing = $null -eq $task
        $bTaskStopped = -not $bTaskMissing -and -not (Test-RzCodexScheduledTaskRunning -Task $task)
        if ($bTaskMissing -or $bTaskStopped) {
            return
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw "RzCodex scheduled task '$TaskName' did not stop within $($script:ScheduledTaskStopTimeout.TotalSeconds) seconds; state=$($task.State)."
        }
        Start-Sleep -Milliseconds $script:ScheduledTaskStopPollMilliseconds
    }
}

function Suspend-RzCodexScheduledTasks {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$TaskBackups)

    foreach ($taskBackup in $TaskBackups) {
        if (-not $taskBackup.Existed) {
            continue
        }
        if ($taskBackup.WasRunning) {
            Stop-RzCodexScheduledTaskInstance -TaskName $taskBackup.Name
        }
        if (-not $taskBackup.WasDisabled) {
            Disable-ScheduledTask -TaskName $taskBackup.Name | Out-Null
        }
    }
}

function Stop-RzCodexLegacyBridgeLaunchers {
    param([Parameter(Mandatory)][string]$LauncherRoot)

    $launcherScript = [IO.Path]::GetFullPath((Join-Path $LauncherRoot "rzcodex-launch.ps1"))
    $launcherPattern = "(?i)(?:^|\s)-File\s+(?:`"$([regex]::Escape($launcherScript))`"|$([regex]::Escape($launcherScript)))\s+-Bridge(?:\s|$)"
    $legacyVbsPaths = @(
        "run-antigravity-subagent-bridge-hidden.vbs",
        "run-codebuddy-subagent-bridge-hidden.vbs",
        "run-commandcode-subagent-bridge-hidden.vbs",
        "run-devin-subagent-bridge-hidden.vbs"
    ) | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $LauncherRoot $_)) }
    $legacyVbsAlternatives = @($legacyVbsPaths | ForEach-Object {
        $escapedPath = [regex]::Escape($_)
        "(?:`"$escapedPath`"|$escapedPath)"
    }) -join "|"
    $legacyVbsPattern = "(?i)(?:^|\s)(?:$legacyVbsAlternatives)(?:\s|$)"
    $legacyLaunchers = @(Get-CimInstance Win32_Process | Where-Object {
        $bPowerShellProcess = $_.Name -in @("powershell.exe", "pwsh.exe")
        $bManagedPowerShellLauncher = $bPowerShellProcess -and $_.CommandLine -is [string] -and $_.CommandLine -match $launcherPattern
        $bManagedLegacyVbsLauncher = $_.Name -eq "wscript.exe" -and $_.CommandLine -is [string] -and $_.CommandLine -match $legacyVbsPattern
        $bManagedPowerShellLauncher -or $bManagedLegacyVbsLauncher
    })
    if ($legacyLaunchers.Count -eq 0) {
        return
    }

    $legacyProcessIds = @($legacyLaunchers.ProcessId | Sort-Object -Unique)
    foreach ($legacyProcessId in $legacyProcessIds) {
        $legacyProcess = Get-Process -Id $legacyProcessId -ErrorAction SilentlyContinue
        if ($null -ne $legacyProcess) {
            $legacyProcess.Kill($true)
        }
    }

    $deadline = [DateTimeOffset]::UtcNow.Add($script:ScheduledTaskStopTimeout)
    while ($true) {
        $survivingProcessIds = @($legacyProcessIds | Where-Object {
            $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue)
        })
        if ($survivingProcessIds.Count -eq 0) {
            return
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw "Legacy RzCodex bridge launchers did not stop within $($script:ScheduledTaskStopTimeout.TotalSeconds) seconds; launcher=$launcherScript; process_ids=$($survivingProcessIds -join ',')."
        }
        Start-Sleep -Milliseconds $script:ScheduledTaskStopPollMilliseconds
    }
}

$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    throw "RzCodex repository root is missing: $RepoRoot"
}

$manifestPath = Join-Path $PSScriptRoot "rzcodex-setup.manifest.json"
$manifestSchemaPath = Join-Path $PSScriptRoot "rzcodex-setup.schema.json"
foreach ($sourcePath in @($manifestPath, $manifestSchemaPath)) {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required RzCodex setup source is missing: $sourcePath"
    }
}
if (-not (Get-Command Test-Json -ErrorAction SilentlyContinue)) {
    throw "RzCodex setup requires PowerShell 7 with Test-Json schema validation."
}
$bootstrapManifestJson = Get-Content -LiteralPath $manifestPath -Raw
if (-not ($bootstrapManifestJson | Test-Json -SchemaFile $manifestSchemaPath)) {
    throw "RzCodex setup manifest failed schema validation."
}
$bootstrapManifest = $bootstrapManifestJson | ConvertFrom-Json

$codexHome = [IO.Path]::GetFullPath((Expand-ManifestPath $bootstrapManifest.sharedCodexHome))
$stateRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $bootstrapManifest.stateRoot))
$installRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $bootstrapManifest.installRoot))
Assert-ChildPath -Parent ([IO.Path]::GetFullPath($env:USERPROFILE)) -Child $installRoot -Description "The install root"
Assert-ChildPath -Parent ([IO.Path]::GetFullPath($env:LOCALAPPDATA)) -Child $stateRoot -Description "The deployment state root"
$launcherRoot = Join-Path $stateRoot "launcher"
$pointerPath = Join-Path $installRoot "current.txt"
$bootstrapModulePath = Join-Path $PSScriptRoot "rzcodex-deployment.psm1"
if (-not (Test-Path -LiteralPath $bootstrapModulePath -PathType Leaf)) {
    throw "RzCodex setup deployment module is missing: $bootstrapModulePath"
}
Import-Module $bootstrapModulePath -Force
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$deploymentLock = $null
try {
$deploymentLock = Open-RzCodexDeploymentLock -Path (Join-Path $stateRoot "update.lock")
$bootstrapExpectedFiles = @($bootstrapManifest.binaries) + @($bootstrapManifest.deploymentFiles)
$installedBuild = Resolve-RzCodexManagedBuild -InstallRoot $installRoot -PointerPath $pointerPath -ExpectedRelativePaths $bootstrapExpectedFiles
if ($null -eq $installedBuild) {
    throw "RzCodex must be installed before setup can register launchers or tasks."
}

$versionedScriptsRoot = Join-Path $installedBuild.BuildRoot "scripts"
$versionedManifestPath = Join-Path $versionedScriptsRoot "rzcodex-setup.manifest.json"
$versionedManifestSchemaPath = Join-Path $versionedScriptsRoot "rzcodex-setup.schema.json"
$versionedManifestJson = Get-Content -LiteralPath $versionedManifestPath -Raw
if (-not ($versionedManifestJson | Test-Json -SchemaFile $versionedManifestSchemaPath)) {
    throw "The active immutable build manifest failed schema validation."
}
$manifest = $versionedManifestJson | ConvertFrom-Json
foreach ($rootProperty in @("sharedCodexHome", "stateRoot", "installRoot")) {
    $bootstrapRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $bootstrapManifest.$rootProperty))
    $versionedRoot = [IO.Path]::GetFullPath((Expand-ManifestPath $manifest.$rootProperty))
    if ($bootstrapRoot -ne $versionedRoot) {
        throw "Bootstrap and active manifests disagree on '$rootProperty'."
    }
}

$routePath = [IO.Path]::GetFullPath((Join-Path $codexHome $manifest.routing.relativePath))
$routeSchemaSource = Join-Path $versionedScriptsRoot $manifest.routing.schemaFile
$routeSchemaDestination = [IO.Path]::GetFullPath((Join-Path $codexHome $manifest.routing.schemaFile))
$routeDefaultSource = Join-Path $versionedScriptsRoot $manifest.routing.defaultFile
$migratorPath = Join-Path $versionedScriptsRoot "rzcodex-config-migrate.mjs"
$tokenSetupPath = Join-Path $versionedScriptsRoot "rzcodex-setup-bridge-token.mjs"
$configPath = Join-Path $codexHome "config.toml"
$bridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $codexHome "bridge-security\bearer-token"))

Assert-ChildPath -Parent $codexHome -Child $routePath -Description "The route catalog"
Assert-ChildPath -Parent $codexHome -Child $routeSchemaDestination -Description "The route schema"
Assert-ChildPath -Parent $codexHome -Child $bridgeTokenPath -Description "The bridge bearer token"
Assert-ChildPath -Parent $stateRoot -Child $launcherRoot -Description "The stable launcher"

$stableFiles = @($manifest.stableLauncherFiles)
$requiredSources = @($routeSchemaSource, $routeDefaultSource, $migratorPath, $tokenSetupPath)
$requiredSources += @($stableFiles | ForEach-Object { Join-Path $versionedScriptsRoot $_ })
foreach ($sourcePath in @($requiredSources | Sort-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required RzCodex setup source is missing: $sourcePath"
    }
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "RzCodex config is missing: $configPath"
}

$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$python = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$taskPowerShellPath = $null
if ($InstallTasks) {
    if ($env:OS -ne "Windows_NT") {
        throw "RzCodex scheduled-task setup is supported only on Windows."
    }
    foreach ($commandName in @(
        "New-ScheduledTaskAction",
        "New-ScheduledTaskPrincipal",
        "New-ScheduledTaskSettingsSet",
        "New-ScheduledTaskTrigger",
        "Register-ScheduledTask",
        "Start-ScheduledTask",
        "Disable-ScheduledTask",
        "Enable-ScheduledTask",
        "Export-ScheduledTask",
        "Get-CimInstance",
        "Get-Process",
        "Get-ScheduledTask",
        "Stop-ScheduledTask",
        "Unregister-ScheduledTask"
    )) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "Required scheduled-task command is unavailable: $commandName"
        }
    }
    $taskPowerShellPath = (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}

$routeOriginallyExists = Test-Path -LiteralPath $routePath -PathType Leaf
$routeInputPath = if ($routeOriginallyExists) { $routePath } else { $routeDefaultSource }
$schemaOriginallyExists = Test-Path -LiteralPath $routeSchemaDestination -PathType Leaf
$launcherOriginallyExists = Test-Path -LiteralPath $launcherRoot -PathType Container

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("rzcodex-setup-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
$backupRoot = $null
$launcherActivated = $false
$routeActivated = $false
$schemaActivated = $false
$configActivated = $false
$userPathChanged = $false
$previousUserPath = $null
$taskBackups = @()
$tasksMutated = $false
$deploymentStatePath = Join-Path $stateRoot "deployment.json"
$deploymentStateOriginallyExists = Test-Path -LiteralPath $deploymentStatePath -PathType Leaf
try {
    $temporaryConfigPath = Join-Path $temporaryRoot "config.toml"
    $tokenCommandPath = Join-Path $launcherRoot "rzcodex-bridge-auth-token.mjs"
    $migratedConfig = (& $node.Source $migratorPath --config $configPath --token-script $tokenCommandPath | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not migrate managed bridge providers to command-backed authentication."
    }
    [IO.File]::WriteAllText($temporaryConfigPath, $migratedConfig, [Text.UTF8Encoding]::new($false))
    & $python.Source -c 'import pathlib, sys, tomllib; tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))' $temporaryConfigPath
    if ($LASTEXITCODE -ne 0) {
        throw "The migrated RzCodex config is not valid TOML."
    }

    $temporaryRoutePath = Join-Path $temporaryRoot "subagent-models.json"
    $migratedRoutes = (& $node.Source $migratorPath --routes $routeInputPath | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not add bridge authentication metadata to the central route catalog."
    }
    [IO.File]::WriteAllText($temporaryRoutePath, $migratedRoutes, [Text.UTF8Encoding]::new($false))
    if (-not ((Get-Content -LiteralPath $temporaryRoutePath -Raw) | Test-Json -SchemaFile $routeSchemaSource)) {
        throw "The central route catalog failed schema validation after authentication migration."
    }

    New-Item -ItemType Directory -Path $codexHome, $stateRoot -Force | Out-Null
    $operationId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), [Guid]::NewGuid().ToString("N")
    $backupRoot = Join-Path $stateRoot "backups\setup-$operationId"
    $stageRoot = Join-Path $stateRoot ".setup-$operationId"
    $stagedLauncherRoot = Join-Path $stageRoot "launcher"
    $previousLauncherRoot = Join-Path $stageRoot "previous-launcher"
    New-Item -ItemType Directory -Path $backupRoot, $stagedLauncherRoot -Force | Out-Null

    Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot "config.toml")
    Copy-Item -LiteralPath $routeInputPath -Destination (Join-Path $backupRoot "subagent-models.json")
    if ($schemaOriginallyExists) {
        Copy-Item -LiteralPath $routeSchemaDestination -Destination (Join-Path $backupRoot "rzcodex-subagent-models.schema.json")
    }
    if ($launcherOriginallyExists) {
        Copy-Item -LiteralPath $launcherRoot -Destination (Join-Path $backupRoot "launcher") -Recurse
    }
    if ($deploymentStateOriginallyExists) {
        Copy-Item -LiteralPath $deploymentStatePath -Destination (Join-Path $backupRoot "deployment.json")
    }
    if ($InstallTasks) {
        $taskNames = @($manifest.bridges.PSObject.Properties | ForEach-Object { $_.Value.taskName }) + @($manifest.updaterTask.taskName)
        $taskIndex = 0
        foreach ($taskName in @($taskNames | Sort-Object -Unique)) {
            $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            $taskXmlPath = Join-Path $backupRoot ("task-{0}.xml" -f $taskIndex)
            if ($null -ne $existingTask) {
                [IO.File]::WriteAllText($taskXmlPath, (Export-ScheduledTask -TaskName $taskName), [Text.UTF8Encoding]::new($false))
            }
            $taskBackups += [pscustomobject]@{
                Name = $taskName
                Existed = $null -ne $existingTask
                WasDisabled = $null -ne $existingTask -and $existingTask.State -eq "Disabled"
                WasRunning = $null -ne $existingTask -and (Test-RzCodexScheduledTaskRunning -Task $existingTask)
                XmlPath = $taskXmlPath
            }
            $taskIndex++
        }
    }
    $backupMetadata = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToString("o")
        configPath = $configPath
        routePath = $routePath
        routeOriginallyExisted = $routeOriginallyExists
        routeSchemaPath = $routeSchemaDestination
        routeSchemaOriginallyExisted = $schemaOriginallyExists
        launcherPath = $launcherRoot
        launcherOriginallyExisted = $launcherOriginallyExists
    }
    Write-AtomicText -Path (Join-Path $backupRoot "backup.json") -Contents (($backupMetadata | ConvertTo-Json) + [Environment]::NewLine)

    foreach ($fileName in $stableFiles) {
        Copy-Item -LiteralPath (Join-Path $versionedScriptsRoot $fileName) -Destination (Join-Path $stagedLauncherRoot $fileName)
    }

    if ($InstallTasks) {
        $tasksMutated = $true
        Suspend-RzCodexScheduledTasks -TaskBackups $taskBackups
        Stop-RzCodexLegacyBridgeLaunchers -LauncherRoot $launcherRoot
    }

    try {
        if ($launcherOriginallyExists) {
            Move-Item -LiteralPath $launcherRoot -Destination $previousLauncherRoot
        }
        Move-Item -LiteralPath $stagedLauncherRoot -Destination $launcherRoot
        $launcherActivated = $true

        $env:CODEX_HOME = $codexHome
        & $node.Source $tokenSetupPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not initialize RzCodex bridge authentication."
        }
        # Keep this security mutation outside setup rollback: a failed setup must
        # never restore an inherited ACL that exposes the bearer token to sandbox users.
        Protect-RzCodexBridgeBearerToken -Path $bridgeTokenPath

        Copy-AtomicFile -Source $routeSchemaSource -Destination $routeSchemaDestination
        $schemaActivated = $true
        Copy-AtomicFile -Source $temporaryRoutePath -Destination $routePath
        $routeActivated = $true
        Copy-AtomicFile -Source $temporaryConfigPath -Destination $configPath
        $configActivated = $true
    }
    catch {
        $activationFailure = $_.Exception.Message
        $rollbackFailures = @()
        try {
            if ($configActivated) {
                Copy-AtomicFile -Source (Join-Path $backupRoot "config.toml") -Destination $configPath
            }
        } catch { $rollbackFailures += "config: $($_.Exception.Message)" }
        try {
            if ($routeActivated) {
                if ($routeOriginallyExists) {
                    Copy-AtomicFile -Source (Join-Path $backupRoot "subagent-models.json") -Destination $routePath
                } else {
                    Remove-Item -LiteralPath $routePath -Force -ErrorAction Stop
                }
            }
        } catch { $rollbackFailures += "routes: $($_.Exception.Message)" }
        try {
            if ($schemaActivated) {
                if ($schemaOriginallyExists) {
                    Copy-AtomicFile -Source (Join-Path $backupRoot "rzcodex-subagent-models.schema.json") -Destination $routeSchemaDestination
                } else {
                    Remove-Item -LiteralPath $routeSchemaDestination -Force -ErrorAction Stop
                }
            }
        } catch { $rollbackFailures += "route schema: $($_.Exception.Message)" }
        try {
            if ($launcherActivated -and (Test-Path -LiteralPath $launcherRoot -PathType Container)) {
                Remove-Item -LiteralPath $launcherRoot -Recurse -Force
            }
            if ($launcherOriginallyExists -and (Test-Path -LiteralPath $previousLauncherRoot -PathType Container)) {
                Move-Item -LiteralPath $previousLauncherRoot -Destination $launcherRoot
            }
        } catch { $rollbackFailures += "launcher: $($_.Exception.Message)" }

        $rollbackSuffix = if ($rollbackFailures.Count -gt 0) {
            " Rollback failures: $($rollbackFailures -join '; ')"
        } else {
            ""
        }
        throw "RzCodex setup activation failed: $activationFailure$rollbackSuffix"
    }
    finally {
        if (Test-Path -LiteralPath $stageRoot -PathType Container) {
            Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($InstallUserPath) {
        $previousUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $updatedUserPath = Get-RzCodexPrependedUserPath -LauncherRoot $launcherRoot -ExistingPath $previousUserPath
        [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
        $userPathChanged = $true
    }

    if ($InstallTasks) {
        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
        $bridgeSettings = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -StartWhenAvailable
        foreach ($bridgeProperty in $manifest.bridges.PSObject.Properties) {
            $bridgeName = $bridgeProperty.Name
            $bridge = $bridgeProperty.Value
            $launcherPath = Join-Path $launcherRoot "rzcodex-launch.ps1"
            $launcherArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`" -Bridge `"$bridgeName`""
            $action = New-ScheduledTaskAction -Execute $taskPowerShellPath -Argument $launcherArguments -WorkingDirectory $launcherRoot
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
            Register-ScheduledTask -TaskName $bridge.taskName -Action $action -Trigger $trigger -Settings $bridgeSettings -Principal $principal -Force | Out-Null
            $priorTask = $taskBackups | Where-Object { $_.Name -eq $bridge.taskName }
            if ($priorTask.WasDisabled) {
                Disable-ScheduledTask -TaskName $bridge.taskName | Out-Null
            }
        }

        $timeParts = $manifest.updaterTask.dailyAt.Split(":")
        $updateAt = [DateTime]::Today.AddHours([int]$timeParts[0]).AddMinutes([int]$timeParts[1])
        $updateAction = New-ScheduledTaskAction `
            -Execute $taskPowerShellPath `
            -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $launcherRoot 'rzcodex-launch.ps1')`" -Update" `
            -WorkingDirectory $launcherRoot
        $updateTrigger = New-ScheduledTaskTrigger -Daily -At $updateAt
        $updateSettings = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Hours $manifest.updaterTask.executionTimeLimitHours) `
            -StartWhenAvailable
        Register-ScheduledTask -TaskName $manifest.updaterTask.taskName -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Principal $principal -Force | Out-Null
        $priorUpdaterTask = $taskBackups | Where-Object { $_.Name -eq $manifest.updaterTask.taskName }
        if ($KeepUpdaterDisabled -or $priorUpdaterTask.WasDisabled) {
            Disable-ScheduledTask -TaskName $manifest.updaterTask.taskName | Out-Null
        }
    }

    $deploymentState = [ordered]@{
        schemaVersion = 1
        repoRoot = $RepoRoot
        codexHome = $codexHome
        installRoot = $installRoot
        launcherRoot = $launcherRoot
        sourceId = $installedBuild.Metadata.sourceId
        setupBackupRoot = $backupRoot
        configuredAt = (Get-Date).ToString("o")
    }
    Write-AtomicText -Path $deploymentStatePath -Contents (($deploymentState | ConvertTo-Json) + [Environment]::NewLine)

    if ($InstallTasks) {
        foreach ($taskBackup in $taskBackups) {
            $bRestartTask = $taskBackup.Existed -and $taskBackup.WasRunning -and -not $taskBackup.WasDisabled
            if ($bRestartTask) {
                Start-ScheduledTask -TaskName $taskBackup.Name
            }
        }
    }
}
catch {
    $setupFailure = $_.Exception.Message
    $rollbackFailures = @()
    if ($InstallTasks -and $tasksMutated -and $null -ne $backupRoot) {
        for ($taskIndex = $taskBackups.Count - 1; $taskIndex -ge 0; $taskIndex--) {
            $taskBackup = $taskBackups[$taskIndex]
            try {
                $currentTask = Get-ScheduledTask -TaskName $taskBackup.Name -ErrorAction SilentlyContinue
                if ($null -ne $currentTask) {
                    if (Test-RzCodexScheduledTaskRunning -Task $currentTask) {
                        Stop-RzCodexScheduledTaskInstance -TaskName $taskBackup.Name
                    }
                    Disable-ScheduledTask -TaskName $taskBackup.Name | Out-Null
                    Unregister-ScheduledTask -TaskName $taskBackup.Name -Confirm:$false
                }
                if ($taskBackup.Existed) {
                    Register-ScheduledTask -TaskName $taskBackup.Name -Xml (Get-Content -LiteralPath $taskBackup.XmlPath -Raw) -Force | Out-Null
                    Disable-ScheduledTask -TaskName $taskBackup.Name | Out-Null
                }
            } catch { $rollbackFailures += "task '$($taskBackup.Name)': $($_.Exception.Message)" }
        }
    }
    try {
        if ($userPathChanged) {
            [Environment]::SetEnvironmentVariable("Path", $previousUserPath, "User")
        }
    } catch { $rollbackFailures += "User PATH: $($_.Exception.Message)" }
    if ($null -ne $backupRoot) {
        try {
            Copy-AtomicFile -Source (Join-Path $backupRoot "config.toml") -Destination $configPath
        } catch { $rollbackFailures += "config: $($_.Exception.Message)" }
        try {
            if ($routeOriginallyExists) {
                Copy-AtomicFile -Source (Join-Path $backupRoot "subagent-models.json") -Destination $routePath
            } elseif (Test-Path -LiteralPath $routePath -PathType Leaf) {
                Remove-Item -LiteralPath $routePath -Force
            }
        } catch { $rollbackFailures += "routes: $($_.Exception.Message)" }
        try {
            if ($schemaOriginallyExists) {
                Copy-AtomicFile -Source (Join-Path $backupRoot "rzcodex-subagent-models.schema.json") -Destination $routeSchemaDestination
            } elseif (Test-Path -LiteralPath $routeSchemaDestination -PathType Leaf) {
                Remove-Item -LiteralPath $routeSchemaDestination -Force
            }
        } catch { $rollbackFailures += "route schema: $($_.Exception.Message)" }
        try {
            if (Test-Path -LiteralPath $launcherRoot -PathType Container) {
                Remove-Item -LiteralPath $launcherRoot -Recurse -Force
            }
            if ($launcherOriginallyExists) {
                Copy-Item -LiteralPath (Join-Path $backupRoot "launcher") -Destination $launcherRoot -Recurse
            }
        } catch { $rollbackFailures += "launcher: $($_.Exception.Message)" }
        try {
            if ($deploymentStateOriginallyExists) {
                Copy-AtomicFile -Source (Join-Path $backupRoot "deployment.json") -Destination $deploymentStatePath
            } elseif (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf) {
                Remove-Item -LiteralPath $deploymentStatePath -Force
            }
        } catch { $rollbackFailures += "deployment state: $($_.Exception.Message)" }
    }
    if ($InstallTasks -and $tasksMutated -and $null -ne $backupRoot) {
        foreach ($taskBackup in $taskBackups) {
            if (-not $taskBackup.Existed) {
                continue
            }
            try {
                if ($taskBackup.WasDisabled) {
                    Disable-ScheduledTask -TaskName $taskBackup.Name | Out-Null
                } else {
                    Enable-ScheduledTask -TaskName $taskBackup.Name | Out-Null
                }
                if ($taskBackup.WasRunning -and -not $taskBackup.WasDisabled) {
                    Start-ScheduledTask -TaskName $taskBackup.Name
                }
            } catch { $rollbackFailures += "task lifecycle '$($taskBackup.Name)': $($_.Exception.Message)" }
        }
    }
    $rollbackSuffix = if ($rollbackFailures.Count -gt 0) { " Rollback failures: $($rollbackFailures -join '; ')" } else { "" }
    throw "RzCodex setup failed: $setupFailure$rollbackSuffix"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "RzCodex setup completed with shared state at $codexHome and launcher at $launcherRoot."
}
finally {
    if ($null -ne $deploymentLock) {
        $deploymentLock.Dispose()
    }
}
