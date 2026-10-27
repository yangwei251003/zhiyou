import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron } from 'playwright'

const appDirectory = resolve(import.meta.dirname, '..')
const executablePath =
  process.env.BOSSHUNTER_PACKAGED_EXE ??
  resolve(appDirectory, 'release/win-unpacked/BossHunter-Next.exe')
const userDataDirectory = await mkdtemp(join(tmpdir(), 'bosshunter-packaged-smoke-'))

let electronApp
try {
  await access(executablePath)
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      BOSSHUNTER_E2E: '1',
      BOSSHUNTER_E2E_USER_DATA_DIR: resolve(userDataDirectory, 'must-be-ignored'),
      BOSSHUNTER_E2E_IMPORT_PATHS: JSON.stringify(['C:/must-not-be-read.txt']),
    },
    timeout: 30_000,
  })

  const processInfo = await electronApp.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    version: app.getVersion(),
  }))
  assert.equal(processInfo.isPackaged, true, 'Smoke test did not launch a packaged application')
  assert.equal(processInfo.version, '0.1.0-alpha.1')
  assert.equal(
    resolve(processInfo.userData).toLocaleLowerCase('en-US'),
    resolve(userDataDirectory).toLocaleLowerCase('en-US'),
    'Packaged smoke test escaped its isolated user-data directory',
  )

  const page = await electronApp.firstWindow()
  page.setDefaultTimeout(12_000)
  await page
    .getByRole('heading', { name: '先建立可信的职业事实，再开始写简历' })
    .waitFor({ state: 'visible' })
  const runtime = await page.evaluate(() => window.bossHunter.runtime.info())
  assert.equal(runtime.appVersion, '0.1.0-alpha.1')
  assert.equal(await page.getByText('内容来自本地演示数据，不代表真实连接状态').count(), 0)

  console.log(
    JSON.stringify({
      passed: true,
      executablePath,
      isPackaged: processInfo.isPackaged,
      appVersion: processInfo.version,
      persistenceMode: runtime.persistenceMode,
      packagedHooksIgnored: true,
    }),
  )
} finally {
  if (electronApp !== undefined) await electronApp.close()
  await rm(userDataDirectory, { recursive: true, force: true })
}
