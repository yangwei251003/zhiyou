import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { posix, win32, type PlatformPath } from 'node:path'
import { gzipSync } from 'node:zlib'

import { AiProviderError } from './types.js'

const TRUSTED_PUBLISHER = 'OpenAI OpCo, LLC'
const TRUSTED_CHAIN_ROOT_SHA256 = '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270'
const SIGNATURE_TIMEOUT_MS = 15_000
const WINDOWS_POWERSHELL_SYSTEM_ROOT_PATH =
  '\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export interface SignatureInspection {
  status: string
  signerSubject: string | null
  chainRootSha256: string | null
}

export interface TrustedCodexLaunchCommand {
  launcherPath: string
  arguments: string[]
  approvalToken: string
}

interface CodexExecutableVerifier {
  inspect(executablePath: string): Promise<SignatureInspection>
}

interface ResolutionRequest {
  platform: NodeJS.Platform
  explicitPath?: string
}

/**
 * Test seams are deliberately kept in this non-exported package subpath. The
 * production runtime never supplies them and there is no environment-variable
 * bypass for executable verification.
 */
interface TestOnlyResolutionOverrides {
  cwd?: string
  pathValue?: string
  realpath?: (path: string) => Promise<string>
  verifier?: CodexExecutableVerifier
}

export async function resolveTrustedCodexExecutable(
  request: ResolutionRequest,
  testOnlyOverrides: TestOnlyResolutionOverrides = {},
): Promise<string> {
  const pathApi = pathForPlatform(request.platform)
  const resolveRealpath = testOnlyOverrides.realpath ?? realpath
  const cwd = await resolveCurrentDirectory(
    testOnlyOverrides.cwd ?? process.cwd(),
    pathApi,
    resolveRealpath,
  )
  const candidates =
    request.explicitPath === undefined
      ? discoverPathCandidates(
          testOnlyOverrides.pathValue ?? process.env['PATH'] ?? '',
          request.platform,
        )
      : [request.explicitPath]

  if (candidates.length === 0) {
    throw new AiProviderError('OFFLINE', '未找到可验证的 Codex，请先安装或打开 Codex 桌面应用')
  }

  const resolvedCandidates = await resolveCandidates(
    candidates,
    cwd,
    request.platform,
    pathApi,
    resolveRealpath,
  )
  if (resolvedCandidates.length === 0) {
    throw new AiProviderError(
      'PROTOCOL_INCOMPATIBLE',
      '没有找到位于受信目录中的 Codex 原生程序；已拒绝相对路径和当前项目目录中的同名程序',
    )
  }

  if (request.platform !== 'win32') {
    throw new AiProviderError(
      'PROTOCOL_INCOMPATIBLE',
      '当前私测版只能在 Windows 上验证 Codex 官方发布者；其他系统为避免运行冒名程序已安全停止',
    )
  }

  const verifier =
    testOnlyOverrides.verifier ??
    new WindowsAuthenticodeVerifier(testOnlyOverrides.realpath ?? realpath)
  for (const candidate of resolvedCandidates) {
    try {
      const inspection = await verifier.inspect(candidate)
      if (isTrustedOpenAiSignature(inspection)) return candidate
    } catch {
      // A broken or malicious candidate must not prevent a later official
      // candidate from being considered. Failure details may contain local
      // account paths, so they are intentionally not surfaced.
    }
  }

  throw new AiProviderError(
    'PROTOCOL_INCOMPATIBLE',
    '未找到签名有效且发布者为 OpenAI OpCo, LLC 的 Codex 原生程序',
  )
}

class WindowsAuthenticodeVerifier implements CodexExecutableVerifier {
  constructor(private readonly resolveRealpath: (path: string) => Promise<string>) {}

  async inspect(executablePath: string): Promise<SignatureInspection> {
    const powershellPath = await this.resolvePowerShell()
    const encodedTarget = Buffer.from(executablePath, 'utf8').toString('base64')
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$modulePath = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
      'Import-Module -Name $modulePath -ErrorAction Stop',
      `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))`,
      '$signature = Get-AuthenticodeSignature -LiteralPath $target',
      '$subject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }',
      '$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()',
      '$null = if ($null -eq $signature.SignerCertificate) { $false } else { $chain.Build($signature.SignerCertificate) }',
      // Get-AuthenticodeSignature validates trusted timestamps. Requiring a
      // second chain build to be time-valid "now" would reject a correctly
      // timestamped binary after its leaf signing certificate expires.
      '$rootSha256 = if ($chain.ChainElements.Count -eq 0) { $null } else { $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) }',
      '[pscustomobject]@{ Status = $signature.Status.ToString(); Subject = $subject; RootSha256 = $rootSha256 } | ConvertTo-Json -Compress',
    ].join('; ')
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
    const stdout = await executeFile(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand,
    ])
    const parsed = parseSignatureInspection(stdout)
    if (parsed === null) throw new Error('Codex signature inspection returned invalid data')
    return parsed
  }

  private async resolvePowerShell(): Promise<string> {
    return resolveTrustedWindowsPowerShell(this.resolveRealpath)
  }
}

export async function resolveTrustedWindowsPowerShell(
  resolveRealpath: (path: string) => Promise<string> = realpath,
): Promise<string> {
  // GLOBALROOT\SystemRoot is resolved by the Windows object manager, not from
  // caller-controlled SystemRoot/windir environment variables.
  const resolved = await resolveRealpath(WINDOWS_POWERSHELL_SYSTEM_ROOT_PATH)
  const normalized = win32.normalize(resolved)
  const expectedSuffix = win32.normalize('\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  if (
    !win32.isAbsolute(resolved) ||
    !normalized.toLowerCase().endsWith(expectedSuffix.toLowerCase()) ||
    win32.basename(resolved).toLowerCase() !== 'powershell.exe'
  ) {
    throw new Error('PowerShell path is not trustworthy')
  }
  return resolved
}

/**
 * Builds a Windows-only launcher that re-verifies the selected binary while a
 * deny-write/delete file handle is held. The system PowerShell process remains
 * as a transparent stdio proxy and owns a kill-on-close Job Object, so Node
 * never opens a verified pathname again after the lock is released.
 */
export async function createTrustedCodexLaunchCommand(
  executablePath: string,
  resolveRealpath: (path: string) => Promise<string> = realpath,
): Promise<TrustedCodexLaunchCommand> {
  if (!win32.isAbsolute(executablePath) || win32.extname(executablePath).toLowerCase() !== '.exe') {
    throw new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex 可信启动目标无效')
  }
  let launcherPath: string
  try {
    launcherPath = await resolveTrustedWindowsPowerShell(resolveRealpath)
  } catch {
    throw new AiProviderError('PROTOCOL_INCOMPATIBLE', '无法定位 Windows 系统可信启动组件')
  }
  const approvalToken = randomBytes(32).toString('base64url')
  const encodedTarget = Buffer.from(executablePath, 'utf8').toString('base64')
  const encodedJobGuard = gzipSync(Buffer.from(WINDOWS_JOB_GUARD_SOURCE, 'utf8'), {
    level: 9,
  }).toString('base64')
  const script = buildTrustedLauncherScript(encodedTarget, encodedJobGuard, approvalToken)
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
  return {
    launcherPath,
    approvalToken,
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
  }
}

function discoverPathCandidates(pathValue: string, platform: NodeJS.Platform): string[] {
  const pathApi = pathForPlatform(platform)
  const separator = platform === 'win32' ? ';' : ':'
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex'
  return pathValue
    .split(separator)
    .map((entry) => stripSurroundingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0 && pathApi.isAbsolute(entry))
    .map((entry) => pathApi.join(entry, executableName))
}

async function resolveCurrentDirectory(
  cwd: string,
  pathApi: PlatformPath,
  resolveRealpath: (path: string) => Promise<string>,
): Promise<string> {
  if (!pathApi.isAbsolute(cwd)) {
    throw new AiProviderError('INTERNAL', '当前工作目录不是绝对路径，无法安全查找 Codex')
  }
  try {
    const resolved = await resolveRealpath(cwd)
    if (!pathApi.isAbsolute(resolved)) throw new Error('relative realpath')
    return resolved
  } catch {
    throw new AiProviderError('INTERNAL', '无法验证当前工作目录，已停止查找 Codex')
  }
}

async function resolveCandidates(
  candidates: readonly string[],
  cwd: string,
  platform: NodeJS.Platform,
  pathApi: PlatformPath,
  resolveRealpath: (path: string) => Promise<string>,
): Promise<string[]> {
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!pathApi.isAbsolute(candidate)) continue
    if (platform === 'win32' && pathApi.extname(candidate).toLowerCase() !== '.exe') continue
    try {
      const canonicalPath = await resolveRealpath(candidate)
      if (!pathApi.isAbsolute(canonicalPath) || isWithinDirectory(canonicalPath, cwd, pathApi)) {
        continue
      }
      if (platform === 'win32' && pathApi.extname(canonicalPath).toLowerCase() !== '.exe') continue
      const key = platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push(canonicalPath)
    } catch {
      // Missing, inaccessible, or unstable PATH entries are not executable
      // candidates. Continue so a later official installation can be used.
    }
  }
  return resolved
}

function isWithinDirectory(candidate: string, directory: string, pathApi: PlatformPath): boolean {
  const relative = pathApi.relative(directory, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
  )
}

export function isTrustedOpenAiSignature(inspection: SignatureInspection): boolean {
  if (
    inspection.status !== 'Valid' ||
    inspection.signerSubject === null ||
    inspection.chainRootSha256?.toUpperCase() !== TRUSTED_CHAIN_ROOT_SHA256
  ) {
    return false
  }
  const fields = parseDistinguishedName(inspection.signerSubject)
  return (
    fields.get('CN')?.includes(TRUSTED_PUBLISHER) === true &&
    fields.get('O')?.includes(TRUSTED_PUBLISHER) === true
  )
}

function buildTrustedLauncherScript(
  encodedTarget: string,
  encodedJobGuard: string,
  approvalToken: string,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    `  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))`,
    `  $approvalToken = '${approvalToken}'`,
    `  $jobBytes = [Convert]::FromBase64String('${encodedJobGuard}')`,
    '  $jobMemory = [IO.MemoryStream]::new($jobBytes)',
    '  $jobGzip = [IO.Compression.GzipStream]::new($jobMemory, [IO.Compression.CompressionMode]::Decompress)',
    '  $jobReader = [IO.StreamReader]::new($jobGzip, [Text.Encoding]::UTF8)',
    '  $jobSource = $jobReader.ReadToEnd()',
    '  $jobReader.Dispose()',
    '  $null = Add-Type -TypeDefinition $jobSource -Language CSharp',
    '  [BossHunterJobGuard]::ProtectCurrentProcess()',
    '  $parentInput = [Console]::OpenStandardInput()',
    "  $modulePath = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
    '  Import-Module -Name $modulePath -ErrorAction Stop',
    '  $fullTarget = [IO.Path]::GetFullPath($target)',
    "  if ($target.StartsWith('\\\\', [StringComparison]::Ordinal) -or $target.Substring(2).Contains(':')) { throw [InvalidOperationException]::new() }",
    '  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fullTarget))',
    '  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw [InvalidOperationException]::new() }',
    '  $pathLock = [BossHunterJobGuard]::LockPathChain($fullTarget)',
    '  try {',
    '    $fileLock = [IO.File]::Open($fullTarget, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    '    try {',
    '    $targetAttributes = [IO.File]::GetAttributes($fullTarget)',
    '    if (($targetAttributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($targetAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new() }',
    '    $signature = Get-AuthenticodeSignature -LiteralPath $fullTarget',
    '    $subject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }',
    '    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()',
    '    $null = if ($null -eq $signature.SignerCertificate) { $false } else { $chain.Build($signature.SignerCertificate) }',
    '    $rootSha256 = if ($chain.ChainElements.Count -eq 0) { $null } else { $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) }',
    '    $identityCheck = [IO.File]::Open($fullTarget, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    '    try {',
    '      if (-not [BossHunterJobGuard]::SameFile($fileLock.SafeFileHandle, $identityCheck.SafeFileHandle)) { throw [InvalidOperationException]::new() }',
    '    } finally {',
    '      $identityCheck.Dispose()',
    '    }',
    "    $attestation = [pscustomobject]@{ Protocol = 'bosshunter.trusted-launch.v1'; Status = $signature.Status.ToString(); Subject = $subject; RootSha256 = $rootSha256 } | ConvertTo-Json -Compress",
    '    [Console]::Out.WriteLine($attestation)',
    '    [Console]::Out.Flush()',
    '    $approval = [BossHunterJobGuard]::ReadControlLine($parentInput)',
    '    if (-not [string]::Equals($approval, $approvalToken, [StringComparison]::Ordinal)) { throw [InvalidOperationException]::new() }',
    '    $startInfo = [Diagnostics.ProcessStartInfo]::new()',
    '    $startInfo.FileName = $fullTarget',
    "    $startInfo.Arguments = 'app-server --stdio'",
    '    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($fullTarget)',
    '    $startInfo.UseShellExecute = $false',
    '    $startInfo.CreateNoWindow = $true',
    '    $startInfo.RedirectStandardInput = $true',
    '    $startInfo.RedirectStandardOutput = $true',
    '    $startInfo.RedirectStandardError = $true',
    '    $systemDirectory = [Environment]::SystemDirectory',
    '    $windowsDirectory = [IO.Directory]::GetParent($systemDirectory).FullName',
    "    $startInfo.EnvironmentVariables['PATH'] = $startInfo.WorkingDirectory + ';' + $systemDirectory + ';' + $windowsDirectory",
    "    $startInfo.EnvironmentVariables['PATHEXT'] = '.COM;.EXE'",
    "    $startInfo.EnvironmentVariables['COMSPEC'] = [IO.Path]::Combine($systemDirectory, 'cmd.exe')",
    "    $startInfo.EnvironmentVariables['SystemRoot'] = $windowsDirectory",
    "    $startInfo.EnvironmentVariables['windir'] = $windowsDirectory",
    '    $codexProcess = [Diagnostics.Process]::new()',
    '    $codexProcess.StartInfo = $startInfo',
    '    if (-not $codexProcess.Start()) { throw [InvalidOperationException]::new() }',
    '    if (-not [BossHunterJobGuard]::IsProtected($codexProcess.Handle)) { $codexProcess.Kill(); throw [InvalidOperationException]::new() }',
    '    } finally {',
    '      $fileLock.Dispose()',
    '    }',
    '  } finally {',
    '    $pathLock.Dispose()',
    '  }',
    "  $ready = [pscustomobject]@{ Protocol = 'bosshunter.trusted-launch.v1'; Ready = $true } | ConvertTo-Json -Compress",
    '  [Console]::Out.WriteLine($ready)',
    '  [Console]::Out.Flush()',
    '  $proxyApproval = [BossHunterJobGuard]::ReadControlLine($parentInput)',
    "  if (-not [string]::Equals($proxyApproval, $approvalToken + ':proxy', [StringComparison]::Ordinal)) { throw [InvalidOperationException]::new() }",
    "  $proxyReady = [pscustomobject]@{ Protocol = 'bosshunter.trusted-launch.v1'; ProxyReady = $true } | ConvertTo-Json -Compress",
    '  [Console]::Out.WriteLine($proxyReady)',
    '  [Console]::Out.Flush()',
    '  $exitCode = [BossHunterJobGuard]::Proxy($parentInput, [Console]::OpenStandardOutput(), [Console]::OpenStandardError(), $codexProcess)',
    '  $codexProcess.Dispose()',
    '  exit $exitCode',
    '} catch {',
    "  [Console]::Error.WriteLine('BossHunter trusted Codex launcher failed')",
    '  exit 70',
    '}',
  ].join('\r\n')
}

const WINDOWS_JOB_GUARD_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class BossHunterPathLock : IDisposable
{
    private List<SafeFileHandle> handles;

    internal BossHunterPathLock(List<SafeFileHandle> handles)
    {
        this.handles = handles;
    }

    public void Dispose()
    {
        if (handles == null) return;
        for (int index = handles.Count - 1; index >= 0; index--)
            handles[index].Dispose();
        handles = null;
    }
}

public static class BossHunterJobGuard
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private static IntPtr jobHandle = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void ProtectCurrentProcess()
    {
        if (jobHandle != IntPtr.Zero) return;
        IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
        if (candidate == IntPtr.Zero || candidate == new IntPtr(-1))
            throw new InvalidOperationException();

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!SetHandleInformation(candidate, HANDLE_FLAG_INHERIT, 0))
                throw new InvalidOperationException();
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(candidate, 9, buffer, (uint)length))
                throw new InvalidOperationException();
            if (!AssignProcessToJobObject(candidate, GetCurrentProcess()))
                throw new InvalidOperationException();
            jobHandle = candidate;
            candidate = IntPtr.Zero;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            if (candidate != IntPtr.Zero) CloseHandle(candidate);
        }
    }

    public static bool SameFile(SafeFileHandle left, SafeFileHandle right)
    {
        BY_HANDLE_FILE_INFORMATION leftInformation;
        BY_HANDLE_FILE_INFORMATION rightInformation;
        if (!GetFileInformationByHandle(left, out leftInformation))
            throw new InvalidOperationException();
        if (!GetFileInformationByHandle(right, out rightInformation))
            throw new InvalidOperationException();
        return leftInformation.VolumeSerialNumber == rightInformation.VolumeSerialNumber
            && leftInformation.FileIndexHigh == rightInformation.FileIndexHigh
            && leftInformation.FileIndexLow == rightInformation.FileIndexLow;
    }

    public static BossHunterPathLock LockPathChain(string target)
    {
        string fullTarget = Path.GetFullPath(target);
        var directories = new Stack<string>();
        DirectoryInfo current = new DirectoryInfo(Path.GetDirectoryName(fullTarget));
        while (current != null)
        {
            directories.Push(current.FullName);
            current = current.Parent;
        }

        var handles = new List<SafeFileHandle>();
        try
        {
            while (directories.Count > 0)
            {
                SafeFileHandle handle = CreateFile(
                    directories.Pop(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    IntPtr.Zero,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);
                if (handle.IsInvalid) throw new InvalidOperationException();

                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(handle, out information)
                    || (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
                    || (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                {
                    handle.Dispose();
                    throw new InvalidOperationException();
                }
                handles.Add(handle);
            }
            return new BossHunterPathLock(handles);
        }
        catch
        {
            for (int index = handles.Count - 1; index >= 0; index--)
                handles[index].Dispose();
            throw;
        }
    }

    public static string ReadControlLine(Stream input)
    {
        using (var bytes = new MemoryStream())
        {
            for (int index = 0; index < 4096; index++)
            {
                int value = input.ReadByte();
                if (value < 0) throw new InvalidOperationException();
                if (value == 10)
                {
                    byte[] line = bytes.ToArray();
                    int length = line.Length;
                    if (length > 0 && line[length - 1] == 13) length--;
                    return new UTF8Encoding(false, true).GetString(line, 0, length);
                }
                bytes.WriteByte((byte)value);
            }
        }
        throw new InvalidOperationException();
    }

    public static void TerminateForParentLoss()
    {
        if (jobHandle == IntPtr.Zero || !TerminateJobObject(jobHandle, 71))
            throw new InvalidOperationException();
        Environment.Exit(71);
    }

    public static int Proxy(Stream parentInput, Stream parentOutput, Stream parentError, Process child)
    {
        Task outputCopy = Task.Run((Action)(() => child.StandardOutput.BaseStream.CopyTo(parentOutput)));
        Task errorCopy = Task.Run((Action)(() => child.StandardError.BaseStream.CopyTo(parentError)));
        child.EnableRaisingEvents = true;
        child.Exited += (sender, eventArgs) =>
        {
            Task.WaitAll(new Task[] { outputCopy, errorCopy }, 1000);
            Environment.Exit(child.ExitCode);
        };
        PumpParentInput(parentInput, child.StandardInput.BaseStream);
        child.StandardInput.Close();
        if (!child.HasExited) TerminateForParentLoss();
        return child.ExitCode;
    }

    private static void PumpParentInput(Stream input, Stream output)
    {
        byte[] buffer = new byte[4096];
        while (true)
        {
            int count = input.Read(buffer, 0, buffer.Length);
            if (count <= 0) break;
            output.Write(buffer, 0, count);
            output.Flush();
        }
    }

    public static bool IsProtected(IntPtr process)
    {
        if (jobHandle == IntPtr.Zero) return false;
        bool result;
        if (!IsProcessInJob(process, jobHandle, out result))
            throw new InvalidOperationException();
        return result;
    }
}
`

function parseSignatureInspection(stdout: string): SignatureInspection | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown
    if (!isRecord(value)) return null
    const status = value['Status']
    const subject = value['Subject']
    const rootSha256 = value['RootSha256']
    if (
      typeof status !== 'string' ||
      (typeof subject !== 'string' && subject !== null) ||
      (typeof rootSha256 !== 'string' && rootSha256 !== null)
    ) {
      return null
    }
    return { status, signerSubject: subject, chainRootSha256: rootSha256 }
  } catch {
    return null
  }
}

function parseDistinguishedName(subject: string): Map<string, string[]> {
  const fields = new Map<string, string[]>()
  for (const component of splitDistinguishedName(subject)) {
    const separator = component.indexOf('=')
    if (separator <= 0) continue
    const key = component.slice(0, separator).trim().toUpperCase()
    const value = unquoteDnValue(component.slice(separator + 1).trim())
    const existing = fields.get(key) ?? []
    existing.push(value)
    fields.set(key, existing)
  }
  return fields
}

function splitDistinguishedName(subject: string): string[] {
  const components: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const character of subject) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === ',' && !quoted) {
      components.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  components.push(current.trim())
  return components.filter(Boolean)
}

function unquoteDnValue(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

function stripSurroundingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

function pathForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function executeFile(executablePath: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      [...arguments_],
      {
        windowsHide: true,
        timeout: SIGNATURE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error('Codex signature inspection command failed'))
          return
        }
        resolve(stdout)
      },
    )
  })
}
