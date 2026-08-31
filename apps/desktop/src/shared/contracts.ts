export const IPC_CHANNELS = {
  runtimeInfo: 'runtime:info',
  selectEvidenceFiles: 'files:select-evidence',
  openExternal: 'external:open',
  loadDemoState: 'demo:load',
  saveDemoState: 'demo:save',
  clearDemoState: 'demo:clear',
  careerSnapshot: 'career:snapshot',
  careerInitialize: 'career:initialize',
  careerImportEvidence: 'career:import-evidence',
  careerExtractFacts: 'career:extract-facts',
  careerAcceptProposal: 'career:accept-proposal',
  careerUpdateFactPermissions: 'career:update-fact-permissions',
  careerInterview: 'career:interview',
  careerAnalyzeJob: 'career:analyze-job',
  careerBuildResume: 'career:build-resume',
  careerTailorResume: 'career:tailor-resume',
  careerApproveResumeClaim: 'career:approve-resume-claim',
  careerExportResume: 'career:export-resume',
  careerExportVault: 'career:export-vault',
  careerDeleteVault: 'career:delete-vault',
  codexStatus: 'codex:status',
  codexLogin: 'codex:login',
  codexRateLimits: 'codex:rate-limits',
  codexLogout: 'codex:logout',
} as const

export interface RuntimeInfo {
  appVersion: string
  platform: NodeJS.Platform
  encryptionAvailable: boolean
  persistenceMode: 'encrypted' | 'memory-only'
}

export interface SelectedEvidenceFile {
  id: string
  name: string
  extension: string
  size: number
  selectedAt: string
}

export interface SaveResult {
  saved: boolean
  savedAt: string | null
  reason?: 'ENCRYPTION_UNAVAILABLE' | 'INVALID_PAYLOAD'
}

export interface DesktopError {
  code: string
  message: string
  retryable: boolean
}

export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: DesktopError }

export interface CareerWorkspaceSummary {
  id: string
  profileId: string
  name: string
  displayName: string
  targetRoles: string[]
  locale: 'zh-CN' | 'en-US'
}

export interface CareerSourceSummary {
  id: string
  name: string
  kind: string
  mimeType: string
  size: number
  status: string
  requiresOcr: boolean
  importedAt: string
  fragmentCount: number
  characterCount: number
}

export interface CareerProposalSummary {
  id: string
  category: string
  title: string
  claim: string
  confidence: number
  rationale: string | null
  sourceCount: number
  sources: CareerSourceLocatorSummary[]
}

export interface CareerSourceLocatorSummary {
  documentId: string
  fragmentId: string | null
  page: number | null
  section: string | null
  quote: string | null
}

export interface CareerFactSummary {
  id: string
  revisionId: string
  category: string
  title: string
  claim: string
  sourceCount: number
  sources: CareerSourceLocatorSummary[]
  aiAllowed: boolean
  resumeAllowed: boolean
  sensitivity: 'standard' | 'sensitive' | 'highly_sensitive'
}

export interface CareerRequirementSummary {
  id: string
  text: string
  category: string
  priority: number
  verdict: 'supported' | 'partial' | 'unknown' | 'gap' | null
  explanation: string | null
  factIds: string[]
}

export interface CareerJobSummary {
  id: string
  company: string
  title: string
  location: string | null
  salary: string | null
  source: string
  capturedAt: string
  evidenceCoverage: number | null
  requirements: CareerRequirementSummary[]
  learningActions: Array<{
    id: string
    title: string
    outcome: string
    evidenceToProduce: string
  }>
}

export interface ResumeDraftSummary {
  versionId: string
  jobId: string
  name: string
  exported: boolean
  validationValid: boolean
  blockingIssues: string[]
  atsText: string
  sections: Array<{
    id: string
    kind: string
    title: string
    claims: Array<{
      id: string
      text: string
      revisionId: string
      originalText: string | null
      rationale: string | null
      reviewRequired: boolean
      reviewed: boolean
      reviewedAt: string | null
    }>
  }>
}

export interface CareerSnapshot {
  persistenceMode: 'encrypted' | 'memory-only'
  vaultAccess: {
    status: 'ready' | 'locked'
    message: string | null
  }
  workspace: CareerWorkspaceSummary | null
  sources: CareerSourceSummary[]
  proposals: CareerProposalSummary[]
  facts: CareerFactSummary[]
  jobs: CareerJobSummary[]
  resumeDrafts: ResumeDraftSummary[]
}

export interface InitializeCareerInput {
  displayName: string
  targetRole: string
  location?: string
}

export interface ImportedEvidenceItem {
  name: string
  status: 'imported' | 'needs_ocr' | 'rejected'
  documentId: string | null
  fragmentCount: number
  characterCount: number
  message: string
}

export interface ImportEvidenceResult {
  items: ImportedEvidenceItem[]
  snapshot: CareerSnapshot
}

export interface ExtractFactsInput {
  documentId: string
}

export interface AcceptProposalInput {
  proposalId: string
  claim?: string
  aiAllowed: boolean
  resumeAllowed: boolean
  sensitivity: 'standard' | 'sensitive' | 'highly_sensitive'
}

export interface UpdateFactPermissionsInput {
  factId: string
  aiAllowed: boolean
  resumeAllowed: boolean
}

export interface InterviewMessageInput {
  role: 'user' | 'assistant'
  content: string
}

export interface InterviewInput {
  messages: InterviewMessageInput[]
  factIds: string[]
}

export interface InterviewResult {
  question: string
  rationale: string
  proposalIds: string[]
  snapshot: CareerSnapshot
}

export interface AnalyzeJobInput {
  company: string
  title: string
  description: string
  location?: string
  salary?: string
}

export interface AnalyzeJobResult {
  job: CareerJobSummary
  snapshot: CareerSnapshot
}

export interface BuildResumeInput {
  jobId: string
  factIds: string[]
  name: string
  template: 'ats_single_column' | 'professional' | 'campus_project'
}

export interface BuildResumeResult {
  draft: ResumeDraftSummary
  snapshot: CareerSnapshot
}

export interface ExportResumeInput {
  versionId: string
  format: 'html' | 'text'
}

export interface ApproveResumeClaimInput {
  versionId: string
  claimId: string
}

export interface ApproveResumeClaimResult {
  confirmed: boolean
  draft: ResumeDraftSummary
  snapshot: CareerSnapshot
}

export interface ExportResumeResult {
  saved: boolean
  filePath: string | null
  filename: string
}

export interface DeleteCareerVaultResult {
  deleted: boolean
  cleanupPending: boolean
  snapshot: CareerSnapshot
}

export interface ExportCareerVaultResult {
  exported: boolean
  directoryPath: string | null
  documentCount: number
}

export interface CodexStatusSummary {
  availability: 'ready' | 'auth_required' | 'rate_limited' | 'offline'
  authMode: 'chatgpt' | 'api_key' | null
  planType: string | null
  message: string
  retryAt: string | null
}

export interface CodexLoginSummary {
  started: boolean
  openedBrowser: boolean
  message: string
}

export interface CodexRateLimitSummary {
  available: boolean
  planType: string | null
  primaryUsedPercent: number | null
  primaryResetsAt: string | null
  secondaryUsedPercent: number | null
  secondaryResetsAt: string | null
}

export interface DesktopApi {
  runtime: {
    info: () => Promise<RuntimeInfo>
  }
  files: {
    selectEvidence: () => Promise<SelectedEvidenceFile[]>
  }
  external: {
    open: (url: string) => Promise<boolean>
  }
  demo: {
    load: () => Promise<unknown>
    save: (snapshot: unknown) => Promise<SaveResult>
    clear: () => Promise<void>
  }
  career: {
    snapshot: () => Promise<DesktopResult<CareerSnapshot>>
    initialize: (input: InitializeCareerInput) => Promise<DesktopResult<CareerSnapshot>>
    importEvidence: () => Promise<DesktopResult<ImportEvidenceResult>>
    extractFacts: (input: ExtractFactsInput) => Promise<DesktopResult<CareerSnapshot>>
    acceptProposal: (input: AcceptProposalInput) => Promise<DesktopResult<CareerSnapshot>>
    updateFactPermissions: (
      input: UpdateFactPermissionsInput,
    ) => Promise<DesktopResult<CareerSnapshot>>
    interview: (input: InterviewInput) => Promise<DesktopResult<InterviewResult>>
    analyzeJob: (input: AnalyzeJobInput) => Promise<DesktopResult<AnalyzeJobResult>>
    buildResume: (input: BuildResumeInput) => Promise<DesktopResult<BuildResumeResult>>
    tailorResume: (input: BuildResumeInput) => Promise<DesktopResult<BuildResumeResult>>
    approveResumeClaim: (
      input: ApproveResumeClaimInput,
    ) => Promise<DesktopResult<ApproveResumeClaimResult>>
    exportResume: (input: ExportResumeInput) => Promise<DesktopResult<ExportResumeResult>>
    exportVault: () => Promise<DesktopResult<ExportCareerVaultResult>>
    deleteVault: () => Promise<DesktopResult<DeleteCareerVaultResult>>
  }
  codex: {
    status: () => Promise<DesktopResult<CodexStatusSummary>>
    login: () => Promise<DesktopResult<CodexLoginSummary>>
    rateLimits: () => Promise<DesktopResult<CodexRateLimitSummary>>
    logout: () => Promise<DesktopResult<CodexStatusSummary>>
  }
}
