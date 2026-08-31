import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AcceptProposalInput,
  type AnalyzeJobInput,
  type ApproveResumeClaimInput,
  type BuildResumeInput,
  type DesktopApi,
  type ExportResumeInput,
  type ExtractFactsInput,
  type InitializeCareerInput,
  type InterviewInput,
  type UpdateFactPermissionsInput,
} from '../shared/contracts'

const desktopApi: DesktopApi = Object.freeze({
  runtime: Object.freeze({
    info: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeInfo),
  }),
  files: Object.freeze({
    selectEvidence: () => ipcRenderer.invoke(IPC_CHANNELS.selectEvidenceFiles),
  }),
  external: Object.freeze({
    open: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  }),
  demo: Object.freeze({
    load: () => ipcRenderer.invoke(IPC_CHANNELS.loadDemoState),
    save: (snapshot: unknown) => ipcRenderer.invoke(IPC_CHANNELS.saveDemoState, snapshot),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.clearDemoState),
  }),
  career: Object.freeze({
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.careerSnapshot),
    initialize: (input: InitializeCareerInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerInitialize, input),
    importEvidence: () => ipcRenderer.invoke(IPC_CHANNELS.careerImportEvidence),
    extractFacts: (input: ExtractFactsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerExtractFacts, input),
    acceptProposal: (input: AcceptProposalInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerAcceptProposal, input),
    updateFactPermissions: (input: UpdateFactPermissionsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerUpdateFactPermissions, input),
    interview: (input: InterviewInput) => ipcRenderer.invoke(IPC_CHANNELS.careerInterview, input),
    analyzeJob: (input: AnalyzeJobInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerAnalyzeJob, input),
    buildResume: (input: BuildResumeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerBuildResume, input),
    tailorResume: (input: BuildResumeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerTailorResume, input),
    approveResumeClaim: (input: ApproveResumeClaimInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerApproveResumeClaim, input),
    exportResume: (input: ExportResumeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.careerExportResume, input),
    exportVault: () => ipcRenderer.invoke(IPC_CHANNELS.careerExportVault),
    deleteVault: () => ipcRenderer.invoke(IPC_CHANNELS.careerDeleteVault),
  }),
  codex: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.codexStatus),
    login: () => ipcRenderer.invoke(IPC_CHANNELS.codexLogin),
    rateLimits: () => ipcRenderer.invoke(IPC_CHANNELS.codexRateLimits),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.codexLogout),
  }),
})

contextBridge.exposeInMainWorld('bossHunter', desktopApi)
