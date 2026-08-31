import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  AcceptProposalInput,
  AnalyzeJobInput,
  AnalyzeJobResult,
  ApproveResumeClaimInput,
  ApproveResumeClaimResult,
  BuildResumeInput,
  BuildResumeResult,
  CareerSnapshot,
  CodexLoginSummary,
  CodexRateLimitSummary,
  CodexStatusSummary,
  DesktopError,
  DesktopResult,
  DeleteCareerVaultResult,
  ExportResumeInput,
  ExportResumeResult,
  ExportCareerVaultResult,
  ExtractFactsInput,
  ImportEvidenceResult,
  InitializeCareerInput,
  InterviewInput,
  InterviewResult,
  UpdateFactPermissionsInput,
} from '../../../shared/contracts'

export type CareerMode = 'checking' | 'uninitialized' | 'personal' | 'demo'
export type RealOperation =
  | 'initialize'
  | 'import'
  | 'extract'
  | 'accept'
  | 'update-permissions'
  | 'interview'
  | 'analyze-job'
  | 'build-resume'
  | 'tailor-resume'
  | 'approve-resume-claim'
  | 'export-resume'
  | 'delete-vault'
  | 'export-vault'
  | 'codex-status'
  | 'codex-login'
  | 'codex-logout'

interface RealCareerStoreValue {
  mode: CareerMode
  bridgeAvailable: boolean
  onboardingPending: boolean
  snapshot: CareerSnapshot | null
  busy: RealOperation | null
  error: DesktopError | null
  importReport: ImportEvidenceResult['items']
  codexStatus: CodexStatusSummary | null
  codexRateLimits: CodexRateLimitSummary | null
  chooseDemo: () => void
  completePersonalOnboarding: () => void
  clearError: () => void
  refreshSnapshot: () => Promise<DesktopResult<CareerSnapshot>>
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
  deleteVault: () => Promise<DesktopResult<DeleteCareerVaultResult>>
  exportVault: () => Promise<DesktopResult<ExportCareerVaultResult>>
  refreshCodex: () => Promise<DesktopResult<CodexStatusSummary>>
  loginCodex: () => Promise<DesktopResult<CodexLoginSummary>>
  logoutCodex: () => Promise<DesktopResult<CodexStatusSummary>>
}

const RealCareerStoreContext = createContext<RealCareerStoreValue | null>(null)

function bridgeUnavailable<T>(): DesktopResult<T> {
  return {
    ok: false,
    error: {
      code: 'DESKTOP_BRIDGE_UNAVAILABLE',
      message: '真实职业库桥接尚未加载。可继续查看演示，但不会伪装已创建或已保存。',
      retryable: false,
    },
  }
}

function unexpectedError(error: unknown): DesktopError {
  return {
    code: 'UNEXPECTED_RENDERER_ERROR',
    message: error instanceof Error ? error.message : '桌面桥返回了无法识别的错误。',
    retryable: true,
  }
}

export function RealCareerStoreProvider({ children }: PropsWithChildren) {
  const [mode, setMode] = useState<CareerMode>('checking')
  const [bridgeAvailable, setBridgeAvailable] = useState(false)
  const [onboardingPending, setOnboardingPending] = useState(false)
  const [snapshot, setSnapshot] = useState<CareerSnapshot | null>(null)
  const [busy, setBusy] = useState<RealOperation | null>(null)
  const [error, setError] = useState<DesktopError | null>(null)
  const [importReport, setImportReport] = useState<ImportEvidenceResult['items']>([])
  const [codexStatus, setCodexStatus] = useState<CodexStatusSummary | null>(null)
  const [codexRateLimits, setCodexRateLimits] = useState<CodexRateLimitSummary | null>(null)
  const chooseDemo = useCallback(() => {
    setMode('demo')
    setOnboardingPending(false)
    setError(null)
  }, [])
  const completePersonalOnboarding = useCallback(() => setOnboardingPending(false), [])
  const clearError = useCallback(() => setError(null), [])

  const execute = useCallback(
    async <T,>(
      operation: RealOperation,
      request: () => Promise<DesktopResult<T>>,
      snapshotFrom?: (value: T) => CareerSnapshot | null,
    ): Promise<DesktopResult<T>> => {
      setBusy(operation)
      setError(null)
      try {
        const result = await request()
        if (!result.ok) {
          setError(result.error)
          return result
        }
        const nextSnapshot = snapshotFrom?.(result.value)
        if (nextSnapshot) setSnapshot(nextSnapshot)
        return result
      } catch (caught) {
        const nextError = unexpectedError(caught)
        setError(nextError)
        return { ok: false, error: nextError }
      } finally {
        setBusy((current) => (current === operation ? null : current))
      }
    },
    [],
  )

  const refreshSnapshot = useCallback(async (): Promise<DesktopResult<CareerSnapshot>> => {
    const api = window.bossHunter?.career
    return execute(
      'initialize',
      () => (api ? api.snapshot() : Promise.resolve(bridgeUnavailable<CareerSnapshot>())),
      (value) => value,
    )
  }, [execute])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const api = window.bossHunter?.career
      if (!api) {
        if (!cancelled) {
          setBridgeAvailable(false)
          setMode('uninitialized')
        }
        return
      }
      setBridgeAvailable(true)
      try {
        const result = await api.snapshot()
        if (cancelled) return
        if (!result.ok) {
          setError(result.error)
          setMode('uninitialized')
          return
        }
        setSnapshot(result.value)
        setMode(result.value.workspace ? 'personal' : 'uninitialized')
      } catch (caught) {
        if (!cancelled) {
          setError(unexpectedError(caught))
          setMode('uninitialized')
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const initialize = useCallback(
    async (input: InitializeCareerInput) => {
      const api = window.bossHunter?.career
      const result = await execute(
        'initialize',
        () => (api ? api.initialize(input) : Promise.resolve(bridgeUnavailable<CareerSnapshot>())),
        (value) => value,
      )
      if (result.ok) {
        setMode('personal')
        setOnboardingPending(true)
      }
      return result
    },
    [execute],
  )

  const importEvidence = useCallback(async () => {
    const api = window.bossHunter?.career
    const result = await execute(
      'import',
      () =>
        api ? api.importEvidence() : Promise.resolve(bridgeUnavailable<ImportEvidenceResult>()),
      (value) => value.snapshot,
    )
    if (result.ok) setImportReport(result.value.items)
    return result
  }, [execute])

  const extractFacts = useCallback(
    (input: ExtractFactsInput) => {
      const api = window.bossHunter?.career
      return execute(
        'extract',
        () =>
          api ? api.extractFacts(input) : Promise.resolve(bridgeUnavailable<CareerSnapshot>()),
        (value) => value,
      )
    },
    [execute],
  )

  const acceptProposal = useCallback(
    (input: AcceptProposalInput) => {
      const api = window.bossHunter?.career
      return execute(
        'accept',
        () =>
          api ? api.acceptProposal(input) : Promise.resolve(bridgeUnavailable<CareerSnapshot>()),
        (value) => value,
      )
    },
    [execute],
  )

  const updateFactPermissions = useCallback(
    (input: UpdateFactPermissionsInput) => {
      const api = window.bossHunter?.career
      return execute(
        'update-permissions',
        () =>
          api
            ? api.updateFactPermissions(input)
            : Promise.resolve(bridgeUnavailable<CareerSnapshot>()),
        (value) => value,
      )
    },
    [execute],
  )

  const interview = useCallback(
    (input: InterviewInput) => {
      const api = window.bossHunter?.career
      return execute(
        'interview',
        () => (api ? api.interview(input) : Promise.resolve(bridgeUnavailable<InterviewResult>())),
        (value) => value.snapshot,
      )
    },
    [execute],
  )

  const analyzeJob = useCallback(
    (input: AnalyzeJobInput) => {
      const api = window.bossHunter?.career
      return execute(
        'analyze-job',
        () =>
          api ? api.analyzeJob(input) : Promise.resolve(bridgeUnavailable<AnalyzeJobResult>()),
        (value) => value.snapshot,
      )
    },
    [execute],
  )

  const buildResume = useCallback(
    (input: BuildResumeInput) => {
      const api = window.bossHunter?.career
      return execute(
        'build-resume',
        () =>
          api ? api.buildResume(input) : Promise.resolve(bridgeUnavailable<BuildResumeResult>()),
        (value) => value.snapshot,
      )
    },
    [execute],
  )

  const tailorResume = useCallback(
    (input: BuildResumeInput) => {
      const api = window.bossHunter?.career
      return execute(
        'tailor-resume',
        () =>
          api ? api.tailorResume(input) : Promise.resolve(bridgeUnavailable<BuildResumeResult>()),
        (value) => value.snapshot,
      )
    },
    [execute],
  )

  const approveResumeClaim = useCallback(
    (input: ApproveResumeClaimInput) => {
      const api = window.bossHunter?.career
      return execute(
        'approve-resume-claim',
        () =>
          api
            ? api.approveResumeClaim(input)
            : Promise.resolve(bridgeUnavailable<ApproveResumeClaimResult>()),
        (value) => value.snapshot,
      )
    },
    [execute],
  )

  const exportResume = useCallback(
    async (input: ExportResumeInput) => {
      const api = window.bossHunter?.career
      const result = await execute('export-resume', () =>
        api ? api.exportResume(input) : Promise.resolve(bridgeUnavailable<ExportResumeResult>()),
      )
      if (!result.ok && api) {
        const reconciled = await api.snapshot()
        if (reconciled.ok) setSnapshot(reconciled.value)
      }
      if (result.ok && result.value.saved) {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                resumeDrafts: current.resumeDrafts.map((draft) =>
                  draft.versionId === input.versionId ? { ...draft, exported: true } : draft,
                ),
              }
            : current,
        )
      }
      return result
    },
    [execute],
  )

  const deleteVault = useCallback(async () => {
    const api = window.bossHunter?.career
    const result = await execute(
      'delete-vault',
      () =>
        api ? api.deleteVault() : Promise.resolve(bridgeUnavailable<DeleteCareerVaultResult>()),
      (value) => value.snapshot,
    )
    if (result.ok && result.value.deleted) {
      setMode('uninitialized')
      setOnboardingPending(false)
      setImportReport([])
    }
    return result
  }, [execute])

  const exportVault = useCallback(() => {
    const api = window.bossHunter?.career
    return execute('export-vault', () =>
      api ? api.exportVault() : Promise.resolve(bridgeUnavailable<ExportCareerVaultResult>()),
    )
  }, [execute])

  const refreshCodex = useCallback(async () => {
    const api = window.bossHunter?.codex
    const result = await execute('codex-status', () =>
      api ? api.status() : Promise.resolve(bridgeUnavailable<CodexStatusSummary>()),
    )
    if (result.ok) setCodexStatus(result.value)
    if (api && result.ok) {
      try {
        const limits = await api.rateLimits()
        if (limits.ok) setCodexRateLimits(limits.value)
        else {
          setError(limits.error)
          return { ok: false as const, error: limits.error }
        }
      } catch (caught) {
        setCodexRateLimits(null)
        const nextError = unexpectedError(caught)
        setError(nextError)
        return { ok: false as const, error: nextError }
      }
    }
    return result
  }, [execute])

  const loginCodex = useCallback(async () => {
    const api = window.bossHunter?.codex
    return execute('codex-login', () =>
      api ? api.login() : Promise.resolve(bridgeUnavailable<CodexLoginSummary>()),
    )
  }, [execute])

  const logoutCodex = useCallback(async () => {
    const api = window.bossHunter?.codex
    const result = await execute('codex-logout', () =>
      api ? api.logout() : Promise.resolve(bridgeUnavailable<CodexStatusSummary>()),
    )
    if (result.ok) {
      setCodexStatus(result.value)
      setCodexRateLimits(null)
    }
    return result
  }, [execute])

  useEffect(() => {
    if (mode === 'personal') void refreshCodex()
  }, [mode, refreshCodex])

  const value = useMemo<RealCareerStoreValue>(
    () => ({
      mode,
      bridgeAvailable,
      onboardingPending,
      snapshot,
      busy,
      error,
      importReport,
      codexStatus,
      codexRateLimits,
      chooseDemo,
      completePersonalOnboarding,
      clearError,
      refreshSnapshot,
      initialize,
      importEvidence,
      extractFacts,
      acceptProposal,
      updateFactPermissions,
      interview,
      analyzeJob,
      buildResume,
      tailorResume,
      approveResumeClaim,
      exportResume,
      deleteVault,
      exportVault,
      refreshCodex,
      loginCodex,
      logoutCodex,
    }),
    [
      acceptProposal,
      updateFactPermissions,
      analyzeJob,
      bridgeAvailable,
      buildResume,
      tailorResume,
      approveResumeClaim,
      busy,
      codexRateLimits,
      codexStatus,
      chooseDemo,
      clearError,
      completePersonalOnboarding,
      error,
      deleteVault,
      exportVault,
      exportResume,
      extractFacts,
      importEvidence,
      importReport,
      initialize,
      interview,
      loginCodex,
      logoutCodex,
      mode,
      onboardingPending,
      refreshCodex,
      refreshSnapshot,
      snapshot,
    ],
  )

  return <RealCareerStoreContext.Provider value={value}>{children}</RealCareerStoreContext.Provider>
}

export function useRealCareerStore(): RealCareerStoreValue {
  const value = useContext(RealCareerStoreContext)
  if (!value) throw new Error('useRealCareerStore must be used inside RealCareerStoreProvider')
  return value
}
