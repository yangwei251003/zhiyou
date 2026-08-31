import { EventEmitter } from 'node:events'

import { handleParseWorkerRequest, type ParseWorkerRequest } from '@bosshunter/ingest'
import type { UtilityProcess } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { IngestWorkerExecutor, parseDocumentInWorker } from './ingestWorkerClient'

class FakeParserProcess extends EventEmitter {
  readonly postMessage = vi.fn<(value: unknown) => void>()
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 1))
    return true
  })
}

function processFactory(process: FakeParserProcess): () => UtilityProcess {
  return () => process as unknown as UtilityProcess
}

describe('isolated ingestion utility-process client', () => {
  it('sends a path-free request and waits for confirmed process exit before returning', async () => {
    const process = new FakeParserProcess()
    process.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) => {
        process.emit('message', response)
      })
    })

    const document = await parseDocumentInWorker(
      { fileName: 'resume.txt', bytes: new TextEncoder().encode('real evidence') },
      { requestId: 'worker-success', processFactory: processFactory(process) },
    )

    expect(document.fragments[0]?.content).toBe('real evidence')
    const request = process.postMessage.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      requestId: 'worker-success',
      type: 'parse_document',
      document: { safeFileName: 'resume.txt' },
    })
    expect(request).not.toHaveProperty('sourcePath')
    expect((request as ParseWorkerRequest).document.bytes).toBeInstanceOf(ArrayBuffer)
    expect(process.kill).toHaveBeenCalledTimes(1)
  })

  it('preserves explicit parser failures across the process boundary', async () => {
    const process = new FakeParserProcess()
    process.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) => {
        process.emit('message', response)
      })
    })

    await expect(
      parseDocumentInWorker(
        {
          fileName: 'scan.png',
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
        { requestId: 'worker-ocr', processFactory: processFactory(process) },
      ),
    ).rejects.toMatchObject({ code: 'OCR_REQUIRED' })
  })

  it('terminates a parser that does not answer before the watchdog deadline', async () => {
    const process = new FakeParserProcess()
    await expect(
      parseDocumentInWorker(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { timeoutMs: 5, processFactory: processFactory(process) },
      ),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' })
    expect(process.kill).toHaveBeenCalledTimes(1)
  })

  it('maps a fatal child failure and abnormal exit to deterministic resource failures', async () => {
    const fatalProcess = new FakeParserProcess()
    fatalProcess.postMessage.mockImplementation(() => {
      queueMicrotask(() => fatalProcess.emit('error', 'FatalError', 'parser', 'heap exhausted'))
    })
    await expect(
      parseDocumentInWorker(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { processFactory: processFactory(fatalProcess) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })

    const exitedProcess = new FakeParserProcess()
    exitedProcess.postMessage.mockImplementation(() => {
      queueMicrotask(() => exitedProcess.emit('exit', 137))
    })
    await expect(
      parseDocumentInWorker(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { processFactory: processFactory(exitedProcess) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    expect(exitedProcess.kill).not.toHaveBeenCalled()
  })

  it('fails closed on a mismatched response envelope', async () => {
    const process = new FakeParserProcess()
    process.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        process.emit('message', {
          protocolVersion: 1,
          type: 'parse_succeeded',
          requestId: 'wrong-request',
          document: {},
        })
      })
    })
    await expect(
      parseDocumentInWorker(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { requestId: 'expected-request', processFactory: processFactory(process) },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WORKER_MESSAGE' })
    expect(process.kill).toHaveBeenCalledTimes(1)
  })

  it('runs only one parser and does not settle until the previous exit event', async () => {
    const executor = new IngestWorkerExecutor()
    const firstProcess = new FakeParserProcess()
    const secondProcess = new FakeParserProcess()
    firstProcess.kill.mockImplementation(() => true)
    firstProcess.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) =>
        firstProcess.emit('message', response),
      )
    })
    secondProcess.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) =>
        secondProcess.emit('message', response),
      )
    })
    const secondFactory = vi.fn(processFactory(secondProcess))
    const first = executor.parse(
      { fileName: 'first.txt', bytes: new TextEncoder().encode('first') },
      { processFactory: processFactory(firstProcess) },
    )
    const second = executor.parse(
      { fileName: 'second.txt', bytes: new TextEncoder().encode('second') },
      { processFactory: secondFactory },
    )
    let firstSettled = false
    void first.then(
      () => {
        firstSettled = true
      },
      () => {
        firstSettled = true
      },
    )

    await vi.waitFor(() => expect(firstProcess.kill).toHaveBeenCalledTimes(1))
    expect(firstSettled).toBe(false)
    expect(secondFactory).not.toHaveBeenCalled()
    firstProcess.emit('exit', 1)
    await expect(first).resolves.toMatchObject({ fileName: 'first.txt' })
    await expect(second).resolves.toMatchObject({ fileName: 'second.txt' })
    expect(secondFactory).toHaveBeenCalledTimes(1)
  })

  it('poisons the executor when child exit cannot be confirmed', async () => {
    const executor = new IngestWorkerExecutor()
    const process = new FakeParserProcess()
    process.kill.mockImplementation(() => false)
    process.postMessage.mockImplementation(() => {
      queueMicrotask(() => process.emit('message', { invalid: true }))
    })

    await expect(
      executor.parse(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { terminationTimeoutMs: 5, processFactory: processFactory(process) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })

    const replacementFactory = vi.fn(processFactory(new FakeParserProcess()))
    await expect(
      executor.parse(
        { fileName: 'retry.txt', bytes: new TextEncoder().encode('evidence') },
        { processFactory: replacementFactory },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    expect(replacementFactory).not.toHaveBeenCalled()
  })

  it('does not leave a poison timer behind when kill emits exit synchronously', async () => {
    const executor = new IngestWorkerExecutor()
    const firstProcess = new FakeParserProcess()
    firstProcess.kill.mockImplementation(() => {
      firstProcess.emit('exit', 0)
      return true
    })
    firstProcess.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) =>
        firstProcess.emit('message', response),
      )
    })

    await expect(
      executor.parse(
        { fileName: 'first.txt', bytes: new TextEncoder().encode('first') },
        {
          terminationTimeoutMs: 5,
          processFactory: processFactory(firstProcess),
        },
      ),
    ).resolves.toMatchObject({ fileName: 'first.txt' })
    await new Promise((resolve) => setTimeout(resolve, 15))

    const replacement = new FakeParserProcess()
    replacement.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) => replacement.emit('message', response))
    })
    const replacementFactory = vi.fn(processFactory(replacement))
    await expect(
      executor.parse(
        { fileName: 'second.txt', bytes: new TextEncoder().encode('second') },
        { processFactory: replacementFactory },
      ),
    ).resolves.toMatchObject({ fileName: 'second.txt' })
    expect(replacementFactory).toHaveBeenCalledTimes(1)
  })

  it('lets a fatal process event override a provisional success before exit', async () => {
    const executor = new IngestWorkerExecutor()
    const process = new FakeParserProcess()
    process.kill.mockImplementation(() => {
      process.emit('error', 'FatalError', 'parser', 'fatal process state')
      process.emit('exit', 134)
      return true
    })
    process.postMessage.mockImplementation((value) => {
      void handleParseWorkerRequest(value).then((response) => process.emit('message', response))
    })

    await expect(
      executor.parse(
        { fileName: 'resume.txt', bytes: new TextEncoder().encode('evidence') },
        { processFactory: processFactory(process) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
  })
})
