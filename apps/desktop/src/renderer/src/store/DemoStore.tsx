import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react'
import type { SelectedEvidenceFile } from '../../../shared/contracts'
import { createDemoWorkspace } from './demoData'
import type { ApplicationRecord, DemoWorkspace, FactStatus, PrivacyPreferences } from './types'

type DemoAction =
  | { type: 'hydrate'; workspace: DemoWorkspace }
  | { type: 'completeOnboarding' }
  | { type: 'addSources'; files: SelectedEvidenceFile[] }
  | { type: 'setFactStatus'; factId: string; status: FactStatus }
  | { type: 'setSelectedJob'; jobId: string }
  | { type: 'updateResumeClaim'; claimId: string; text: string }
  | { type: 'toggleResumeClaim'; claimId: string }
  | { type: 'addInterviewProposal'; answer: string }
  | { type: 'advanceApplication'; applicationId: string }
  | { type: 'saveReplyDraft'; threadId: string; draft: string }
  | { type: 'setPrivacy'; key: keyof PrivacyPreferences; value: boolean }
  | { type: 'setCodexDemo' }
  | { type: 'reset' }

interface DemoStoreValue {
  workspace: DemoWorkspace
  dispatch: Dispatch<DemoAction>
  hydrated: boolean
}

const DemoStoreContext = createContext<DemoStoreValue | null>(null)

const stageOrder: ApplicationRecord['stage'][] = [
  'analyzed',
  'tailored',
  'ready',
  'applied',
  'interview',
]

function isDemoWorkspace(value: unknown): value is DemoWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<DemoWorkspace>
  return (
    candidate.version === 1 &&
    typeof candidate.workspaceName === 'string' &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.facts) &&
    Array.isArray(candidate.jobs)
  )
}

function reducer(state: DemoWorkspace, action: DemoAction): DemoWorkspace {
  switch (action.type) {
    case 'hydrate':
      return action.workspace
    case 'completeOnboarding':
      return { ...state, onboardingCompleted: true }
    case 'addSources': {
      const knownIds = new Set(state.sources.map((source) => source.id))
      const added = action.files
        .filter((file) => !knownIds.has(file.id))
        .map((file) => ({
          id: file.id,
          name: file.name,
          kind: 'note' as const,
          status: 'review' as const,
          selectedAt: file.selectedAt,
          size: file.size,
        }))
      return { ...state, sources: [...state.sources, ...added] }
    }
    case 'setFactStatus':
      return {
        ...state,
        facts: state.facts.map((fact) =>
          fact.id === action.factId ? { ...fact, status: action.status } : fact,
        ),
      }
    case 'setSelectedJob':
      return { ...state, selectedJobId: action.jobId }
    case 'updateResumeClaim':
      return {
        ...state,
        resumeClaims: state.resumeClaims.map((claim) =>
          claim.id === action.claimId ? { ...claim, text: action.text } : claim,
        ),
      }
    case 'toggleResumeClaim':
      return {
        ...state,
        resumeClaims: state.resumeClaims.map((claim) =>
          claim.id === action.claimId ? { ...claim, included: !claim.included } : claim,
        ),
      }
    case 'addInterviewProposal': {
      const trimmed = action.answer.trim()
      if (!trimmed) return state
      const id = `fact-interview-${Date.now()}`
      return {
        ...state,
        interviewNotes: [...state.interviewNotes, trimmed],
        facts: [
          ...state.facts,
          {
            id,
            category: 'experience',
            statement: trimmed,
            detail: '来自 AI 深访记录，必须由用户核验后才能用于简历。',
            status: 'proposed',
            confidence: 0.55,
            sourceIds: [],
            restricted: false,
          },
        ],
      }
    }
    case 'advanceApplication':
      return {
        ...state,
        applications: state.applications.map((application) => {
          if (application.id !== action.applicationId) return application
          const currentIndex = stageOrder.indexOf(application.stage)
          const nextStage = stageOrder[Math.min(currentIndex + 1, stageOrder.length - 1)]
          return nextStage ? { ...application, stage: nextStage, updatedAt: '刚刚' } : application
        }),
      }
    case 'saveReplyDraft':
      return {
        ...state,
        inbox: state.inbox.map((thread) =>
          thread.id === action.threadId
            ? { ...thread, draft: action.draft, state: 'saved_for_manual_send' }
            : thread,
        ),
      }
    case 'setPrivacy':
      return { ...state, privacy: { ...state.privacy, [action.key]: action.value } }
    case 'setCodexDemo':
      return { ...state, codexMode: 'demo_only' }
    case 'reset':
      return createDemoWorkspace()
  }
}

export function DemoStoreProvider({ children }: PropsWithChildren) {
  const [workspace, dispatch] = useReducer(reducer, undefined, createDemoWorkspace)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      let persisted: unknown = null
      try {
        persisted = await window.bossHunter?.demo.load()
      } catch {
        persisted = null
      }
      if (cancelled) return
      if (isDemoWorkspace(persisted)) dispatch({ type: 'hydrate', workspace: persisted })
      setHydrated(true)
    }
    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => {
      void window.bossHunter?.demo.save(workspace)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [hydrated, workspace])

  const value = useMemo(() => ({ workspace, dispatch, hydrated }), [hydrated, workspace])
  return <DemoStoreContext.Provider value={value}>{children}</DemoStoreContext.Provider>
}

export function useDemoStore(): DemoStoreValue {
  const value = useContext(DemoStoreContext)
  if (!value) throw new Error('useDemoStore must be used inside DemoStoreProvider')
  return value
}
