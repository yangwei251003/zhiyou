import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type RuntimeInfo } from '../shared/contracts'
import { clearDemoState, loadDemoState, saveDemoState, selectEvidenceFiles } from './demoRepository'
import { CareerBackend } from './careerBackend'
import {
  hardenWindow,
  isAllowedDevelopmentRendererUrl,
  isHostEncryptionSecure,
  isTrustedIpcFrame,
  openAllowedExternalUrl,
} from './security'

let mainWindow: BrowserWindow | null = null
let trustedApplicationUrl: string | null = null
let shutdownStarted = false

const isolatedTestDataPath = process.env.BOSSHUNTER_E2E_USER_DATA_DIR
if (!app.isPackaged && process.env.BOSSHUNTER_E2E === '1' && isolatedTestDataPath) {
  app.setPath('userData', isolatedTestDataPath)
}

const careerBackend = new CareerBackend()

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (shutdownStarted) throw new Error('Rejected IPC request while the application is closing')
  const window = mainWindow
  const applicationUrl = trustedApplicationUrl
  const senderFrame = event.senderFrame
  if (
    window === null ||
    applicationUrl === null ||
    senderFrame === null ||
    !isTrustedIpcFrame(
      senderFrame.url,
      applicationUrl,
      event.sender.id === window.webContents.id,
      senderFrame === event.sender.mainFrame,
    )
  ) {
    throw new Error('Rejected IPC request from an untrusted renderer')
  }
}

function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel)
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.runtimeInfo, (event): RuntimeInfo => {
    assertTrustedIpcSender(event)
    const encryptionAvailable = isHostEncryptionSecure()
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      encryptionAvailable,
      persistenceMode: encryptionAvailable ? 'encrypted' : 'memory-only',
    }
  })
  ipcMain.handle(IPC_CHANNELS.selectEvidenceFiles, (event) => {
    assertTrustedIpcSender(event)
    return selectEvidenceFiles()
  })
  ipcMain.handle(IPC_CHANNELS.openExternal, (event, url: unknown) => {
    assertTrustedIpcSender(event)
    return typeof url === 'string' ? openAllowedExternalUrl(url) : false
  })
  ipcMain.handle(IPC_CHANNELS.loadDemoState, (event) => {
    assertTrustedIpcSender(event)
    return loadDemoState()
  })
  ipcMain.handle(IPC_CHANNELS.saveDemoState, (event, snapshot: unknown) => {
    assertTrustedIpcSender(event)
    return saveDemoState(snapshot)
  })
  ipcMain.handle(IPC_CHANNELS.clearDemoState, (event) => {
    assertTrustedIpcSender(event)
    return clearDemoState()
  })
  ipcMain.handle(IPC_CHANNELS.careerSnapshot, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.careerInitialize, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.initialize(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerImportEvidence, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.importEvidence()
  })
  ipcMain.handle(IPC_CHANNELS.careerExtractFacts, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.extractFacts(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerAcceptProposal, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.acceptProposal(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerUpdateFactPermissions, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.updateFactPermissions(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerInterview, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.interview(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerAnalyzeJob, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.analyzeJob(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerBuildResume, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.buildResume(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerTailorResume, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.tailorResume(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerApproveResumeClaim, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.approveResumeClaim(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerExportResume, (event, input) => {
    assertTrustedIpcSender(event)
    return careerBackend.exportResume(input)
  })
  ipcMain.handle(IPC_CHANNELS.careerExportVault, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.exportVault()
  })
  ipcMain.handle(IPC_CHANNELS.careerDeleteVault, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.deleteVault()
  })
  ipcMain.handle(IPC_CHANNELS.codexStatus, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.codexStatus()
  })
  ipcMain.handle(IPC_CHANNELS.codexLogin, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.codexLogin()
  })
  ipcMain.handle(IPC_CHANNELS.codexRateLimits, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.codexRateLimits()
  })
  ipcMain.handle(IPC_CHANNELS.codexLogout, (event) => {
    assertTrustedIpcSender(event)
    return careerBackend.codexLogout()
  })
}

async function createWindow(): Promise<void> {
  const preloadPath = join(__dirname, '../preload/index.cjs')
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 640,
    show: false,
    backgroundColor: '#f3f6f9',
    title: 'BossHunter Next',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })

  const rendererCandidate = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  const devUrl =
    rendererCandidate !== undefined && isAllowedDevelopmentRendererUrl(rendererCandidate)
      ? rendererCandidate
      : undefined
  const rendererPath = join(__dirname, '../renderer/index.html')
  const applicationUrl = devUrl ?? pathToFileURL(rendererPath).href
  trustedApplicationUrl = applicationUrl
  mainWindow = window
  hardenWindow(window, applicationUrl)

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (devUrl) await window.loadURL(devUrl)
  else await window.loadFile(rendererPath)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = 'light'
    registerIpcHandlers()
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    event.preventDefault()
    shutdownStarted = true
    unregisterIpcHandlers()
    void careerBackend.close().finally(() => app.quit())
  })
}
