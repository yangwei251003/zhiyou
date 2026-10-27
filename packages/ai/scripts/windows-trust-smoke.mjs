import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SYSTEM_POWERSHELL =
  '\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

if (process.platform !== 'win32') throw new Error('Windows trust smoke is Windows-only')

if (process.argv.includes('--child')) {
  const { CodexAppServerRuntime } = await import('../dist/index.js')
  const runtime = new CodexAppServerRuntime({
    requestTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  })
  const account = await runtime.account()
  const status = await account.status()
  const limits = await account.readRateLimits()
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      pid: process.pid,
      availability: status.availability,
      authMode: status.authMode,
      quotaReadable: limits.rateLimits !== undefined,
    })}\n`,
  )
  setInterval(() => undefined, 1_000)
} else {
  await runParentProbe()
}

async function runParentProbe() {
  const { spawn } = await import('node:child_process')
  const throughput = await verifyBusinessPumpThroughput(spawn)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let childError = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    childError = `${childError}${chunk}`.slice(-4_096)
  })

  const ready = await readJsonLine(child.stdout, child, 45_000)
  if (
    ready.type !== 'ready' ||
    ready.availability !== 'ready' ||
    ready.authMode !== 'chatgpt' ||
    ready.quotaReadable !== true ||
    typeof ready.pid !== 'number'
  ) {
    child.kill()
    throw new Error('Trusted launcher account readiness probe failed')
  }

  const descendants = await readDescendants(ready.pid)
  const expectedNames = new Set(descendants.map((entry) => entry.name.toLowerCase()))
  if (!expectedNames.has('powershell.exe') || !expectedNames.has('codex.exe')) {
    child.kill()
    throw new Error('Trusted launcher process tree was incomplete')
  }

  const exitPromise = once(child, 'exit')
  if (!child.kill()) throw new Error('Trusted launcher smoke parent could not be terminated')
  await exitPromise
  await delay(1_000)
  const remaining = descendants.filter((entry) => isProcessAlive(entry.pid))
  if (remaining.length > 0) {
    throw new Error('Trusted launcher process tree survived its parent')
  }

  process.stdout.write(
    `${JSON.stringify({
      accountReady: true,
      quotaReadable: true,
      generationRequested: false,
      descendantCount: descendants.length,
      remainingAfterParentExit: 0,
      stderrEmpty: childError.length === 0,
      proxyPayloadBytes: throughput.payloadBytes,
      proxyTransferMs: throughput.transferMs,
      proxyHashMatched: true,
    })}\n`,
  )
}

async function verifyBusinessPumpThroughput(spawn) {
  const { createTrustedCodexLaunchCommand } = await import('../dist/codex-executable.js')
  const powershell = await realpath(SYSTEM_POWERSHELL)
  const launch = await createTrustedCodexLaunchCommand('C:\\Windows\\System32\\notepad.exe', () =>
    Promise.resolve(powershell),
  )
  const commandIndex = launch.arguments.indexOf('-EncodedCommand')
  const trustedScript = Buffer.from(launch.arguments[commandIndex + 1] ?? '', 'base64').toString(
    'utf16le',
  )
  const encodedGuard = trustedScript.match(
    /\$jobBytes = \[Convert\]::FromBase64String\('([^']+)'\)/u,
  )?.[1]
  if (encodedGuard === undefined) throw new Error('Trusted launcher guard source was unavailable')

  const harness = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$WarningPreference = 'SilentlyContinue'",
    "$InformationPreference = 'SilentlyContinue'",
    "$VerbosePreference = 'SilentlyContinue'",
    `$jobBytes = [Convert]::FromBase64String('${encodedGuard}')`,
    '$jobMemory = [IO.MemoryStream]::new($jobBytes)',
    '$jobGzip = [IO.Compression.GzipStream]::new($jobMemory, [IO.Compression.CompressionMode]::Decompress)',
    '$jobReader = [IO.StreamReader]::new($jobGzip, [Text.Encoding]::UTF8)',
    '$jobSource = $jobReader.ReadToEnd()',
    '$jobReader.Dispose()',
    '$null = Add-Type -TypeDefinition $jobSource -Language CSharp',
    '$flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static',
    "$pump = [BossHunterJobGuard].GetMethod('PumpParentInput', $flags)",
    'if ($null -eq $pump) { throw [InvalidOperationException]::new() }',
    '$inputStream = [Console]::OpenStandardInput()',
    '$outputStream = [Console]::OpenStandardOutput()',
    '$null = $pump.Invoke($null, [object[]]@($inputStream, $outputStream))',
  ].join('\r\n')
  const encodedHarness = Buffer.from(harness, 'utf16le').toString('base64')
  const payload = Buffer.from(`{"payload":"${'x'.repeat(10 * 1024 * 1024)}"}\n`)
  const expectedHash = sha256(payload)
  const startedAt = performance.now()
  const probe = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedHarness],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const stdoutChunks = []
  let stderr = ''
  probe.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
  probe.stderr.setEncoding('utf8')
  probe.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096)
  })
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      probe.kill()
      reject(new Error('Trusted business pump throughput probe timed out'))
    }, 10_000)
    probe.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Trusted business pump throughput probe failed'))
    })
    probe.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('Trusted business pump throughput probe failed'))
    })
  })
  probe.stdin.end(payload)
  await completed
  const transferMs = Math.round(performance.now() - startedAt)
  const received = Buffer.concat(stdoutChunks)
  const receivedHash = sha256(received)
  if (received.length !== payload.length || receivedHash !== expectedHash || stderr.length > 0) {
    throw new Error(
      `Trusted business pump changed the payload (${JSON.stringify({
        expectedBytes: payload.length,
        receivedBytes: received.length,
        hashMatched: receivedHash === expectedHash,
        stderrEmpty: stderr.length === 0,
      })})`,
    )
  }
  if (transferMs > 5_000) throw new Error('Trusted business pump exceeded its performance gate')
  return { payloadBytes: payload.length, transferMs }
}

async function readDescendants(rootPid) {
  const powershell = await realpath(SYSTEM_POWERSHELL)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${rootPid}`,
    '$all = @(Get-CimInstance Win32_Process)',
    '$pending = [Collections.Generic.Queue[uint32]]::new()',
    '$pending.Enqueue([uint32]$rootPid)',
    '$result = [Collections.Generic.List[object]]::new()',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending.Dequeue()',
    '  foreach ($item in $all | Where-Object { $_.ParentProcessId -eq $parent }) {',
    '    $result.Add([pscustomobject]@{ pid = [int]$item.ProcessId; name = [string]$item.Name })',
    '    $pending.Enqueue([uint32]$item.ProcessId)',
    '  }',
    '}',
    '$result | ConvertTo-Json -Compress',
  ].join('\r\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const stdout = await executeFile(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ])
  const parsed = JSON.parse(stdout.trim())
  const entries = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
  return entries.map((entry) => ({ pid: Number(entry.pid), name: String(entry.name) }))
}

function readJsonLine(input, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    let settled = false
    const finish = (operation) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      operation()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Trusted launcher smoke timed out')))
    }, timeoutMs)
    lines.once('line', (line) => {
      finish(() => resolve(JSON.parse(line)))
    })
    child.once('exit', (code) => {
      finish(() => reject(new Error(`Trusted launcher child exited before readiness (${code})`)))
    })
  })
}

function executeFile(executable, arguments_) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      { windowsHide: true, shell: false, encoding: 'utf8', timeout: 15_000 },
      (error, stdout) => {
        if (error) reject(new Error('Windows process-tree inspection failed'))
        else resolve(stdout)
      },
    )
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
