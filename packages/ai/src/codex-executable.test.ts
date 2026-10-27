import { Buffer } from 'node:buffer'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'

import {
  createTrustedCodexLaunchCommand,
  resolveTrustedCodexExecutable,
  resolveTrustedWindowsPowerShell,
} from './codex-executable.js'

const OFFICIAL_SUBJECT =
  'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US'
const OFFICIAL_ROOT_SHA256 = '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270'
const WORKSPACE = 'C:\\Users\\candidate\\BossHunter-Next'

describe('trusted Codex executable resolution', () => {
  it('builds an opaque locked-and-reverified system launcher command', async () => {
    const target = 'C:\\Users\\candidate\\AppData\\Local\\OpenAI\\Codex\\codex.exe'
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const resolveRealpath = vi.fn(() => Promise.resolve(powershell))

    const launch = await createTrustedCodexLaunchCommand(target, resolveRealpath)
    const commandIndex = launch.arguments.indexOf('-EncodedCommand')
    const decoded = Buffer.from(launch.arguments[commandIndex + 1] ?? '', 'base64').toString(
      'utf16le',
    )

    expect(launch.launcherPath).toBe(powershell)
    expect(launch.approvalToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(decoded).not.toContain(target)
    expect(decoded).toContain('[IO.FileShare]::Read')
    expect(decoded).toContain('Get-AuthenticodeSignature -LiteralPath $fullTarget')
    expect(decoded).toContain('[BossHunterJobGuard]::ProtectCurrentProcess()')
    expect(decoded).toContain('[BossHunterJobGuard]::LockPathChain($fullTarget)')
    expect(decoded).toContain('[BossHunterJobGuard]::ReadControlLine($parentInput)')
    expect(decoded).toContain('[BossHunterJobGuard]::Proxy(')
    expect(decoded).not.toContain('[Console]::In.ReadLine()')
    const encodedGuard = decoded.match(
      /\$jobBytes = \[Convert\]::FromBase64String\('([^']+)'\)/u,
    )?.[1]
    expect(encodedGuard).toBeTypeOf('string')
    const guardSource = gunzipSync(Buffer.from(encodedGuard ?? '', 'base64')).toString('utf8')
    const businessPump = guardSource.match(
      /private static void PumpParentInput[\s\S]+?public static bool IsProtected/u,
    )?.[0]
    expect(businessPump).toContain('input.Read(buffer, 0, buffer.Length)')
    expect(businessPump).not.toContain('input.ReadByte()')
    expect(launch.arguments.join(' ').length).toBeLessThan(30_000)
    expect(decoded).toContain('$startInfo.UseShellExecute = $false')
    expect(resolveRealpath).toHaveBeenCalledWith(
      '\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  it('resolves PowerShell through the kernel SystemRoot namespace, not environment variables', async () => {
    const canonical = 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const resolveRealpath = vi.fn(() => Promise.resolve(canonical))

    await expect(resolveTrustedWindowsPowerShell(resolveRealpath)).resolves.toBe(canonical)
    expect(resolveRealpath).toHaveBeenCalledWith(
      '\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  it('rejects a kernel-path resolution that does not end at system PowerShell', async () => {
    await expect(
      resolveTrustedWindowsPowerShell(() =>
        Promise.resolve('D:\\Users\\candidate\\powershell.exe'),
      ),
    ).rejects.toThrow('PowerShell path is not trustworthy')
  })

  it('skips a malicious first PATH candidate and selects the later official binary', async () => {
    const malicious = 'C:\\Tools\\spoof\\codex.exe'
    const official = 'C:\\Users\\candidate\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe'
    const inspect = vi.fn((path: string) =>
      Promise.resolve(
        path === malicious
          ? {
              status: 'Valid',
              signerSubject: 'CN=OpenAI OpCo, LLC Malware, O=Malware Corp',
              chainRootSha256: OFFICIAL_ROOT_SHA256,
            }
          : {
              status: 'Valid',
              signerSubject: OFFICIAL_SUBJECT,
              chainRootSha256: OFFICIAL_ROOT_SHA256,
            },
      ),
    )

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32' },
        createWindowsOverrides({
          pathValue: 'C:\\Tools\\spoof;C:\\Users\\candidate\\AppData\\Local\\OpenAI\\Codex\\bin',
          resolvedPaths: new Map([
            ['C:\\Tools\\spoof\\codex.exe', malicious],
            ['C:\\Users\\candidate\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe', official],
          ]),
          inspect,
        }),
      ),
    ).resolves.toBe(official)
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('fails closed when no candidate has a valid official signature', async () => {
    const unsigned = 'C:\\Tools\\unsigned\\codex.exe'

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32' },
        createWindowsOverrides({
          pathValue: 'C:\\Tools\\unsigned',
          resolvedPaths: new Map([['C:\\Tools\\unsigned\\codex.exe', unsigned]]),
          inspect: () =>
            Promise.resolve({
              status: 'NotSigned',
              signerSubject: null,
              chainRootSha256: null,
            }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      message: '未找到签名有效且发布者为 OpenAI OpCo, LLC 的 Codex 原生程序',
    })
  })

  it('accepts a valid OpenAI OpCo, LLC Authenticode signer', async () => {
    const official = 'C:\\Program Files\\OpenAI\\Codex\\codex.exe'

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32' },
        createWindowsOverrides({
          pathValue: 'C:\\Program Files\\OpenAI\\Codex',
          resolvedPaths: new Map([['C:\\Program Files\\OpenAI\\Codex\\codex.exe', official]]),
          inspect: () =>
            Promise.resolve({
              status: 'Valid',
              signerSubject: OFFICIAL_SUBJECT,
              chainRootSha256: OFFICIAL_ROOT_SHA256,
            }),
        }),
      ),
    ).resolves.toBe(official)
  })

  it('rejects a same-subject certificate chained to an unpinned user root', async () => {
    const forged = 'C:\\Tools\\forged\\codex.exe'

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32', explicitPath: forged },
        createWindowsOverrides({
          resolvedPaths: new Map([[forged, forged]]),
          inspect: () =>
            Promise.resolve({
              status: 'Valid',
              signerSubject: OFFICIAL_SUBJECT,
              chainRootSha256: 'A'.repeat(64),
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
  })

  it('verifies and rejects an explicitly configured malicious executable', async () => {
    const malicious = 'C:\\Users\\candidate\\Downloads\\codex.exe'
    const inspect = vi.fn(() =>
      Promise.resolve({
        status: 'Valid',
        signerSubject: 'CN="OpenAI OpCo, LLC Support", O="Unknown Publisher"',
        chainRootSha256: OFFICIAL_ROOT_SHA256,
      }),
    )

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32', explicitPath: malicious },
        createWindowsOverrides({
          resolvedPaths: new Map([[malicious, malicious]]),
          inspect,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(inspect).toHaveBeenCalledWith(malicious)
  })

  it('continues after a signature command error and can use a later official candidate', async () => {
    const broken = 'C:\\Tools\\broken\\codex.exe'
    const official = 'C:\\Program Files\\OpenAI\\Codex\\codex.exe'
    const inspect = vi.fn((path: string) => {
      if (path === broken)
        return Promise.reject(new Error('PowerShell output contained a user path'))
      return Promise.resolve({
        status: 'Valid',
        signerSubject: OFFICIAL_SUBJECT,
        chainRootSha256: OFFICIAL_ROOT_SHA256,
      })
    })

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32' },
        createWindowsOverrides({
          pathValue: 'C:\\Tools\\broken;C:\\Program Files\\OpenAI\\Codex',
          resolvedPaths: new Map([
            ['C:\\Tools\\broken\\codex.exe', broken],
            ['C:\\Program Files\\OpenAI\\Codex\\codex.exe', official],
          ]),
          inspect,
        }),
      ),
    ).resolves.toBe(official)
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('turns signature command failure into a generic error without leaking a local account path', async () => {
    const accountPath = 'C:\\Users\\private-account-name\\AppData\\Local\\codex.exe'

    const promise = resolveTrustedCodexExecutable(
      { platform: 'win32', explicitPath: accountPath },
      createWindowsOverrides({
        resolvedPaths: new Map([[accountPath, accountPath]]),
        inspect: () => Promise.reject(new Error(`command failed for ${accountPath}`)),
      }),
    )
    await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    await expect(promise).rejects.not.toThrow('private-account-name')
  })

  it('rejects relative and current-workspace paths before signature inspection', async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({
        status: 'Valid',
        signerSubject: OFFICIAL_SUBJECT,
        chainRootSha256: OFFICIAL_ROOT_SHA256,
      }),
    )
    const workspaceCandidate = `${WORKSPACE}\\tools\\codex.exe`

    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32', explicitPath: '.\\codex.exe' },
        createWindowsOverrides({ inspect }),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    await expect(
      resolveTrustedCodexExecutable(
        { platform: 'win32', explicitPath: workspaceCandidate },
        createWindowsOverrides({
          resolvedPaths: new Map([[workspaceCandidate, workspaceCandidate]]),
          inspect,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('resolves an absolute non-Windows candidate but fails closed without publisher verification', async () => {
    const officialLooking = '/opt/openai/bin/codex'

    try {
      await resolveTrustedCodexExecutable(
        { platform: 'linux', explicitPath: officialLooking },
        {
          cwd: '/home/candidate/workspace',
          realpath: (path) => Promise.resolve(path),
        },
      )
      expect.fail('non-Windows resolution must fail closed')
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) expect(error.message).toContain('只能在 Windows 上验证')
    }
  })
})

function createWindowsOverrides(options: {
  pathValue?: string
  resolvedPaths?: ReadonlyMap<string, string>
  inspect?: (
    path: string,
  ) => Promise<{ status: string; signerSubject: string | null; chainRootSha256: string | null }>
}): {
  cwd: string
  pathValue?: string
  realpath: (path: string) => Promise<string>
  verifier?: {
    inspect(path: string): Promise<{
      status: string
      signerSubject: string | null
      chainRootSha256: string | null
    }>
  }
} {
  const resolvedPaths = options.resolvedPaths ?? new Map<string, string>()
  return {
    cwd: WORKSPACE,
    ...(options.pathValue === undefined ? {} : { pathValue: options.pathValue }),
    realpath(path) {
      if (path === WORKSPACE) return Promise.resolve(WORKSPACE)
      const resolved = resolvedPaths.get(path)
      return resolved === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(resolved)
    },
    ...(options.inspect === undefined ? {} : { verifier: { inspect: options.inspect } }),
  }
}
