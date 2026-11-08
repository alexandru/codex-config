$ErrorActionPreference = 'Stop'
$isWindowsHost = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

$installer = Join-Path $PSScriptRoot '..\bin\utils\install.ps1'
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $installer,
    [ref]$tokens,
    [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count -gt 0) {
    throw "PowerShell syntax errors in ${installer}: $($parseErrors -join '; ')"
}

. $installer
$nativeCommand = (Get-Command -Name Invoke-NativeCommand -CommandType Function).ScriptBlock

$existingPath = 'C:\Tools;C:\Program Files\NodeJS'
$deduplicatedPath = Merge-PathEntry -CurrentPath $existingPath -Entry 'c:\program files\nodejs\'
if ($deduplicatedPath -ne $existingPath) {
    throw "Merge-PathEntry changed a duplicate entry: $deduplicatedPath"
}

$entryWithSpaces = 'C:\Users\Test User\.codex\bin'
$mergedPath = Merge-PathEntry -CurrentPath $deduplicatedPath -Entry $entryWithSpaces
$repeatedPath = Merge-PathEntry -CurrentPath $mergedPath -Entry 'c:\users\test user\.codex\bin\'
if ($mergedPath -ne $repeatedPath) {
    throw 'Merge-PathEntry did not keep a path containing spaces idempotent.'
}
if (($mergedPath -split ';').Count -ne 3) {
    throw "Merge-PathEntry returned an unexpected path: $mergedPath"
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex launcher test {0}" -f [guid]::NewGuid().ToString('N'))
if ($isWindowsHost) {
    $launcherDirectory = Join-Path $temporaryRoot 'bin with spaces'
    $stubDirectory = Join-Path $temporaryRoot 'stub'
    $null = New-Item -ItemType Directory -Force -Path $launcherDirectory, $stubDirectory
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\bin\codex-switch.cmd') `
        -Destination (Join-Path $launcherDirectory 'codex-switch.cmd')
    [IO.File]::WriteAllText(
        (Join-Path $launcherDirectory 'codex-switch'),
        'codex-switch.py',
        [Text.Encoding]::ASCII
    )
    $stubPath = Join-Path $stubDirectory 'pipx.cmd'
    Set-Content -LiteralPath $stubPath -Encoding ASCII -Value @(
        '@echo off',
        '> "%CODEX_TEST_ARGS_FILE%" echo %*',
        'exit /b 37'
    )
    $originalPath = $env:Path
    $originalArgsFile = $env:CODEX_TEST_ARGS_FILE
    $argumentsFile = Join-Path $temporaryRoot 'arguments.txt'
    try {
        $env:Path = "$launcherDirectory;$stubDirectory;$originalPath"
        $env:CODEX_TEST_ARGS_FILE = $argumentsFile
        & codex-switch --preset 'alpha beta'
        $launcherExitCode = $LASTEXITCODE
        if ($launcherExitCode -ne 37) {
            throw "codex-switch.cmd returned $launcherExitCode instead of 37."
        }
        $forwardedArguments = (Get-Content -LiteralPath $argumentsFile -Raw).Trim()
        $expectedArguments = 'run "{0}" --preset "alpha beta"' -f `
            (Join-Path $launcherDirectory 'codex-switch.py')
        if ($forwardedArguments -ne $expectedArguments) {
            throw "codex-switch.cmd forwarded unexpected arguments: $forwardedArguments"
        }
    } finally {
        $env:Path = $originalPath
        if ($null -eq $originalArgsFile) {
            Remove-Item Env:CODEX_TEST_ARGS_FILE -ErrorAction SilentlyContinue
        } else {
            $env:CODEX_TEST_ARGS_FILE = $originalArgsFile
        }
    }
}
Remove-Item -LiteralPath $temporaryRoot -Force -Recurse -ErrorAction SilentlyContinue

$orchestrationRoot = Join-Path ([IO.Path]::GetTempPath()) `
    ("codex installer test {0}" -f [guid]::NewGuid().ToString('N'))
$sourceDirectory = Join-Path $orchestrationRoot 'configuration source with spaces'
$destinationDirectory = Join-Path $orchestrationRoot 'custom config with spaces'
$agentsDirectory = Join-Path $destinationDirectory 'agents'
$null = New-Item -ItemType Directory -Force -Path $sourceDirectory, $agentsDirectory
$configFile = Join-Path $destinationDirectory 'config.toml'
[IO.File]::WriteAllText($configFile, 'local_setting = "preserve me"')

$originalOs = $env:OS
$originalCodexHome = $env:CODEX_HOME
$originalRepository = $env:INSTALL_REPOSITORY
$env:OS = 'Windows_NT'
$env:CODEX_HOME = $destinationDirectory
$env:INSTALL_REPOSITORY = 'https://example.invalid/codex-config.git'
$script:InstallerNativeCalls = @()
$script:InstallerPathEntries = @()
$script:InstallerUserVariables = @()
$script:InstallerSkillsCalls = 0
$script:InstallerNodeCalls = 0
$script:InstallerPipxCalls = 0

function Get-GitExecutable { return 'git.exe' }
function Get-PythonExecutable { return 'python.exe' }
function Install-Pipx { $script:InstallerPipxCalls++ }
function Find-LocalSource { return $sourceDirectory }
function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    $script:InstallerNativeCalls += ,([pscustomobject]@{
        Executable = $Executable
        Arguments = @($Arguments)
        FailureMessage = $FailureMessage
    })
}
function Install-Node { $script:InstallerNodeCalls++ }
function Install-SharedSkills { $script:InstallerSkillsCalls++ }
function Add-UserPathEntries {
    param([Parameter(Mandatory)][string[]]$Entries)
    $script:InstallerPathEntries += $Entries
}
function Set-UserEnvironmentVariable {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value
    )
    $script:InstallerUserVariables += ,([pscustomobject]@{
        Name = $Name
        Value = $Value
    })
}

try {
    Install-CodexConfig
    if ($script:InstallerNativeCalls.Count -ne 1) {
        throw "Expected one deployment command, found $($script:InstallerNativeCalls.Count)."
    }
    $deployment = $script:InstallerNativeCalls[0]
    if ($deployment.Executable -ne 'python.exe') {
        throw "The installer used an unexpected deploy executable: $($deployment.Executable)"
    }
    $destinationIndex = [Array]::IndexOf($deployment.Arguments, '--destination')
    if ($destinationIndex -lt 0 -or $deployment.Arguments[$destinationIndex + 1] -ne $destinationDirectory) {
        throw 'The installer did not pass custom CODEX_HOME as one path argument.'
    }
    if ($deployment.Arguments -contains 'default') {
        throw 'The installer requested a default preset despite existing config files.'
    }
    if ((Get-Content -LiteralPath $configFile -Raw) -ne 'local_setting = "preserve me"') {
        throw 'The installer changed the existing config.toml.'
    }
    if ($script:InstallerPipxCalls -ne 1 -or $script:InstallerNodeCalls -ne 1 -or $script:InstallerSkillsCalls -ne 1) {
        throw 'The installer did not run each prerequisite and shared skill step once.'
    }
    if ($script:InstallerPathEntries -notcontains (Join-Path $destinationDirectory 'bin')) {
        throw 'The installer did not add CODEX_HOME\bin to the user path.'
    }
    $codexHomeWrite = @($script:InstallerUserVariables | Where-Object { $_.Name -eq 'CODEX_HOME' })
    if ($codexHomeWrite.Count -ne 1 -or $codexHomeWrite[0].Value -ne $destinationDirectory) {
        throw 'The installer did not persist custom CODEX_HOME through the environment helper.'
    }
    if ($env:CODEX_HOME -ne $destinationDirectory) {
        throw 'The installer did not set process CODEX_HOME.'
    }

    Remove-Item -LiteralPath $configFile
    Install-CodexConfig
    if ($script:InstallerNativeCalls.Count -ne 3) {
        throw "Expected deployment and default-switch commands on first install, found $($script:InstallerNativeCalls.Count) total native commands."
    }
    $defaultSwitch = $script:InstallerNativeCalls[2]
    $switcherPath = Join-Path $destinationDirectory 'bin\codex-switch.py'
    if ($defaultSwitch.Executable -ne 'python.exe' -or
        $defaultSwitch.Arguments.Count -ne 5 -or
        $defaultSwitch.Arguments[0] -ne '-m' -or
        $defaultSwitch.Arguments[1] -ne 'pipx' -or
        $defaultSwitch.Arguments[2] -ne 'run' -or
        $defaultSwitch.Arguments[3] -ne $switcherPath -or
        $defaultSwitch.Arguments[4] -ne 'default') {
        throw 'The installer did not pass the default switcher path and preset as separate arguments.'
    }
} finally {
    if ($null -eq $originalOs) {
        Remove-Item Env:OS -ErrorAction SilentlyContinue
    } else {
        $env:OS = $originalOs
    }
    if ($null -eq $originalCodexHome) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_HOME = $originalCodexHome
    }
    if ($null -eq $originalRepository) {
        Remove-Item Env:INSTALL_REPOSITORY -ErrorAction SilentlyContinue
    } else {
        $env:INSTALL_REPOSITORY = $originalRepository
    }
    Remove-Item -LiteralPath $orchestrationRoot -Force -Recurse -ErrorAction SilentlyContinue
}

$nativeExecutable = $null
$nativeArguments = @()
if ($isWindowsHost) {
    $nativeExecutable = $env:ComSpec
    $nativeArguments = @('/d', '/c', 'echo native-output')
} else {
    $nativeExecutable = (Get-Command -Name 'printf' -CommandType Application |
        Select-Object -First 1).Path
    $nativeArguments = @('native-output\n')
}
$nativeResult = @(& $nativeCommand -Executable $nativeExecutable -Arguments $nativeArguments `
    -FailureMessage 'Offline native output check.')
if ($nativeResult.Count -ne 0) {
    throw "Invoke-NativeCommand returned native stdout in its success pipeline: $nativeResult"
}

$failureMessage = 'Offline native command failure check.'
try {
    if ($isWindowsHost) {
        & $nativeCommand -Executable $env:ComSpec -Arguments @('/d', '/c', 'exit 37') `
            -FailureMessage $failureMessage
    } else {
        $bash = (Get-Command -Name 'bash' -CommandType Application |
            Select-Object -First 1).Path
        & $nativeCommand -Executable $bash -Arguments @('-c', 'exit 37') `
            -FailureMessage $failureMessage
    }
    throw 'Invoke-NativeCommand did not propagate a non-zero exit code.'
} catch {
    if ($_.Exception.Message -notlike "$failureMessage Exit code: 37.*") {
        throw
    }
}

Write-Host 'PowerShell installer checks passed.'
