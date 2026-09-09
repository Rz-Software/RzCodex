Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-RzCodexAtomicText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Contents
    )

    $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporaryPath, $Contents, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Open-RzCodexDeploymentLock {
    param([Parameter(Mandatory)][string]$Path)

    try {
        return [IO.File]::Open(
            $Path,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch [IO.IOException] {
        throw "Another RzCodex deployment owns the cross-session lock: $Path"
    }
}

function Protect-RzCodexBridgeBearerToken {
    param([Parameter(Mandatory)][string]$Path)

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "RzCodex bridge bearer token is missing: $resolvedPath"
    }

    try {
        $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $currentUserSid) {
            throw "the current Windows identity has no user SID"
        }
        $systemSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        )
        $administratorsSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
            $null
        )
        $acl = Get-Acl -LiteralPath $resolvedPath -ErrorAction Stop
        # A token started under CodexSandboxOffline/Online must not inherit the
        # parent CODEX_HOME read grant. Build the complete DACL in memory so a
        # failed DACL persistence leaves the previous descriptor intact.
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) {
            $acl.RemoveAccessRuleSpecific($rule) | Out-Null
        }
        $allow = [Security.AccessControl.AccessControlType]::Allow
        $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
        foreach ($sid in @($currentUserSid, $systemSid, $administratorsSid)) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $allow))
        }
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($resolvedPath), $acl)
    }
    catch {
        throw "Could not protect RzCodex bridge bearer token '$resolvedPath': $($_.Exception.Message)"
    }
}

function Get-RzCodexPrependedUserPath {
    param(
        [Parameter(Mandatory)][string]$LauncherRoot,
        [AllowEmptyString()][string]$ExistingPath = ""
    )

    $resolvedLauncherRoot = [IO.Path]::GetFullPath($LauncherRoot)
    $entries = @($ExistingPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $otherEntries = @($entries | Where-Object {
        [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($_)) -ne $resolvedLauncherRoot
    })
    return ((@($resolvedLauncherRoot) + $otherEntries) -join ";")
}

function Resolve-RzCodexManagedBuild {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$PointerPath,
        [string[]]$ExpectedRelativePaths = @()
    )

    if (-not (Test-Path -LiteralPath $PointerPath -PathType Leaf)) {
        return $null
    }
    $resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $installPrefix = $resolvedInstallRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    $binaryPath = [IO.Path]::GetFullPath([IO.File]::ReadAllText($PointerPath).Trim())
    if (-not $binaryPath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "RzCodex current pointer targets a file outside the managed install root."
    }
    $buildRoot = Split-Path -Parent $binaryPath
    $metadataPath = Join-Path $buildRoot "rzcodex-build.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "RzCodex build metadata is missing: $metadataPath"
    }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.activationState -ne "complete" -or
        [string]::IsNullOrWhiteSpace($metadata.sourceId) -or
        [string]::IsNullOrWhiteSpace($metadata.aggregateSha256)) {
        throw "RzCodex build metadata is incomplete."
    }

    $records = @($metadata.files | Sort-Object path)
    if ($records.Count -eq 0 -or @($records.path | Sort-Object -Unique).Count -ne $records.Count) {
        throw "RzCodex build metadata has no files or contains duplicate paths."
    }
    foreach ($record in $records) {
        if ($record.path -isnot [string] -or $record.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw "RzCodex build metadata contains an invalid file record."
        }
        $path = [IO.Path]::GetFullPath((Join-Path $buildRoot $record.path))
        $buildPrefix = $buildRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
        if (-not $path.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "RzCodex build metadata contains an escaping path: $($record.path)"
        }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "RzCodex build file is missing: $($record.path)"
        }
        if ((Get-Item -LiteralPath $path).Length -ne $record.size -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.sha256) {
            throw "RzCodex build file failed integrity validation: $($record.path)"
        }
    }
    if ($ExpectedRelativePaths.Count -gt 0) {
        $expected = @($ExpectedRelativePaths | Sort-Object -Unique)
        $actual = @($records.path | Sort-Object -Unique)
        if (($expected -join "`n") -ne ($actual -join "`n")) {
            throw "RzCodex build metadata does not match the exact manifest-declared file set."
        }
    }
    $binaryRecords = @($records | Where-Object { $_.path -eq "codex.exe" })
    if ($binaryRecords.Count -ne 1 -or [IO.Path]::GetFullPath((Join-Path $buildRoot "codex.exe")) -ne $binaryPath) {
        throw "RzCodex current pointer does not target the unique declared codex.exe."
    }
    $recordJson = ConvertTo-Json -InputObject $records -Depth 4 -Compress
    $aggregate = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($recordJson))
    ).ToLowerInvariant()
    if ($aggregate -ne $metadata.aggregateSha256) {
        throw "RzCodex build aggregate hash does not match its metadata."
    }
    return [pscustomobject]@{
        BinaryPath = $binaryPath
        BuildRoot = $buildRoot
        MetadataPath = $metadataPath
        Metadata = $metadata
    }
}

function Switch-RzCodexCurrentPointer {
    param(
        [Parameter(Mandatory)][string]$PointerPath,
        [Parameter(Mandatory)][string]$NewBinaryPath,
        [Parameter(Mandatory)][scriptblock]$PostActivationCheck
    )

    $hadPreviousPointer = Test-Path -LiteralPath $PointerPath -PathType Leaf
    $previousPointerContents = if ($hadPreviousPointer) {
        [IO.File]::ReadAllText($PointerPath)
    } else {
        ""
    }
    Write-RzCodexAtomicText -Path $PointerPath -Contents $NewBinaryPath
    try {
        & $PostActivationCheck $PointerPath $NewBinaryPath
    }
    catch {
        $activationFailure = $_.Exception.Message
        try {
            if ($hadPreviousPointer) {
                Write-RzCodexAtomicText -Path $PointerPath -Contents $previousPointerContents
            } else {
                Remove-Item -LiteralPath $PointerPath -Force -ErrorAction Stop
            }
        }
        catch {
            throw "RzCodex post-activation check failed: $activationFailure Pointer rollback also failed: $($_.Exception.Message)"
        }
        throw "RzCodex post-activation check failed and the previous pointer was restored: $activationFailure"
    }

    return [pscustomobject]@{
        HadPreviousPointer = $hadPreviousPointer
        PreviousBinaryPath = $previousPointerContents.Trim()
        CurrentBinaryPath = $NewBinaryPath
    }
}

Export-ModuleMember -Function Get-RzCodexPrependedUserPath, Open-RzCodexDeploymentLock, Protect-RzCodexBridgeBearerToken, Resolve-RzCodexManagedBuild, Switch-RzCodexCurrentPointer
