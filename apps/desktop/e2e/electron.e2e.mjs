// This no-install runner dynamically loads the declared Playwright package or an explicit package path.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const e2eDirectory = dirname(fileURLToPath(import.meta.url))
const appDirectory = resolve(e2eDirectory, '..')
const artifactDirectory = resolve(appDirectory, 'output/playwright')
const require = createRequire(import.meta.url)

async function loadPlaywright() {
  const explicitModulePath = process.env.BOSSHUNTER_PLAYWRIGHT_MODULE
  if (explicitModulePath) {
    return import(pathToFileURL(resolve(explicitModulePath, 'index.mjs')).href)
  }

  try {
    return await import('playwright')
  } catch (error) {
    throw new Error(
      'Playwright is not available. Install the declared desktop dev dependency, or set BOSSHUNTER_PLAYWRIGHT_MODULE to an existing Playwright package directory.',
      { cause: error },
    )
  }
}

function normalizeDiagnostics(lines) {
  return lines
    .join('')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('DevTools listening on'))
    .filter((line) => !line.startsWith('Debugger ending on '))
    .filter((line) => !line.startsWith('For help, see:'))
}

async function sha256File(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

async function sha256Directory(rootDirectory) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile()) files.push(absolutePath)
    }
  }
  await visit(rootDirectory)
  files.sort((left, right) =>
    relative(rootDirectory, left).localeCompare(relative(rootDirectory, right)),
  )
  const hash = createHash('sha256')
  for (const filePath of files) {
    const normalizedPath = relative(rootDirectory, filePath).replaceAll('\\', '/')
    hash.update(normalizedPath)
    hash.update('\0')
    hash.update(await readFile(filePath))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readProductionRendererCsp() {
  const rendererHtml = await readFile(resolve(appDirectory, 'out/renderer/index.html'), 'utf8')
  const cspMeta = rendererHtml.match(
    /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/iu,
  )?.[0]
  assert.ok(cspMeta, '生产 renderer HTML 缺少 Content-Security-Policy meta')

  const csp = cspMeta.match(/\bcontent="([^"]*)"/iu)?.[1]
  assert.ok(csp, '生产 renderer HTML 的 Content-Security-Policy 没有 content')
  return csp
}

function cspDirective(csp, name) {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
  assert.ok(directive, `Content-Security-Policy 缺少 ${name}`)
  return directive
}

function createBoundedInflationProbeDocx() {
  const encode = (value) => new TextEncoder().encode(value)
  const entries = [
    {
      name: '[Content_Types].xml',
      data: encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document2.xml"/></Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      data: encode(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>decoy</w:t></w:r></w:p></w:body></w:document>',
      ),
    },
    {
      name: 'word/document2.xml',
      data: encode(`<w:document>${'x'.repeat(8 * 1024 * 1024)}</w:document>`),
      deflate: true,
      declaredUncompressedBytes: 256,
    },
  ]
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const entry of entries) {
    const name = encode(entry.name)
    const checksum = crc32(entry.data)
    const payload = entry.deflate ? Uint8Array.from(deflateRawSync(entry.data)) : entry.data
    const compressionMethod = entry.deflate ? 8 : 0
    const uncompressedBytes = entry.declaredUncompressedBytes ?? entry.data.byteLength
    const localHeader = new Uint8Array(30)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, compressionMethod, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, payload.byteLength, true)
    localView.setUint32(22, uncompressedBytes, true)
    localView.setUint16(26, name.byteLength, true)
    const localPart = concatBytes([localHeader, name, payload])
    localParts.push(localPart)

    const centralHeader = new Uint8Array(46)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, compressionMethod, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, payload.byteLength, true)
    centralView.setUint32(24, uncompressedBytes, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(42, localOffset, true)
    centralParts.push(concatBytes([centralHeader, name]))
    localOffset += localPart.byteLength
  }
  const centralDirectory = concatBytes(centralParts)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.byteLength, true)
  endView.setUint32(16, localOffset, true)
  return concatBytes([...localParts, centralDirectory, endRecord])
}

function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function crc32(bytes) {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1))
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}

const { _electron: electron } = await loadPlaywright()
const electronExecutable = require('electron')
const userDataDirectory = await mkdtemp(join(tmpdir(), 'bosshunter-next-e2e-'))
let personalUserDataDirectory
const screenshots = []
const completedSteps = []
const consoleErrors = []
const pageErrors = []
const mainDiagnostics = []
let electronApp
let page
let failure
let personalPersistenceMode
let productionRendererCsp

async function runStep(name, action) {
  await action()
  completedSteps.push(name)
}

async function capture(name) {
  const target = resolve(artifactDirectory, name)
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' })
  screenshots.push(target)
}

async function dismissVisibleToasts() {
  const dismissButtons = page.getByRole('button', { name: '关闭通知' })
  while ((await dismissButtons.count()) > 0) await dismissButtons.first().click()
}

async function expectVisible(locator, message) {
  await locator.waitFor({ state: 'visible' })
  assert.equal(await locator.isVisible(), true, message)
}

async function useNavigation(label, heading) {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const control = navigation.getByRole('button', { name: label, exact: true })
  await control.focus()
  assert.equal(
    await control.evaluate((element) => element === document.activeElement),
    true,
    `导航项“${label}”无法通过键盘获取焦点`,
  )
  await page.keyboard.press('Enter')
  await expectVisible(page.getByRole('heading', { name: heading, exact: true }).first())
  assert.equal(await control.getAttribute('aria-current'), 'page')
  assert.equal(
    await page.locator('#main-content').evaluate((element) => element.scrollTop),
    0,
    `切换到“${label}”后没有回到页顶`,
  )
}

await mkdir(artifactDirectory, { recursive: true })
await rm(resolve(artifactDirectory, '99-failure.png'), { force: true })
const fingerprints = {
  algorithm: 'sha256',
  runner: {
    path: 'e2e/electron.e2e.mjs',
    sha256: await sha256File(fileURLToPath(import.meta.url)),
  },
  build: {
    path: 'out',
    sha256: await sha256Directory(resolve(appDirectory, 'out')),
  },
}

try {
  await runStep('生产构建 CSP 禁止渲染层外连', async () => {
    productionRendererCsp = await readProductionRendererCsp()
    assert.equal(cspDirective(productionRendererCsp, 'connect-src'), "connect-src 'none'")
    assert.doesNotMatch(
      productionRendererCsp,
      /(?:localhost|127\.0\.0\.1)/iu,
      '生产 renderer CSP 不得保留开发回环地址',
    )
  })

  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [appDirectory],
    cwd: appDirectory,
    env: {
      ...process.env,
      BOSSHUNTER_E2E: '1',
      BOSSHUNTER_E2E_USER_DATA_DIR: userDataDirectory,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 30_000,
  })

  electronApp.process().stderr?.on('data', (chunk) => mainDiagnostics.push(String(chunk)))

  const observedPages = new WeakSet()
  const observePage = (candidate) => {
    if (observedPages.has(candidate)) return
    observedPages.add(candidate)
    candidate.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    candidate.on('pageerror', (error) => pageErrors.push(error.message))
  }
  electronApp.on('window', observePage)
  page = await electronApp.firstWindow()
  observePage(page)
  page.setDefaultTimeout(12_000)

  await runStep('应用安全启动与预加载桥', async () => {
    await expectVisible(page.getByRole('heading', { name: '先建立可信的职业事实，再开始写简历' }))
    assert.equal(
      await page.evaluate(() => typeof window.bossHunter?.runtime.info),
      'function',
      '严格 preload API 未注入',
    )
    const runtime = await page.evaluate(() => window.bossHunter.runtime.info())
    assert.match(runtime.persistenceMode, /^(encrypted|memory-only)$/u)
    assert.equal(
      await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
      productionRendererCsp,
      'Electron 实际加载的 CSP 与已验收生产 HTML 不一致',
    )
    await capture('01-onboarding-desktop.png')
  })

  await runStep('首次引导三步', async () => {
    await expectVisible(page.getByRole('button', { name: '选择资料' }))
    assert.match(await page.locator('li[aria-current="step"]').textContent(), /导入资料/u)
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expectVisible(page.getByRole('heading', { name: '先核验三条候选事实' }))
    assert.match(await page.locator('li[aria-current="step"]').textContent(), /核验事实/u)
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expectVisible(page.getByRole('heading', { name: '确认 AI 与隐私边界' }))
    assert.match(await page.locator('li[aria-current="step"]').textContent(), /确认边界/u)
    const onboardingCheckboxes = page.getByRole('checkbox')
    assert.equal(await onboardingCheckboxes.nth(0).isChecked(), true)
    assert.equal(await onboardingCheckboxes.nth(1).isChecked(), false)
    await page.getByRole('button', { name: '进入职业证据台' }).click()
  })

  await runStep('进入工作区与桌面布局', async () => {
    await expectVisible(page.getByRole('navigation', { name: '主导航' }))
    await expectVisible(page.getByRole('main', { name: '' }))
    assert.equal(
      await page.getByRole('button', { name: '首页', exact: true }).getAttribute('aria-current'),
      'page',
    )
    await expectVisible(page.getByText('内容来自本地演示数据，不代表真实连接状态'))
    await capture('02-workspace-desktop.png')
  })

  await runStep('键盘遍历主要页面', async () => {
    const destinations = [
      ['职业档案', '职业档案'],
      ['AI 深访', 'AI 深访'],
      ['岗位机会', '岗位机会'],
      ['简历工作室', '简历工作室'],
      ['求职进展', '求职进展'],
      ['HR 收件箱', 'HR 收件箱'],
      ['连接与隐私', '连接与隐私'],
      ['首页', '今天先完成最重要的一步'],
    ]
    for (const [label, heading] of destinations) await useNavigation(label, heading)
  })

  await runStep('简历来源、ATS 预览与导出阻断', async () => {
    await useNavigation('简历工作室', '简历工作室')
    await expectVisible(page.getByRole('heading', { name: '来源检查器' }))
    await page.getByRole('button', { name: '查看来源' }).first().press('Enter')
    await expectVisible(page.getByText(/18 名学生的访谈与可用性测试/u).first())
    await page.getByRole('button', { name: 'ATS 纯文本' }).press('Enter')
    await expectVisible(page.getByLabel('ATS 纯文本预览'))
    await page.getByRole('button', { name: '招聘者阅读' }).press('Enter')
    await page.getByRole('button', { name: '检查并导出' }).press('Enter')
    await expectVisible(page.getByText(/已阻止导出/u))
    await expectVisible(page.getByText('导出已受限'))
    await capture('03-resume-source-and-blocker.png')
  })

  await runStep('在职业档案中核验事实', async () => {
    await useNavigation('职业档案', '职业档案')
    const proposedFact = page.getByRole('button', { name: /发布流程从 7 步缩短到 4 步/u })
    await proposedFact.press('Enter')
    await page.getByRole('button', { name: '确认为真实' }).press('Enter')
    await expectVisible(page.getByText('事实已核验，可以用于简历。'))
    await expectVisible(page.getByText('已核验', { exact: true }).last())
  })

  await runStep('AI 深访输入只生成待核验事实', async () => {
    await useNavigation('AI 深访', 'AI 深访')
    const answer = '我负责招募受访者、主持访谈，并将观察整理为三类可用性问题。'
    await page.getByRole('textbox', { name: '你的回答' }).fill(answer)
    await page.getByRole('button', { name: /生成待核验事实/u }).press('Enter')
    await expectVisible(page.getByText(answer).first())
    await expectVisible(page.getByText('已生成一条待核验事实，不会自动写入简历。'))
  })

  await runStep('岗位证据矩阵', async () => {
    await useNavigation('岗位机会', '岗位机会')
    const matrix = page.getByRole('table', { name: /要求与证据矩阵/u })
    await expectVisible(matrix)
    assert.ok((await matrix.getByRole('row').count()) >= 5)
    await expectVisible(matrix.getByText('有消费硬件研究经验'))
    await expectVisible(matrix.getByText('缺口', { exact: true }))
    await dismissVisibleToasts()
    await capture('04-opportunity-evidence-matrix.png')
  })

  await runStep('连接与隐私的真实演示状态', async () => {
    await useNavigation('连接与隐私', '连接与隐私')
    await expectVisible(page.getByText('未登录', { exact: true }))
    await expectVisible(page.getByText('不可用', { exact: true }))
    await expectVisible(page.getByText('未授予', { exact: true }))
    await expectVisible(page.getByText('未连接', { exact: true }))
    const privateFactsSwitch = page.getByRole('switch', { name: /私密偏好与限制/u })
    assert.equal(await privateFactsSwitch.isChecked(), false)
    await privateFactsSwitch.press('Space')
    assert.equal(await privateFactsSwitch.isChecked(), true)

    const connectButton = page.getByRole('button', { name: '查看连接说明' })
    await connectButton.press('Enter')
    const dialog = page.getByRole('dialog', { name: '连接 Codex 前必须知道' })
    await expectVisible(dialog)
    assert.equal(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
      '连接说明对话框未接管焦点',
    )
    await expectVisible(dialog.getByText(/不会启动 OAuth/u))
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(
      await connectButton.evaluate((element) => element === document.activeElement),
      true,
      '关闭对话框后未恢复触发器焦点',
    )

    await connectButton.press('Enter')
    await page.getByRole('button', { name: '启用本地交互演示' }).press('Enter')
    await expectVisible(page.getByText('仅本地演示', { exact: true }))
    await dismissVisibleToasts()
    await capture('05-settings-privacy-and-truthful-state.png')
  })

  await runStep('窄窗口导航与来源抽屉', async () => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.setSize(820, 760)
    })
    await page.waitForTimeout(220)
    assert.equal(await page.locator('.sidebar').count(), 0)
    const navigationTrigger = page.getByRole('button', { name: '打开导航' })
    await expectVisible(navigationTrigger)
    await navigationTrigger.press('Enter')
    const navigationDrawer = page.getByRole('dialog', { name: '前往' })
    await expectVisible(navigationDrawer)
    await navigationDrawer.getByRole('button', { name: '简历工作室' }).press('Enter')
    const inspectorTrigger = page.getByRole('button', { name: '来源检查器' })
    await expectVisible(inspectorTrigger)
    await inspectorTrigger.press('Enter')
    await expectVisible(page.getByRole('dialog', { name: '来源检查器' }))
    await capture('06-narrow-resume-inspector-drawer.png')
    await page.keyboard.press('Escape')

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }))
    assert.ok(layout.viewportWidth <= 900)
    assert.ok(
      layout.bodyScrollWidth <= layout.bodyClientWidth + 1,
      `窄窗口出现水平溢出：${layout.bodyScrollWidth}/${layout.bodyClientWidth}`,
    )
  })

  await runStep('200% 缩放保持可用', async () => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.webContents.setZoomFactor(2)
    })
    await page.waitForTimeout(220)
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }))
    assert.ok(layout.viewportWidth <= 460, `200% 缩放未生效：${layout.viewportWidth}`)
    assert.ok(
      layout.bodyScrollWidth <= layout.bodyClientWidth + 1,
      `200% 缩放出现水平溢出：${layout.bodyScrollWidth}/${layout.bodyClientWidth}`,
    )
    await expectVisible(page.getByRole('button', { name: '打开导航' }))
    await expectVisible(page.getByRole('heading', { name: '简历工作室', exact: true }).first())
    await capture('06b-resume-at-200-percent-zoom.png')
  })

  await runStep('关键无障碍语义', async () => {
    const audit = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
      const unnamedButtons = [...document.querySelectorAll('button')]
        .filter((button) => !button.closest('[inert]'))
        .filter(
          (button) =>
            !button.textContent?.trim() &&
            !button.getAttribute('aria-label') &&
            !button.getAttribute('title'),
        ).length
      const unlabeledControls = [...document.querySelectorAll('input, textarea, select')]
        .filter((control) => !control.closest('[inert]'))
        .filter(
          (control) =>
            !(control instanceof HTMLInputElement && control.labels?.length) &&
            !(control instanceof HTMLTextAreaElement && control.labels?.length) &&
            !(control instanceof HTMLSelectElement && control.labels?.length) &&
            !control.getAttribute('aria-label') &&
            !control.getAttribute('aria-labelledby'),
        ).length
      return { duplicateIds, unnamedButtons, unlabeledControls }
    })
    assert.deepEqual(audit.duplicateIds, [])
    assert.equal(audit.unnamedButtons, 0)
    assert.equal(audit.unlabeledControls, 0)

    const navigationTrigger = page.getByRole('button', { name: '打开导航' })
    await navigationTrigger.focus()
    const focusStyle = await navigationTrigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
    })
    assert.notEqual(focusStyle.outlineStyle, 'none')
    assert.notEqual(focusStyle.outlineWidth, '0px')
  })

  assert.deepEqual(pageErrors, [], `Renderer page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `Renderer console errors: ${consoleErrors.join(' | ')}`)

  await electronApp.close()
  electronApp = undefined

  await runStep('真实本地个人工作区初始化与资料导入', async () => {
    personalUserDataDirectory = await mkdtemp(join(tmpdir(), 'bosshunter-next-personal-e2e-'))
    const fixturePath = join(personalUserDataDirectory, '个人项目复盘.txt')
    const boundedInflationProbePath = join(personalUserDataDirectory, '超限声明探针.docx')
    await writeFile(
      fixturePath,
      '校园项目复盘\n我负责招募受访者、主持访谈，并把观察整理为三类可用性问题。所有数字均需本人核验。\n',
      'utf8',
    )
    await writeFile(boundedInflationProbePath, createBoundedInflationProbeDocx())

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [appDirectory],
      cwd: appDirectory,
      env: {
        ...process.env,
        BOSSHUNTER_E2E: '1',
        BOSSHUNTER_E2E_USER_DATA_DIR: personalUserDataDirectory,
        BOSSHUNTER_E2E_IMPORT_PATHS: JSON.stringify([boundedInflationProbePath, fixturePath]),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: 30_000,
    })
    electronApp.process().stderr?.on('data', (chunk) => mainDiagnostics.push(String(chunk)))
    electronApp.on('window', observePage)
    page = await electronApp.firstWindow()
    observePage(page)
    page.setDefaultTimeout(12_000)

    await expectVisible(page.getByRole('heading', { name: '先建立可信的职业事实，再开始写简历' }))
    const personalRuntime = await page.evaluate(() => window.bossHunter.runtime.info())
    personalPersistenceMode = personalRuntime.persistenceMode
    assert.equal(
      personalRuntime.encryptionAvailable,
      personalPersistenceMode === 'encrypted',
      '运行时加密能力与个人库保存模式不一致',
    )
    await page.getByRole('textbox', { name: /怎么称呼你/u }).fill('验收同学')
    await page.getByRole('textbox', { name: /当前目标岗位/u }).fill('产品经理')
    if (personalPersistenceMode === 'memory-only') {
      const createButton = page.getByRole('button', { name: '创建临时内存工作区' })
      await expectVisible(page.getByText(/退出应用后会全部丢失/u).first())
      assert.equal(await createButton.isDisabled(), true)
      await page.getByRole('checkbox', { name: /我理解这是临时内存工作区/u }).check()
      await createButton.press('Enter')
      await expectVisible(page.getByText('验收同学的临时内存工作区'))
      assert.equal(await page.getByText('个人加密工作区', { exact: true }).count(), 0)
    } else {
      await page.getByRole('button', { name: '创建个人加密工作区' }).press('Enter')
      await expectVisible(page.getByText('验收同学的个人加密工作区'))
    }

    await page.getByRole('button', { name: '选择资料' }).press('Enter')
    await expectVisible(
      page.getByText(
        personalPersistenceMode === 'memory-only'
          ? '资料只保留在本次运行的临时内存工作区，尚未发送给 AI；退出后会丢失。'
          : '资料已写入个人职业库，尚未发送给 AI。',
      ),
    )
    await expectVisible(page.getByText('个人项目复盘.txt').first())
    await expectVisible(page.getByText('超限声明探针.docx').first())
    await expectVisible(page.getByText('已拒绝', { exact: true }))
    await expectVisible(page.getByText(/资料解压后的文字超过本地安全上限/u))
    assert.equal(await page.getByText('已导入', { exact: true }).last().isVisible(), true)
    await capture('07-personal-workspace-local-import.png')

    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expectVisible(page.getByRole('heading', { name: '先核验三条候选事实' }))
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expectVisible(page.getByRole('heading', { name: '确认 AI 与隐私边界' }))
    await page.getByRole('checkbox', { name: /我理解上传/u }).check()
    await page
      .getByRole('button', {
        name:
          personalPersistenceMode === 'memory-only' ? '进入临时内存工作区' : '进入个人加密工作区',
      })
      .click()

    await expectVisible(
      page
        .getByText(
          personalPersistenceMode === 'memory-only' ? '临时内存工作区' : '个人加密工作区',
          { exact: true },
        )
        .first(),
    )
    assert.equal(await page.getByText('内容来自本地演示数据，不代表真实连接状态').count(), 0)

    await useNavigation('职业档案', '职业档案')
    await expectVisible(page.getByText('个人项目复盘.txt').first())
    await expectVisible(page.getByText(/尚未发送给 AI/u).first())

    await useNavigation('求职进展', '求职进展')
    await expectVisible(page.getByText('平台连接未开放', { exact: true }))
    await expectVisible(page.getByText('当前没有真实申请记录来源'))

    await useNavigation('HR 收件箱', 'HR 收件箱')
    await expectVisible(page.getByText('平台连接未开放', { exact: true }))
    await expectVisible(page.getByText('没有可验证的真实消息来源'))

    await useNavigation('连接与隐私', '连接与隐私')
    await expectVisible(page.getByText('离线', { exact: true }))
    await expectVisible(
      page
        .getByText(
          personalPersistenceMode === 'memory-only' ? '临时内存工作区' : '个人加密工作区',
          { exact: true },
        )
        .last(),
    )
    await expectVisible(
      page.getByText(
        personalPersistenceMode === 'memory-only' ? '仅本次运行 · 退出即丢失' : '系统加密',
        { exact: true },
      ),
    )
    await capture('08-personal-settings-offline.png')
  })

  await electronApp.close()
  electronApp = undefined

  await runStep('个人工作区重启后的真实保存语义', async () => {
    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [appDirectory],
      cwd: appDirectory,
      env: {
        ...process.env,
        BOSSHUNTER_E2E: '1',
        BOSSHUNTER_E2E_USER_DATA_DIR: personalUserDataDirectory,
        BOSSHUNTER_E2E_IMPORT_PATHS: JSON.stringify([
          join(personalUserDataDirectory, '个人项目复盘.txt'),
        ]),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: 30_000,
    })
    electronApp.process().stderr?.on('data', (chunk) => mainDiagnostics.push(String(chunk)))
    electronApp.on('window', observePage)
    page = await electronApp.firstWindow()
    observePage(page)
    page.setDefaultTimeout(12_000)

    if (personalPersistenceMode === 'encrypted') {
      await expectVisible(page.getByText('个人加密工作区', { exact: true }).first())
      await useNavigation('职业档案', '职业档案')
      await expectVisible(page.getByText('个人项目复盘.txt').first())
    } else {
      await expectVisible(page.getByRole('heading', { name: '先建立可信的职业事实，再开始写简历' }))
      await expectVisible(page.getByText(/资料只保留在本次运行的内存中/u))
      assert.equal(await page.getByText('个人项目复盘.txt').count(), 0)
      assert.equal(await page.getByText('个人加密工作区', { exact: true }).count(), 0)
    }
    await capture('09-personal-restart-storage-semantics.png')
  })

  assert.deepEqual(pageErrors, [], `Renderer page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `Renderer console errors: ${consoleErrors.join(' | ')}`)
} catch (error) {
  failure = error
  if (page && !page.isClosed()) {
    try {
      await capture('99-failure.png')
    } catch {
      // Preserve the original assertion failure when screenshot capture also fails.
    }
  }
} finally {
  if (electronApp) await electronApp.close()
  await rm(userDataDirectory, { recursive: true, force: true })
  if (personalUserDataDirectory) {
    await rm(personalUserDataDirectory, { recursive: true, force: true })
  }
}

const normalizedMainDiagnostics = normalizeDiagnostics(mainDiagnostics)
if (!failure && normalizedMainDiagnostics.length > 0) {
  failure = new Error(`Electron main diagnostics: ${normalizedMainDiagnostics.join(' | ')}`)
}

const report = {
  generatedAt: new Date().toISOString(),
  electronExecutable,
  completedSteps,
  screenshots,
  consoleErrors,
  pageErrors,
  mainDiagnostics: normalizedMainDiagnostics,
  fingerprints,
  passed: !failure,
  failure:
    failure instanceof Error
      ? (failure.stack ?? failure.message)
      : failure
        ? String(failure)
        : null,
}
await writeFile(resolve(artifactDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

if (failure) throw failure

console.log(`BossHunter Next Electron E2E passed: ${completedSteps.length} steps`)
console.log(`Artifacts: ${artifactDirectory}`)
