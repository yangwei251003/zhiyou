export type PageKey =
  'home' | 'profile' | 'interview' | 'opportunities' | 'resume' | 'progress' | 'inbox' | 'settings'

export type FactStatus = 'proposed' | 'verified' | 'disputed'
export type Coverage = 'supported' | 'partial' | 'missing'

export interface SourceDocument {
  id: string
  name: string
  kind: 'resume' | 'project' | 'certificate' | 'transcript' | 'note'
  status: 'ready' | 'review'
  selectedAt: string
  size: number
}

export interface EvidenceFact {
  id: string
  category: 'experience' | 'result' | 'skill' | 'education' | 'preference'
  statement: string
  detail: string
  status: FactStatus
  confidence: number
  sourceIds: string[]
  restricted: boolean
}

export interface JobRequirement {
  id: string
  label: string
  importance: 'required' | 'preferred'
  coverage: Coverage
  factIds: string[]
  rationale: string
}

export interface JobOpportunity {
  id: string
  company: string
  title: string
  location: string
  source: string
  capturedAt: string
  requirements: JobRequirement[]
}

export interface ResumeClaim {
  id: string
  section: 'summary' | 'experience' | 'project' | 'skill'
  text: string
  sourceFactIds: string[]
  included: boolean
}

export interface ApplicationRecord {
  id: string
  company: string
  title: string
  stage: 'analyzed' | 'tailored' | 'ready' | 'applied' | 'interview'
  updatedAt: string
}

export interface InboxThread {
  id: string
  company: string
  title: string
  sender: string
  receivedAt: string
  message: string
  suggestedReply: string
  draft: string
  state: 'needs_review' | 'saved_for_manual_send'
}

export interface PrivacyPreferences {
  allowAiForVerifiedFacts: boolean
  allowAiForPrivateFacts: boolean
  diagnosticsEnabled: boolean
}

export interface DemoWorkspace {
  version: 1
  onboardingCompleted: boolean
  workspaceName: string
  sources: SourceDocument[]
  facts: EvidenceFact[]
  jobs: JobOpportunity[]
  selectedJobId: string
  resumeClaims: ResumeClaim[]
  applications: ApplicationRecord[]
  inbox: InboxThread[]
  privacy: PrivacyPreferences
  interviewNotes: string[]
  codexMode: 'not_connected' | 'demo_only'
}
