<#
.SYNOPSIS
Installs the Codex configuration on Windows.

.DESCRIPTION
Requires Windows PowerShell 5.1 or later. The installer uses winget to install
Git, Python 3.11 or later, and Node.js 22.20.0 or later when they are missing
or too old. It then installs pipx 1.4.0 or later and the configured shared
skills. winget must be available to bootstrap missing software.

.EXAMPLE
.\bin\utils\install.ps1

.EXAMPLE
(Invoke-WebRequest -UseBasicParsing https://alexandru.github.io/codex-config/install.ps1).Content |
    Invoke-Expression

.NOTES
CODEX_HOME selects the destination and defaults to the current user's .codex
directory. A custom value is saved to the User environment after installation.
INSTALL_REPOSITORY overrides the configuration repository URL.
#>
#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$script:OriginalProcessPath = $env:Path
$script:GitExecutable = $null
$script:PythonExecutable = $null
$script:NpxExecutable = $null

function Get-PathIdentity {
    param([Parameter(Mandatory)][string]$Entry)

    $value = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))
    if ([string]::IsNullOrWhiteSpace($value)) {
        return ''
    }
    if ([IO.Path]::IsPathRooted($value)) {
        try {
            $value = [IO.Path]::GetFullPath($value)
        } catch {
            return $value.TrimEnd('\', '/').ToUpperInvariant()
        }
    }
    $root = [IO.Path]::GetPathRoot($value)
    if ($value.Length -gt $root.Length) {
        $value = $value.TrimEnd('\', '/')
    }
    return $value.ToUpperInvariant()
}

function Merge-PathEntry {
    param(
        [AllowEmptyString()][string]$CurrentPath,
        [Parameter(Mandatory)][string]$Entry
    )

    if ([string]::IsNullOrWhiteSpace($Entry)) {
        return $CurrentPath
    }
    $identity = Get-PathIdentity -Entry $Entry
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($CurrentPath)) {
        $entries = @($CurrentPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    foreach ($current in $entries) {
        if ((Get-PathIdentity -Entry $current) -eq $identity) {
            return ($entries -join ';')
        }
    }
    $merged = @($entries)
    $merged += $Entry.Trim().Trim('"')
    return ($merged -join ';')
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $combined = ''
    foreach ($pathValue in @($script:OriginalProcessPath, $machinePath, $userPath)) {
        foreach ($entry in ([string]$pathValue -split ';')) {
            if (-not [string]::IsNullOrWhiteSpace($entry)) {
                $combined = Merge-PathEntry -CurrentPath $combined -Entry $entry
            }
        }
    }
    $env:Path = $combined
}

function Add-UserPathEntries {
    param([Parameter(Mandatory)][string[]]$Entries)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($entry in $Entries) {
        $userPath = Merge-PathEntry -CurrentPath $userPath -Entry $entry
    }
    Set-UserEnvironmentVariable -Name 'Path' -Value $userPath
    Refresh-ProcessPath
}

function Set-UserEnvironmentVariable {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
}

function Get-ApplicationPath {
    param([Parameter(Mandatory)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $command) {
            return $command.Source
        }
    }
    return $null
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    try {
        & $Executable @Arguments | Out-Host
        $status = $LASTEXITCODE
    } catch {
        throw "$FailureMessage Could not start '$Executable': $($_.Exception.Message)"
    }
    if ($status -ne 0) {
        throw "$FailureMessage Exit code: $status."
    }
}

function Invoke-NativeOutput {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    try {
        $output = @(& $Executable @Arguments 2>$null)
        $status = $LASTEXITCODE
    } catch {
        throw "$FailureMessage Could not start '$Executable': $($_.Exception.Message)"
    }
    if ($status -ne 0) {
        throw "$FailureMessage Exit code: $status."
    }
    return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Install-WinGetPackage {
    param([Parameter(Mandatory)][string]$PackageId)

    $winget = Get-ApplicationPath -Names @('winget.exe', 'winget')
    if ($null -eq $winget) {
        throw "winget is required to install $PackageId. Install App Installer, then rerun this script."
    }
    Write-Host "Installing $PackageId with winget..."
    Invoke-NativeCommand -Executable $winget -Arguments @(
        'install', '--id', $PackageId, '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--silent'
    ) -FailureMessage "winget could not install $PackageId."
    Refresh-ProcessPath
}

function Get-GitExecutable {
    $script:GitExecutable = Get-ApplicationPath -Names @('git.exe', 'git')
    if ($null -eq $script:GitExecutable) {
        Install-WinGetPackage -PackageId 'Git.Git'
        $script:GitExecutable = Get-ApplicationPath -Names @('git.exe', 'git')
    }
    if ($null -eq $script:GitExecutable) {
        throw 'Git was installed or detected, but git.exe is not available on PATH. Restart PowerShell and rerun the installer.'
    }
    return $script:GitExecutable
}

function Test-PythonExecutable {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [string[]]$PrefixArguments = @()
    )

    if ($Executable -match '\\AppData\\Local\\Microsoft\\WindowsApps\\') {
        return $null
    }
    $probe = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)"
    try {
        $result = @(& $Executable @PrefixArguments '-c' $probe 2>$null)
        $status = $LASTEXITCODE
    } catch {
        return $null
    }
    if ($status -ne 0 -or $result.Count -lt 2) {
        return $null
    }
    try {
        $version = [version]([string]$result[0]).Trim()
        $actualPath = [string]$result[1]
        if ($actualPath -match '\\AppData\\Local\\Microsoft\\WindowsApps\\' -or $version -lt [version]'3.11') {
            return $null
        }
        return [pscustomobject]@{
            Path = [IO.Path]::GetFullPath($actualPath)
            Version = $version
        }
    } catch {
        return $null
    }
}

function Find-SupportedPython {
    $pyLauncher = Get-ApplicationPath -Names @('py.exe', 'py')
    if ($null -ne $pyLauncher) {
        $python = Test-PythonExecutable -Executable $pyLauncher -PrefixArguments @('-3')
        if ($null -ne $python) {
            return $python
        }
    }
    foreach ($name in @('python.exe', 'python', 'python3.exe', 'python3')) {
        $candidate = Get-ApplicationPath -Names @($name)
        if ($null -ne $candidate) {
            $python = Test-PythonExecutable -Executable $candidate
            if ($null -ne $python) {
                return $python
            }
        }
    }
    return $null
}

function Get-PythonExecutable {
    $python = Find-SupportedPython
    if ($null -eq $python) {
        Install-WinGetPackage -PackageId 'Python.Python.3.13'
        $python = Find-SupportedPython
    }
    if ($null -eq $python) {
        throw 'Python 3.11 or later was not found after installation. Install Python 3.11+ and ensure it is available to this account, then rerun.'
    }
    $script:PythonExecutable = $python.Path
    Write-Host "Using Python $($python.Version) at $($python.Path)"
    return $script:PythonExecutable
}

function Get-PipxVersion {
    try {
        $versionText = Invoke-NativeOutput -Executable $script:PythonExecutable `
            -Arguments @('-m', 'pipx', '--version') -FailureMessage 'pipx is not installed for the selected Python.'
        return [version]$versionText
    } catch {
        return $null
    }
}

function Install-Pipx {
    $version = Get-PipxVersion
    if ($null -eq $version -or $version -lt [version]'1.4.0') {
        Write-Host 'Installing pipx for the selected Python...'
        Invoke-NativeCommand -Executable $script:PythonExecutable -Arguments @(
            '-m', 'pip', 'install', '--user', '--upgrade', 'pipx>=1.4.0'
        ) -FailureMessage 'Could not install pipx. Confirm that Python includes pip and that this account can install Python packages.'
        $version = Get-PipxVersion
    }
    if ($null -eq $version -or $version -lt [version]'1.4.0') {
        throw 'pipx 1.4.0 or later is required. Upgrade pipx for the selected Python, then rerun.'
    }
    $scriptsPath = Invoke-NativeOutput -Executable $script:PythonExecutable -Arguments @(
        '-c', "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))"
    ) -FailureMessage 'Could not locate the Python user Scripts directory.'
    $standardScriptsPath = Invoke-NativeOutput -Executable $script:PythonExecutable -Arguments @(
        '-c', "import sysconfig; print(sysconfig.get_path('scripts'))"
    ) -FailureMessage 'Could not locate the Python Scripts directory.'
    $pipxBin = Invoke-NativeOutput -Executable $script:PythonExecutable -Arguments @(
        '-m', 'pipx', 'environment', '--value', 'PIPX_BIN_DIR'
    ) -FailureMessage 'Could not locate the pipx launcher directory.'
    $pathEntries = @()
    foreach ($directory in @($scriptsPath, $standardScriptsPath, $pipxBin)) {
        if (-not [string]::IsNullOrWhiteSpace($directory) -and
            (Test-Path -LiteralPath $directory -PathType Container)) {
            $pathEntries += $directory
        }
    }
    Add-UserPathEntries -Entries $pathEntries
    $pipxLauncher = Get-ApplicationPath -Names @('pipx.exe', 'pipx')
    if ($null -eq $pipxLauncher) {
        throw 'pipx.exe is not available on PATH after pipx installation. Add the selected Python Scripts directory to User PATH and rerun.'
    }
    try {
        $launcherVersion = [version](Invoke-NativeOutput -Executable $pipxLauncher -Arguments @('--version') `
            -FailureMessage "Could not read the pipx launcher version at $pipxLauncher.")
    } catch {
        throw "Could not verify pipx.exe at $pipxLauncher. Remove or upgrade the conflicting launcher on PATH."
    }
    if ($launcherVersion -lt [version]'1.4.0') {
        throw "pipx.exe at $pipxLauncher is version $launcherVersion; version 1.4.0 or later is required. Remove or upgrade the conflicting launcher on PATH."
    }
}

function Get-NodeVersion {
    $node = Get-ApplicationPath -Names @('node.exe', 'node')
    if ($null -eq $node) {
        return $null
    }
    try {
        $text = Invoke-NativeOutput -Executable $node -Arguments @('-p', 'process.versions.node') `
            -FailureMessage 'Could not read the Node.js version.'
        return [version]$text
    } catch {
        return $null
    }
}

function Install-Node {
    $version = Get-NodeVersion
    $npx = Get-ApplicationPath -Names @('npx.cmd')
    if ($null -eq $version -or $version -lt [version]'22.20.0' -or $null -eq $npx) {
        Install-WinGetPackage -PackageId 'OpenJS.NodeJS.LTS'
        $version = Get-NodeVersion
        $npx = Get-ApplicationPath -Names @('npx.cmd')
    }
    if ($null -eq $version -or $version -lt [version]'22.20.0' -or $null -eq $npx) {
        throw 'Node.js 22.20.0 or later with npx.cmd is required. Install the current Node.js LTS release and rerun.'
    }
    $script:NpxExecutable = $npx
    Write-Host "Using Node.js $version and $npx"
}

function Install-SharedSkills {
    $arguments = @('--yes', 'skills', 'add', 'https://github.com/alexandru/skills/tree/v13.3.2', '-g', '-a', 'codex', '-y', '--skill',
        'code-review', 'code-reviewing', 'code-refine', 'code-refinements', 'external-research')
    Invoke-NativeCommand -Executable $script:NpxExecutable -Arguments $arguments `
        -FailureMessage 'Could not install the alexandru shared skills.'

    $arguments = @('--yes', 'skills', 'add', 'https://github.com/mattpocock/skills/tree/v1.3.1', '-g', '-a', 'codex', '-y', '--skill',
        'codebase-design', 'diagnosing-bugs', 'domain-modeling', 'grill-me', 'grill-with-docs', 'grilling',
        'handoff', 'implement', 'improve-codebase-architecture', 'setup-matt-pocock-skills', 'tdd', 'teach', 'to-spec', 'to-tickets')
    Invoke-NativeCommand -Executable $script:NpxExecutable -Arguments $arguments `
        -FailureMessage 'Could not install the mattpocock shared skills.'

    Invoke-NativeCommand -Executable $script:NpxExecutable -Arguments @(
        '--yes', 'skills', 'add', 'https://github.com/humanlayer/skills', '-g', '-a', 'codex', '-y', '--skill', 'show-me'
    ) -FailureMessage 'Could not install the show-me skill.'
}

function Find-LocalSource {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        return $null
    }
    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $deployer = Join-Path $root 'bin\utils\deploy.py'
    if (-not (Test-Path -LiteralPath $deployer -PathType Leaf)) {
        return $null
    }
    $git = Get-GitExecutable
    try {
        $result = Invoke-NativeOutput -Executable $git -Arguments @('-C', $root, 'rev-parse', '--is-inside-work-tree') `
            -FailureMessage 'The local source is not a Git checkout.'
    } catch {
        return $null
    }
    if ($result -ne 'true') {
        return $null
    }
    return $root
}

function Install-CodexConfig {
    if ($env:OS -ne 'Windows_NT') {
        throw 'This installer supports Windows only. On macOS or Linux, run install.sh with Bash.'
    }

    Refresh-ProcessPath
    $null = Get-GitExecutable
    $python = Get-PythonExecutable
    Install-Pipx

    $destinationValue = $env:CODEX_HOME
    $customDestination = -not [string]::IsNullOrWhiteSpace($destinationValue)
    if (-not $customDestination) {
        $destinationValue = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
    }
    try {
        $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($destinationValue)
        $destination = [IO.Path]::GetFullPath($destination)
    } catch {
        throw "CODEX_HOME must resolve to a file-system path: $destinationValue"
    }
    $repository = $env:INSTALL_REPOSITORY
    if ([string]::IsNullOrWhiteSpace($repository)) {
        $repository = 'https://github.com/alexandru/codex-config.git'
    }

    $source = Find-LocalSource
    $sourceKind = 'checkout'
    $staging = $null
    try {
        if ($null -eq $source) {
            $sourceKind = 'download'
            $staging = Join-Path ([IO.Path]::GetTempPath()) ("codex-config-{0}" -f [guid]::NewGuid().ToString('N'))
            Write-Host "Downloading $repository..."
            Invoke-NativeCommand -Executable $script:GitExecutable -Arguments @(
                '-c', 'core.symlinks=false', 'clone', '--quiet', $repository, $staging
            ) -FailureMessage "Could not download $repository. Check the repository URL and network access."
            $source = $staging
        }

        $deployer = Join-Path $source 'bin\utils\deploy.py'
        Invoke-NativeCommand -Executable $python -Arguments @(
            $deployer, '--source', $source, '--source-kind', $sourceKind,
            '--repository', $repository, '--destination', $destination,
            '--directory-variable', 'CODEX_HOME', '--skip-setup'
        ) -FailureMessage "Could not deploy the Codex configuration into $destination."

        $config = Join-Path $destination 'config.toml'
        $agents = Join-Path $destination 'agents'
        if (-not ((Test-Path -LiteralPath $config -PathType Leaf) -and (Test-Path -LiteralPath $agents -PathType Container))) {
            $switcher = Join-Path $destination 'bin\codex-switch.py'
            Invoke-NativeCommand -Executable $python -Arguments @('-m', 'pipx', 'run', $switcher, 'default') `
                -FailureMessage "Could not generate the default Codex configuration in $destination."
        } else {
            Write-Host 'config.toml and agents\ already exist; leaving them untouched.'
        }

        Install-Node
        Install-SharedSkills
        Add-UserPathEntries -Entries @(Join-Path $destination 'bin')
        if ($customDestination) {
            $env:CODEX_HOME = $destination
            Set-UserEnvironmentVariable -Name 'CODEX_HOME' -Value $destination
        }
        Write-Host "Installed Codex configuration into $destination"
    } finally {
        if ($null -ne $staging) {
            Remove-Item -LiteralPath $staging -Force -Recurse -ErrorAction SilentlyContinue
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Install-CodexConfig
    } catch {
        [Console]::Error.WriteLine("Error: {0}", $_.Exception.Message)
        exit 1
    }
}
