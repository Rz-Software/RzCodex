$launcher = Join-Path $PSScriptRoot "rzcodex-launch.ps1"
$PSNativeCommandUseErrorActionPreference = $false
if ($MyInvocation.ExpectingInput) {
    $pipelineInput = @($input)
    & $launcher -PipelineInput $pipelineInput -CommandArguments $args
} elseif ($args.Count -eq 0) {
    & $launcher
} else {
    & $launcher -CommandArguments $args
}
$exitCode = $LASTEXITCODE
exit $exitCode
