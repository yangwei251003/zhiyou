import { randomBytes, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  AiProviderError,
  CodexAppServerRunner,
  CodexAppServerRuntime,
  CodexProvider,
  MAX_AI_CONTEXT_BYTES,
  MAX_AI_CONTEXT_ITEMS,
  measureAiContextBytes,
} from '@bosshunter/ai'
import {
  ApplicationError,
  CareerApplication,
  ImportParsedDocumentInputSchema,
  presentApplicationError,
  type ResumeExport,
  type TailoredResumeClaim,
} from '@bosshunter/application'
import {
  sha256Text,
  type EvidenceFact,
  type EvidenceRevision,
  type JobRequirement,
  type JobSnapshot,
  type LearningAction,
  type MatchReport,
  type PersonProfile,
  type SourceDocument,
  type SourceLocator,
  type Workspace,
} from '@bosshunter/domain'
import { IngestError } from '@bosshunter/ingest'
import { resumeDocumentSchema, toAtsText, type ResumeDocument } from '@bosshunter/resume'
import { Aes256GcmCodec, SingleWriterStorage, type SensitiveFieldCodec } from '@bosshunter/storage'
import { app, dialog, safeStorage } from 'electron'
import { z } from 'zod'

import type {
  AnalyzeJobResult,
  ApproveResumeClaimResult,
  BuildResumeResult,
  CareerFactSummary,
  CareerJobSummary,
  CareerSnapshot,
  CodexLoginSummary,
  CodexRateLimitSummary,
  CodexStatusSummary,
  DesktopError,
  DesktopResult,
  DeleteCareerVaultResult,
  ExportCareerVaultResult,
  ExportResumeResult,
  ImportEvidenceResult,
  ImportedEvidenceItem,
  InterviewResult,
  ResumeDraftSummary,
} from '../shared/contracts'
import { writeExclusiveCommittedExport } from './exclusiveExport'
import { parseDocumentInWorker } from './ingestWorkerClient'
import { isHostEncryptionSecure, isSameOpenedFile, openAllowedExternalUrl } from './security'
import { chooseVaultOpeningPolicy, LOCKED_VAULT_MESSAGE } from './vaultAvailability'
import {
  cleanupEncryptedVaultTombstones,
  deleteEncryptedVaultDirectory,
  reconcileEncryptedSourceBlobs,
  ResidualPlaintextExportError,
  UnsafeSourceBlobEntryError,
  VaultKeyEraseError,
  VaultKeyEraseRestoreError,
  writeAtomicPlaintextDirectoryExport,
} from './vaultFilesystem'

const CAREER_DATA_DIRECTORY_NAME = 'career-data'
const SOURCE_BLOB_DIRECTORY_NAME = 'documents'
const DELETE_TOMBSTONE_PREFIX = '.career-data-deleting-'
const KEY_FILE_NAME = 'career-vault-key.bhkey'
const DATABASE_FILE_NAME = 'career-vault.sqlite'
const DRAFT_FILE_NAME = 'career-resume-drafts.bhenc'
const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const IS_E2E = !app.isPackaged && process.env.BOSSHUNTER_E2E === '1'

const initializeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    targetRole: z.string().trim().min(1).max(160),
    location: z.string().trim().min(1).max(240).optional(),
  })
  .strict()

const extractSchema = z.object({ documentId: z.string().min(1).max(128) }).strict()

const acceptSchema = z
  .object({
    proposalId: z.string().min(1).max(128),
    claim: z.string().trim().min(1).max(4_000).optional(),
    aiAllowed: z.boolean(),
    resumeAllowed: z.boolean(),
    sensitivity: z.enum(['standard', 'sensitive', 'highly_sensitive']),
  })
  .strict()

const updateFactPermissionsSchema = z
  .object({
    factId: z.string().min(1).max(128),
    aiAllowed: z.boolean(),
    resumeAllowed: z.boolean(),
  })
  .strict()

const interviewSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(12_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    factIds: z.array(z.string().min(1).max(128)).max(100),
  })
  .strict()

const analyzeJobSchema = z
  .object({
    company: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(20).max(50_000),
    location: z.string().trim().min(1).max(240).optional(),
    salary: z.string().trim().min(1).max(160).optional(),
  })
  .strict()

const buildResumeSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    factIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    name: z.string().trim().min(1).max(240),
    template: z.enum(['ats_single_column', 'professional', 'campus_project']),
  })
  .strict()
type ParsedBuildResumeInput = z.infer<typeof buildResumeSchema>

const exportResumeSchema = z
  .object({
    versionId: z.string().min(1).max(128),
    format: z.enum(['html', 'text']),
  })
  .strict()

const approveResumeClaimSchema = z
  .object({
    versionId: z.string().min(1).max(128),
    claimId: z.string().min(1).max(128),
  })
  .strict()

interface StoredDraft {
  readonly name: string
  readonly jobId: string
  readonly document: ResumeDocument
  readonly tailoringRationales: Readonly<Record<string, string>>
}

interface BackendState {
  readonly storage: SingleWriterStorage
  readonly codec: SensitiveFieldCodec
  readonly application: CareerApplication
  readonly persistenceMode: 'encrypted' | 'memory-only'
  readonly vaultAccess: 'ready' | 'locked'
  readonly dataDirectory: string | null
}

function desktopError(error: unknown): DesktopError {
  if (error instanceof IngestError) {
    return { code: error.code, message: ingestMessage(error), retryable: error.retryable }
  }
  if (error instanceof AiProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: ['OFFLINE', 'RATE_LIMITED', 'INTERNAL'].includes(error.code),
    }
  }
  const presented = presentApplicationError(error)
  return {
    code: presented.code,
    message: presented.message,
    retryable: presented.retryable,
  }
}

function ingestMessage(error: IngestError): string {
  const messages: Partial<Record<IngestError['code'], string>> = {
    FILE_TOO_LARGE: '文件超过 10 MB 的本地安全上限。',
    UNSUPPORTED_TYPE: '暂不支持这种文件类型。',
    OCR_REQUIRED: '这份资料没有可提取的文字，需要 OCR；当前不会把图片内容交给 AI 猜测。',
    ENCRYPTED_DOCUMENT_REJECTED: '暂不接受带密码的 PDF。',
    MACRO_DOCUMENT_REJECTED: '为避免宏风险，已拒绝这份 Office 文件。',
    LEGACY_DOC_REJECTED: '旧版 DOC 不受支持，请先另存为 DOCX。',
    ARCHIVE_BOMB_SUSPECTED: '这份 DOCX 的压缩结构异常，已安全拒绝。',
    EXTRACTED_TEXT_LIMIT_EXCEEDED: '资料解压后的文字超过本地安全上限；请拆分成较小文件后再导入。',
    FRAGMENT_LIMIT_EXCEEDED: '资料解压后的文本片段过多；请拆分成较小文件后再导入。',
    PARSE_TIMEOUT: '资料解析超过 15 秒安全时限；请拆分或另存为较小文件后重试。',
    RESOURCE_LIMIT_EXCEEDED: '资料解析触发了本地资源保护；请拆分或另存后再导入。',
    MAGIC_MISMATCH: '文件内容与扩展名不一致，已安全拒绝。',
    DOUBLE_EXTENSION: '检测到可疑的双扩展名，已安全拒绝。',
  }
  return messages[error.code] ?? '资料没有通过本地解析与安全检查。'
}

function result<T>(operation: () => Promise<T> | T): Promise<DesktopResult<T>> {
  return Promise.resolve()
    .then(operation)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error: desktopError(error) }))
}

function timestampFromEpoch(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
  return new Date(milliseconds).toISOString()
}

function sourceKind(name: string): SourceDocument['kind'] {
  const normalized = name.toLocaleLowerCase()
  if (/简历|resume|cv/u.test(normalized)) return 'resume'
  if (/成绩|transcript/u.test(normalized)) return 'transcript'
  if (/证书|certificate|certification/u.test(normalized)) return 'certificate'
  if (/作品|portfolio/u.test(normalized)) return 'portfolio'
  if (/推荐|证明|reference/u.test(normalized)) return 'reference'
  return 'other'
}

function sourceLocatorSummary(source: SourceLocator) {
  return {
    documentId: source.documentId,
    fragmentId: source.fragmentId ?? null,
    page: source.page ?? null,
    section: source.section ?? null,
    quote: source.quote ?? null,
  }
}

function sectionForFact(category: EvidenceFact['category']): {
  kind: ResumeDocument['sections'][number]['kind']
  title: string
} {
  switch (category) {
    case 'education':
      return { kind: 'education', title: '教育经历' }
    case 'skill':
    case 'language':
    case 'certification':
      return { kind: 'skill', title: '技能与证书' }
    case 'award':
    case 'publication':
      return { kind: 'award', title: '成果与荣誉' }
    case 'experience':
    case 'volunteer':
      return { kind: 'experience', title: '实践经历' }
    case 'project':
    case 'research':
    case 'metric':
      return { kind: 'project', title: '项目经历' }
    default:
      return { kind: 'other', title: '补充信息' }
  }
}

function safeExportBase(value: string): string {
  const sanitized = [...value.replace(/[<>:"/\\|?*]/gu, '_')]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint < 32 ? '_' : character
    })
    .join('')
    .trim()
    .slice(0, 120)
  return sanitized.length > 0 ? sanitized : 'resume'
}

function resumeContentSha256(document: ResumeDocument): string {
  return sha256Text(JSON.stringify({ ...document, approvedAt: null }))
}

export class CareerBackend {
  readonly #runtime = new CodexAppServerRuntime({ clientVersion: app.getVersion() })
  readonly #drafts = new Map<string, StoredDraft>()
  readonly #memoryBlobs = new Map<string, Uint8Array>()
  #statePromise: Promise<BackendState> | null = null
  #operationTail: Promise<void> = Promise.resolve()
  #closing = false
  #closePromise: Promise<void> | null = null

  snapshot(): Promise<DesktopResult<CareerSnapshot>> {
    return this.#serialize(async () => this.#snapshot(await this.#state()))
  }

  initialize(inputValue: unknown): Promise<DesktopResult<CareerSnapshot>> {
    return this.#serialize(async () => {
      const input = initializeSchema.parse(inputValue)
      const state = await this.#state()
      this.#assertVaultReadable(state)
      const existing = state.storage.list('workspace')[0]
      if (existing === undefined) {
        state.application.initializeWorkspace({
          name: `${input.displayName}的职业证据台`,
          locale: 'zh-CN',
          displayName: input.displayName,
          targetRoles: [input.targetRole],
          languages: ['中文'],
          ...(input.location === undefined ? {} : { location: input.location }),
        })
      }
      return this.#snapshot(state)
    })
  }

  importEvidence(): Promise<DesktopResult<ImportEvidenceResult>> {
    return this.#serialize(async () => {
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const e2ePaths = this.#e2eImportPaths()
      const selection =
        e2ePaths === null
          ? await dialog.showOpenDialog({
              title: '导入到本地加密职业档案',
              properties: ['openFile', 'multiSelections'],
              filters: [
                {
                  name: '支持的资料',
                  extensions: ['pdf', 'docx', 'md', 'txt', 'png', 'jpg', 'jpeg'],
                },
              ],
            })
          : { canceled: e2ePaths.length === 0, filePaths: e2ePaths }
      if (selection.canceled) {
        return { items: [], snapshot: this.#snapshot(state) }
      }

      const items: ImportedEvidenceItem[] = []
      for (const filePath of selection.filePaths) {
        items.push(await this.#importOne(state, workspace, filePath))
      }
      return { items, snapshot: this.#snapshot(state) }
    })
  }

  extractFacts(inputValue: unknown): Promise<DesktopResult<CareerSnapshot>> {
    return this.#serialize(async () => {
      const input = extractSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const document = state.storage.get('source_document', input.documentId)
      if (document === undefined || document.workspaceId !== workspace.id) {
        throw new ApplicationError('NOT_FOUND', 'Source document was not found')
      }
      const fragments = state.storage
        .list('document_fragment', workspace.id)
        .filter((fragment) => fragment.documentId === document.id)
      const disclosureContext = fragments.map((fragment) => ({
        id: fragment.id,
        kind: 'source_excerpt' as const,
        content: fragment.text,
        trusted: false,
        aiAllowed: true,
      }))
      const disclosureBytes = measureAiContextBytes(disclosureContext)
      if (
        disclosureContext.length > MAX_AI_CONTEXT_ITEMS ||
        disclosureBytes > MAX_AI_CONTEXT_BYTES
      ) {
        throw new ApplicationError(
          'AI_PAYLOAD_TOO_LARGE',
          'Document extraction exceeds the per-operation AI context budget',
          {
            details: {
              fragmentCount: disclosureContext.length,
              disclosureBytes,
              maxFragments: MAX_AI_CONTEXT_ITEMS,
              maxBytes: MAX_AI_CONTEXT_BYTES,
            },
          },
        )
      }
      await this.#confirmAiDisclosure(
        '从资料中提取候选事实',
        `将发送 ${fragments.length} 个纯文本片段，共 ${fragments.reduce((total, fragment) => total + fragment.text.length, 0)} 个字符。原文件、路径和本地密钥不会发送。`,
      )
      await state.application.proposeFactsForDocument({
        workspaceId: workspace.id,
        documentId: document.id,
        consent: { confirmed: true, dataItemIds: fragments.map((fragment) => fragment.id) },
      })
      return this.#snapshot(state)
    })
  }

  acceptProposal(inputValue: unknown): Promise<DesktopResult<CareerSnapshot>> {
    return this.#serialize(async () => {
      const input = acceptSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      state.application.acceptFactProposal({
        workspaceId: workspace.id,
        proposalId: input.proposalId,
        permissions: {
          aiAllowed: input.aiAllowed,
          resumeAllowed: input.resumeAllowed,
          shareAllowed: false,
        },
        sensitivity: input.sensitivity,
        ...(input.claim === undefined ? {} : { claim: input.claim }),
      })
      return this.#snapshot(state)
    })
  }

  updateFactPermissions(inputValue: unknown): Promise<DesktopResult<CareerSnapshot>> {
    return this.#serialize(async () => {
      const input = updateFactPermissionsSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const fact = state.storage.get('evidence_fact', input.factId)
      if (fact === undefined || fact.workspaceId !== workspace.id || fact.status !== 'verified') {
        throw new ApplicationError('NOT_FOUND', 'Verified fact was not found')
      }
      state.storage.put('evidence_fact', {
        ...fact,
        permissions: {
          ...fact.permissions,
          aiAllowed: input.aiAllowed,
          resumeAllowed: input.resumeAllowed,
        },
        updatedAt: new Date().toISOString(),
      })
      return this.#snapshot(state)
    })
  }

  interview(inputValue: unknown): Promise<DesktopResult<InterviewResult>> {
    return this.#serialize(async () => {
      const input = interviewSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const messages = input.messages.map((message) => ({
        id: randomUUID(),
        role: message.role,
        content: message.content,
        aiAllowed: true,
      }))
      const revisionIds = [...new Set(input.factIds)].map((factId) => {
        const fact = state.storage.get('evidence_fact', factId)
        if (
          fact === undefined ||
          fact.workspaceId !== workspace.id ||
          fact.currentRevisionId === undefined
        ) {
          throw new ApplicationError('NOT_FOUND', 'Interview fact was not found')
        }
        return fact.currentRevisionId
      })
      await this.#confirmAiDisclosure(
        '继续 AI 职业深访',
        `将发送 ${messages.length} 条本轮对话和 ${revisionIds.length} 条已核验事实。AI 只能返回问题与待核验候选，不能直接改写事实库。`,
      )
      const turn = await state.application.nextInterviewQuestion({
        workspaceId: workspace.id,
        factIds: [...new Set(input.factIds)],
        conversationMessages: messages,
        consent: {
          confirmed: true,
          dataItemIds: [...revisionIds, ...messages.map((message) => message.id)],
        },
      })
      return {
        question: turn.question,
        rationale: turn.rationale,
        proposalIds: turn.proposals.map((proposal) => proposal.id),
        snapshot: this.#snapshot(state),
      }
    })
  }

  analyzeJob(inputValue: unknown): Promise<DesktopResult<AnalyzeJobResult>> {
    return this.#serialize(async () => {
      const input = analyzeJobSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const profile = this.#requireProfile(state, workspace.id)
      const contextItemId = randomUUID()
      await this.#confirmAiDisclosure(
        '分析岗位描述',
        `将发送公司、岗位名称和 ${input.description.length} 个字符的岗位描述。不会发送未选中的个人资料。`,
      )
      const analysis = await state.application.decomposeAndCreateJobAnalysis({
        workspaceId: workspace.id,
        source: 'manual',
        companyName: input.company,
        title: input.title,
        description: input.description,
        contextItemId,
        consent: { confirmed: true, dataItemIds: [contextItemId] },
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.salary === undefined ? {} : { salaryText: input.salary }),
      })
      state.application.analyzeEvidenceGap({
        workspaceId: workspace.id,
        profileId: profile.id,
        jobSnapshotId: analysis.snapshot.id,
      })
      const snapshot = this.#snapshot(state)
      const job = snapshot.jobs.find((candidate) => candidate.id === analysis.snapshot.id)
      if (job === undefined) {
        throw new ApplicationError('INTERNAL', 'Job analysis was not persisted')
      }
      return { job, snapshot }
    })
  }

  buildResume(inputValue: unknown): Promise<DesktopResult<BuildResumeResult>> {
    return this.#serialize(async () => {
      const input = buildResumeSchema.parse(inputValue)
      const state = await this.#state()
      return this.#buildResumeFromClaims(state, input, new Map())
    })
  }

  tailorResume(inputValue: unknown): Promise<DesktopResult<BuildResumeResult>> {
    return this.#serialize(async () => {
      const input = buildResumeSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const job = state.storage.get('job_snapshot', input.jobId)
      if (job === undefined || job.workspaceId !== workspace.id) {
        throw new ApplicationError('NOT_FOUND', 'Job not found')
      }
      const revisions = [...new Set(input.factIds)].map((factId) => {
        const fact = state.storage.get('evidence_fact', factId)
        if (
          fact === undefined ||
          fact.workspaceId !== workspace.id ||
          fact.currentRevisionId === undefined
        ) {
          throw new ApplicationError('FACT_NOT_VERIFIED', 'Resume fact is not verified')
        }
        return fact.currentRevisionId
      })
      await this.#confirmAiDisclosure(
        '为当前岗位定制简历表述',
        `将发送 1 份岗位描述和 ${revisions.length} 条你选择的已核验事实。AI 只能提交绑定原事实的改写建议；所有偏离原文的表述都必须逐条由你确认，新数字或日期会直接阻止导出。`,
      )
      const suggestions = await state.application.tailorResumeClaims({
        workspaceId: workspace.id,
        jobSnapshotId: job.id,
        factIds: [...new Set(input.factIds)],
        consent: {
          confirmed: true,
          dataItemIds: [job.id, ...revisions],
        },
      })
      const tailoredByRevisionId = new Map(
        suggestions.map((suggestion) => [suggestion.revisionId, suggestion]),
      )
      return this.#buildResumeFromClaims(state, input, tailoredByRevisionId)
    })
  }

  #buildResumeFromClaims(
    state: BackendState,
    input: ParsedBuildResumeInput,
    tailoredByRevisionId: ReadonlyMap<string, TailoredResumeClaim>,
  ): BuildResumeResult {
    const workspace = this.#requireWorkspace(state)
    const profile = this.#requireProfile(state, workspace.id)
    const job = state.storage.get('job_snapshot', input.jobId)
    if (job === undefined || job.workspaceId !== workspace.id) {
      throw new ApplicationError('NOT_FOUND', 'Job not found')
    }
    const latestReport = state.storage
      .list('match_report', workspace.id)
      .filter((report) => report.jobSnapshotId === job.id)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
    const tailored = tailoredByRevisionId.size > 0
    const claims = [...new Set(input.factIds)].flatMap((factId) => {
      const fact = state.storage.get('evidence_fact', factId)
      if (
        fact === undefined ||
        fact.workspaceId !== workspace.id ||
        fact.status !== 'verified' ||
        fact.currentRevisionId === undefined ||
        !fact.permissions.resumeAllowed
      ) {
        throw new ApplicationError(
          'FACT_NOT_VERIFIED',
          'Resume fact is not verified or is not allowed for resumes',
        )
      }
      const revision = state.storage.get('evidence_revision', fact.currentRevisionId)
      if (revision === undefined || revision.status !== 'verified') {
        throw new ApplicationError('FACT_NOT_VERIFIED', 'Resume revision is not verified')
      }
      const suggestion = tailoredByRevisionId.get(revision.id)
      if (tailored && suggestion === undefined) return []
      const section = sectionForFact(fact.category)
      return [
        {
          sectionKind: section.kind,
          sectionTitle: section.title,
          text: suggestion?.text ?? revision.claim,
          revisionId: revision.id,
          requirementIds:
            suggestion?.requirementIds ??
            latestReport?.assessments
              .filter((assessment) => assessment.revisionIds.includes(revision.id))
              .map((assessment) => assessment.requirementId) ??
            [],
        },
      ]
    })
    if (claims.length === 0) {
      throw new ApplicationError('AI_OUTPUT_INVALID', 'No relevant resume claim was produced')
    }
    const tailoringRationales = Object.fromEntries(
      [...tailoredByRevisionId.values()].map((suggestion) => [
        suggestion.revisionId,
        suggestion.rationale,
      ]),
    )
    const draft = state.application.buildResumeDraft({
      workspaceId: workspace.id,
      profileId: profile.id,
      jobSnapshotId: job.id,
      name: input.name,
      locale: workspace.locale,
      template: input.template,
      links: [],
      claims,
      tailoringRationales,
    })
    this.#drafts.set(draft.version.id, {
      name: input.name,
      jobId: job.id,
      document: draft.document,
      tailoringRationales,
    })
    const snapshot = this.#snapshot(state)
    const summary = snapshot.resumeDrafts.find((item) => item.versionId === draft.version.id)
    if (summary === undefined) {
      throw new ApplicationError('INTERNAL', 'Resume draft was not persisted')
    }
    return { draft: summary, snapshot }
  }

  approveResumeClaim(inputValue: unknown): Promise<DesktopResult<ApproveResumeClaimResult>> {
    return this.#serialize(async () => {
      const input = approveResumeClaimSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const stored = this.#drafts.get(input.versionId)
      if (stored === undefined) throw new ApplicationError('NOT_FOUND', 'Resume draft not found')
      const claim = stored.document.sections
        .flatMap((section) => section.claims)
        .find((candidate) => candidate.id === input.claimId)
      if (claim === undefined) throw new ApplicationError('NOT_FOUND', 'Resume claim not found')
      const revisionId = claim.evidenceRevisionIds[0]
      const revision =
        revisionId === undefined ? undefined : state.storage.get('evidence_revision', revisionId)
      if (revision === undefined || revision.workspaceId !== workspace.id) {
        throw new ApplicationError('FACT_NOT_VERIFIED', 'Verified source fact was not found')
      }
      if (revision.claim === claim.text) {
        throw new ApplicationError('CONFLICT', 'The original verified fact needs no review')
      }

      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: '逐条确认简历事实',
        message: '请仅在这段岗位定制表述完全属实时确认。',
        detail: `原始已核验事实：\n${revision.claim}\n\n待确认的简历表述：\n${claim.text}\n\n点击“我确认完全真实”即表示你已逐字核对雇主、角色、技能、行动、结果、数字和日期。`,
        buttons: ['取消', '我确认完全真实'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) {
        const snapshot = this.#snapshot(state)
        const draft = snapshot.resumeDrafts.find(
          (candidate) => candidate.versionId === input.versionId,
        )
        if (draft === undefined) throw new ApplicationError('INTERNAL', 'Resume draft disappeared')
        return { confirmed: false, draft, snapshot }
      }

      const attested = state.application.attestResumeClaim({
        workspaceId: workspace.id,
        resumeVersionId: input.versionId,
        claimId: claim.id,
        confirmedText: claim.text,
        document: stored.document,
      })
      this.#drafts.set(input.versionId, { ...stored, document: attested.document })
      const snapshot = this.#snapshot(state)
      const draft = snapshot.resumeDrafts.find(
        (candidate) => candidate.versionId === input.versionId,
      )
      if (draft === undefined)
        throw new ApplicationError('INTERNAL', 'Reviewed resume was not found')
      return { confirmed: true, draft, snapshot }
    })
  }

  exportResume(inputValue: unknown): Promise<DesktopResult<ExportResumeResult>> {
    return this.#serialize(async () => {
      const input = exportResumeSchema.parse(inputValue)
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const stored = this.#drafts.get(input.versionId)
      if (stored === undefined) throw new ApplicationError('NOT_FOUND', 'Resume draft not found')
      const filename = `${safeExportBase(stored.name)}.${input.format === 'html' ? 'html' : 'txt'}`
      const destination = await dialog.showSaveDialog({
        title: input.format === 'html' ? '导出可打印简历' : '导出 ATS 纯文本',
        defaultPath: join(app.getPath('documents'), filename),
        filters:
          input.format === 'html'
            ? [{ name: 'HTML 简历', extensions: ['html'] }]
            : [{ name: '纯文本简历', extensions: ['txt'] }],
      })
      if (destination.canceled || destination.filePath === '') {
        return { saved: false, filePath: null, filename }
      }
      const preview = await state.application.validateAndExportResume({
        workspaceId: workspace.id,
        resumeVersionId: input.versionId,
        document: stored.document,
        format: input.format,
        commit: false,
      })
      const committed: ResumeExport = await writeExclusiveCommittedExport({
        destination: destination.filePath,
        bytes: preview.bytes,
        commit: () =>
          state.application.validateAndExportResume({
            workspaceId: workspace.id,
            resumeVersionId: input.versionId,
            document: stored.document,
            format: input.format,
            commit: true,
          }),
      })
      return { saved: true, filePath: destination.filePath, filename: committed.filename }
    })
  }

  exportVault(): Promise<DesktopResult<ExportCareerVaultResult>> {
    return this.#serialize(async () => {
      const state = await this.#state()
      const workspace = this.#requireWorkspace(state)
      const selection = await dialog.showOpenDialog({
        title: '选择个人职业证据库的导出位置',
        properties: ['openDirectory', 'createDirectory'],
      })
      const selectedParent = selection.filePaths[0]
      if (selection.canceled || selectedParent === undefined) {
        return { exported: false, directoryPath: null, documentCount: 0 }
      }
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: '确认导出明文副本',
        message: '导出的 JSON、来源文本和原始资料将不再受 BossHunter 本地密钥保护。',
        detail: '请只保存到你信任的位置。应用不会上传、同步或保留额外导出副本。',
        buttons: ['取消', '确认导出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) {
        return { exported: false, directoryPath: null, documentCount: 0 }
      }

      const exportParent = await realpath(resolve(selectedParent))
      const exportName = `BossHunter-Export-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
      const exportDirectory = this.#verifiedChildPath(exportParent, join(exportParent, exportName))
      const stagingDirectory = this.#verifiedChildPath(
        exportParent,
        join(exportParent, `.${exportName}.partial`),
      )
      const documents = state.storage.list('source_document', workspace.id)
      try {
        await writeAtomicPlaintextDirectoryExport({
          stagingDirectory,
          destinationDirectory: exportDirectory,
          initialWarning:
            '此目录是 BossHunter Next 正在生成的明文副本，可能包含个人职业资料。导出完成前请勿移动；请勿上传到公共仓库或不受信任的网盘。\n',
          finalWarning:
            '此目录是 BossHunter Next 导出的明文副本，包含个人职业资料。请勿上传到公共仓库或不受信任的网盘。\n',
          populate: async (verifiedStagingDirectory) => {
            const documentsDirectory = this.#verifiedChildPath(
              verifiedStagingDirectory,
              join(verifiedStagingDirectory, 'documents'),
            )
            await mkdir(documentsDirectory, { recursive: false, mode: 0o700 })
            const exportedDocuments: Array<Record<string, unknown>> = []
            for (const document of documents) {
              const bytes = await this.#readSourceBytes(state, document)
              const exportedFile = `${document.id.slice(0, 12)}-${safeExportBase(document.originalName)}`
              await writeFile(join(documentsDirectory, exportedFile), bytes, {
                mode: 0o600,
                flag: 'wx',
              })
              exportedDocuments.push({
                id: document.id,
                kind: document.kind,
                originalName: document.originalName,
                mimeType: document.mimeType,
                byteSize: document.byteSize,
                sha256: document.sha256,
                status: document.status,
                pageCount: document.pageCount ?? null,
                requiresOcr: document.requiresOcr,
                importedAt: document.importedAt,
                updatedAt: document.updatedAt,
                exportedFile: `documents/${exportedFile}`,
              })
            }
            const workspaceJobIds = new Set(
              state.storage.list('job_snapshot', workspace.id).map((job) => job.id),
            )
            const exportPayload = {
              format: 'bosshunter-portable-json',
              formatVersion: 1,
              exportedAt: new Date().toISOString(),
              appVersion: app.getVersion(),
              warning: 'This export is plaintext and may contain highly sensitive personal data.',
              records: {
                workspace,
                personProfiles: state.storage.list('person_profile', workspace.id),
                sourceDocuments: exportedDocuments,
                documentFragments: state.storage.list('document_fragment', workspace.id),
                evidenceFacts: state.storage.list('evidence_fact', workspace.id),
                evidenceRevisions: state.storage.list('evidence_revision', workspace.id),
                factProposals: state.storage.list('fact_proposal', workspace.id),
                skillEvidence: state.storage.list('skill_evidence', workspace.id),
                careerPreferences: state.storage.list('career_preference', workspace.id),
                interviewSessions: state.storage.list('interview_session', workspace.id),
                jobSnapshots: state.storage.list('job_snapshot', workspace.id),
                jobRequirements: state.storage.list('job_requirement', workspace.id),
                matchReports: state.storage.list('match_report', workspace.id),
                learningActions: state.storage.list('learning_action', workspace.id),
                resumeProjects: state.storage.list('resume_project', workspace.id),
                resumeVersions: state.storage.list('resume_version', workspace.id),
                resumeClaims: state.storage.list('resume_claim', workspace.id),
                resumeDraftArtifacts: state.storage.list('resume_draft_artifact', workspace.id),
                applications: state.storage.list('application', workspace.id),
                externalActions: state.storage.list('external_action', workspace.id),
                actionAuthorizations: state.storage.list('action_authorization', workspace.id),
                aiRuns: state.storage.list('ai_run', workspace.id),
                consentRecords: state.storage.list('consent_record', workspace.id),
                auditEvents: state.storage.list('audit_event', workspace.id),
                backupManifests: state.storage.list('backup_manifest', workspace.id),
                resumeDraftDocuments: [...this.#drafts.entries()]
                  .filter(([, draft]) => workspaceJobIds.has(draft.jobId))
                  .map(([versionId, draft]) => ({
                    versionId,
                    ...draft,
                  })),
              },
            }
            await writeFile(
              join(verifiedStagingDirectory, 'career-data.json'),
              `${JSON.stringify(exportPayload, null, 2)}\n`,
              { encoding: 'utf8', mode: 0o600, flag: 'wx' },
            )
          },
        })
        return {
          exported: true,
          directoryPath: exportDirectory,
          documentCount: documents.length,
        }
      } catch (error) {
        if (error instanceof ResidualPlaintextExportError) {
          throw new ApplicationError(
            'STORAGE_FAILED',
            'Plaintext export failed and its staging directory could not be removed',
            {
              userMessage: `完整导出失败，且明文暂存目录“${error.stagingDirectory}”无法自动删除。请立即手动删除或妥善保管。`,
              cause: error.cause,
            },
          )
        }
        throw error
      }
    })
  }

  deleteVault(): Promise<DesktopResult<DeleteCareerVaultResult>> {
    return this.#serialize(async () => {
      const state = await this.#state()
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: '删除个人职业证据库',
        message: '永久删除本机的个人资料、事实、岗位和简历版本？',
        detail:
          state.vaultAccess === 'locked'
            ? '系统加密当前不可用，因此无法先生成新的明文导出。这只删除 BossHunter 当前本机库，不会退出 Codex，也不会删除此前导出的文件、系统备份/快照或磁盘历史数据。'
            : '这只删除 BossHunter 当前本机库，不会退出 Codex，也不会删除你此前导出的文件、系统备份/快照或磁盘历史数据。当前库删除后无法恢复；如需保留简历，请先单独导出。',
        buttons: ['取消', '永久删除'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) {
        return {
          deleted: false,
          cleanupPending: false,
          snapshot: this.#snapshot(state),
        }
      }

      const userData = resolve(app.getPath('userData'))
      state.storage.close()
      this.#statePromise = null
      this.#drafts.clear()
      this.#memoryBlobs.clear()
      let cleanupPending = false

      if (state.dataDirectory !== null) {
        const dataDirectory = await this.#verifiedDeletableDirectory(userData, state.dataDirectory)
        if (dataDirectory === null) {
          throw new ApplicationError(
            'STORAGE_FAILED',
            'Career vault directory changed before deletion',
            {
              userMessage:
                '删除未完成：职业库目录在确认后发生变化，系统没有声称删除成功。请重启后核对。',
            },
          )
        }
        const tombstone = this.#verifiedChildPath(
          userData,
          join(userData, `${DELETE_TOMBSTONE_PREFIX}${randomUUID()}`),
        )
        try {
          const deletion = await deleteEncryptedVaultDirectory({
            dataDirectory,
            tombstoneDirectory: tombstone,
            keyFileName: KEY_FILE_NAME,
          })
          cleanupPending = deletion.cleanupPending
        } catch (error) {
          if (error instanceof VaultKeyEraseRestoreError) {
            throw new ApplicationError(
              'STORAGE_FAILED',
              'Could not erase the vault key or restore the original data directory',
              {
                userMessage:
                  '删除未能安全完成，职业库目录也未能自动恢复。请停止使用并从完整导出或备份恢复。',
                cause: error.cause,
              },
            )
          }
          if (error instanceof VaultKeyEraseError) {
            throw new ApplicationError(
              'STORAGE_FAILED',
              'Could not erase the vault key; the original data directory was restored',
              {
                userMessage: '删除未完成，原职业库已安全恢复，资料仍可继续使用。请稍后重试。',
                cause: error.cause,
              },
            )
          }
          throw error
        }
      }

      return {
        deleted: true,
        cleanupPending,
        snapshot: this.#snapshot(await this.#state()),
      }
    })
  }

  codexStatus(): Promise<DesktopResult<CodexStatusSummary>> {
    return this.#serialize(async () => {
      if (IS_E2E) return this.#e2eCodexStatus()
      try {
        const account = await this.#runtime.account()
        return this.#mapCodexStatus(await account.status())
      } catch (error) {
        if (error instanceof AiProviderError) {
          return {
            availability: 'offline',
            authMode: null,
            planType: null,
            message: error.message,
            retryAt: null,
          }
        }
        throw error
      }
    })
  }

  codexLogin(): Promise<DesktopResult<CodexLoginSummary>> {
    return this.#serialize(async () => {
      if (IS_E2E) {
        return {
          started: false,
          openedBrowser: false,
          message: '端到端测试不会触碰真实 Codex 账号。',
        }
      }
      const account = await this.#runtime.account()
      const current = await account.status()
      if (current.availability === 'ready') {
        return { started: false, openedBrowser: false, message: 'Codex 已连接，无需重复登录。' }
      }
      const login = await account.startBrowserLogin()
      if (login.type !== 'chatgpt') {
        return { started: false, openedBrowser: false, message: 'Codex 返回了不兼容的登录方式。' }
      }
      const openedBrowser = await openAllowedExternalUrl(login.authUrl)
      if (!openedBrowser) await account.cancelLogin(login.loginId)
      return {
        started: openedBrowser,
        openedBrowser,
        message: openedBrowser
          ? '已打开 Codex 官方登录页；完成后回到这里刷新状态。'
          : '登录地址未通过外链白名单，已取消本次登录。',
      }
    })
  }

  codexRateLimits(): Promise<DesktopResult<CodexRateLimitSummary>> {
    return this.#serialize(async () => {
      if (IS_E2E) {
        return {
          available: false,
          planType: null,
          primaryUsedPercent: null,
          primaryResetsAt: null,
          secondaryUsedPercent: null,
          secondaryResetsAt: null,
        }
      }
      const limits = (await (await this.#runtime.account()).readRateLimits()).rateLimits
      return {
        available: limits !== null,
        planType: limits?.planType ?? null,
        primaryUsedPercent: limits?.primary?.usedPercent ?? null,
        primaryResetsAt: timestampFromEpoch(limits?.primary?.resetsAt),
        secondaryUsedPercent: limits?.secondary?.usedPercent ?? null,
        secondaryResetsAt: timestampFromEpoch(limits?.secondary?.resetsAt),
      }
    })
  }

  codexLogout(): Promise<DesktopResult<CodexStatusSummary>> {
    return this.#serialize(async () => {
      if (IS_E2E) return this.#e2eCodexStatus()
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: '退出 Codex 账号',
        message: '这会退出本机共享的 Codex 会话，而不只是断开 BossHunter。',
        detail: '其他使用同一 Codex App Server 会话的本机工具可能也需要重新登录。',
        buttons: ['取消', '确认退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) {
        return this.#mapCodexStatus(await (await this.#runtime.account()).status())
      }
      const account = await this.#runtime.account()
      await account.logout()
      return this.#mapCodexStatus(await account.status())
    })
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closing = true
    const acceptedOperations = this.#operationTail
    this.#closePromise = (async () => {
      await acceptedOperations
      await this.#runtime.stop()
      if (this.#statePromise !== null) (await this.#statePromise).storage.close()
      this.#statePromise = null
      this.#drafts.clear()
      this.#memoryBlobs.clear()
    })()
    return this.#closePromise
  }

  #serialize<T>(operation: () => Promise<T> | T): Promise<DesktopResult<T>> {
    if (this.#closing) {
      return result(() => {
        throw new ApplicationError('CONFLICT', 'Career backend is closing', {
          userMessage: '应用正在退出，本次操作没有开始。',
        })
      })
    }
    const execution = this.#operationTail.then(() => result(operation))
    this.#operationTail = execution.then(() => undefined)
    return execution
  }

  async #state(): Promise<BackendState> {
    if (this.#statePromise === null) {
      const opening = this.#openState()
      this.#statePromise = opening
      void opening.catch(() => {
        if (this.#statePromise === opening) this.#statePromise = null
      })
    }
    return this.#statePromise
  }

  async #openState(): Promise<BackendState> {
    const userData = resolve(app.getPath('userData'))
    await mkdir(userData, { recursive: true })
    await this.#cleanupDeletionTombstones(userData)
    const { codec, persistenceMode, vaultAccess, dataDirectory } = await this.#createCodec(userData)
    const storage = SingleWriterStorage.open(
      dataDirectory === null || vaultAccess === 'locked'
        ? ':memory:'
        : join(dataDirectory, DATABASE_FILE_NAME),
      { codec },
    )
    const provider = new CodexProvider(
      async () => {
        if (IS_E2E) {
          return {
            availability: 'offline',
            authMode: null,
            planType: null,
            message: '端到端测试未连接 Codex',
            retryAt: null,
          }
        }
        return (await this.#runtime.account()).status()
      },
      new CodexAppServerRunner(
        async () => this.#runtime.start(),
        join(userData, 'codex-readonly-sandbox'),
      ),
    )
    const application = new CareerApplication({ storage, aiProvider: provider })
    try {
      if (vaultAccess === 'ready') {
        await this.#migrateLegacyDraftSidecar(storage, codec, dataDirectory)
        this.#loadDraftsFromStorage(storage)
        this.#assertDraftIndexConsistent(storage)
        await this.#reconcileSourceBlobs(storage, dataDirectory)
      }
      return { storage, codec, application, persistenceMode, vaultAccess, dataDirectory }
    } catch (error) {
      storage.close()
      throw error
    }
  }

  async #createCodec(userData: string): Promise<{
    codec: SensitiveFieldCodec
    persistenceMode: 'encrypted' | 'memory-only'
    vaultAccess: 'ready' | 'locked'
    dataDirectory: string | null
  }> {
    const requestedDataDirectory = this.#verifiedChildPath(
      userData,
      join(userData, CAREER_DATA_DIRECTORY_NAME),
    )
    const existingDataDirectory = await this.#verifiedDeletableDirectory(
      userData,
      requestedDataDirectory,
    )
    const persistentDataPresent =
      existingDataDirectory !== null && (await readdir(existingDataDirectory)).length > 0
    const openingPolicy = chooseVaultOpeningPolicy({
      encryptionSecure: isHostEncryptionSecure(),
      persistentDataPresent,
    })
    if (openingPolicy === 'locked') {
      if (existingDataDirectory === null) {
        throw new ApplicationError('STORAGE_FAILED', 'Locked vault directory is unavailable')
      }
      return {
        codec: new Aes256GcmCodec(randomBytes(32)),
        persistenceMode: 'encrypted',
        vaultAccess: 'locked',
        dataDirectory: existingDataDirectory,
      }
    }
    if (openingPolicy === 'memory-only') {
      return {
        codec: new Aes256GcmCodec(randomBytes(32)),
        persistenceMode: 'memory-only',
        vaultAccess: 'ready',
        dataDirectory: null,
      }
    }
    await mkdir(requestedDataDirectory, { recursive: true })
    const dataDirectory = await this.#verifiedDeletableDirectory(userData, requestedDataDirectory)
    if (dataDirectory === null) {
      throw new ApplicationError('STORAGE_FAILED', 'Career data directory could not be created')
    }
    const keyPath = this.#verifiedChildPath(dataDirectory, join(dataDirectory, KEY_FILE_NAME))
    let key: Buffer
    try {
      const protectedKey = await readFile(keyPath)
      key = Buffer.from(safeStorage.decryptString(protectedKey), 'base64')
      if (key.byteLength !== 32) {
        throw new ApplicationError('STORAGE_FAILED', 'Invalid vault key length')
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      key = randomBytes(32)
      try {
        await writeFile(keyPath, safeStorage.encryptString(key.toString('base64')), {
          mode: 0o600,
          flag: 'wx',
        })
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
        const protectedKey = await readFile(keyPath)
        key = Buffer.from(safeStorage.decryptString(protectedKey), 'base64')
        if (key.byteLength !== 32) {
          throw new ApplicationError('STORAGE_FAILED', 'Invalid vault key length')
        }
      }
    }
    return {
      codec: new Aes256GcmCodec(key),
      persistenceMode: 'encrypted',
      vaultAccess: 'ready',
      dataDirectory,
    }
  }

  async #importOne(
    state: BackendState,
    workspace: Workspace,
    filePath: string,
  ): Promise<ImportedEvidenceItem> {
    const name = basename(filePath)
    let stagedBlobPath: string | null = null
    let stagedMemoryHash: string | null = null
    let importCommitted = false
    try {
      const bytes = await this.#readSelectedFile(filePath)
      const parsedDocument = await parseDocumentInWorker({
        fileName: name,
        bytes,
        sourcePath: filePath,
        allowedRoot: dirname(filePath),
      })
      const existing = state.storage
        .list('source_document', workspace.id)
        .find((document) => document.sha256 === parsedDocument.contentHash)
      if (existing !== undefined) {
        const fragments = state.storage
          .list('document_fragment', workspace.id)
          .filter((fragment) => fragment.documentId === existing.id)
        return {
          name,
          status: 'imported',
          documentId: existing.id,
          fragmentCount: fragments.length,
          characterCount: fragments.reduce((total, fragment) => total + fragment.text.length, 0),
          message: '相同内容已经在职业档案中，没有重复保存。',
        }
      }

      const now = new Date().toISOString()
      const documentId = randomUUID()
      const storageKey =
        state.persistenceMode === 'encrypted'
          ? join(SOURCE_BLOB_DIRECTORY_NAME, `${parsedDocument.contentHash}.bhenc`).replaceAll(
              '\\',
              '/',
            )
          : `memory:${parsedDocument.contentHash}`
      const pages = parsedDocument.fragments
        .map((fragment) => fragment.page)
        .filter((page): page is number => page !== null)
      const document: SourceDocument = {
        id: documentId,
        workspaceId: workspace.id,
        kind: sourceKind(name),
        originalName: parsedDocument.fileName,
        mimeType: parsedDocument.mimeType,
        byteSize: bytes.byteLength,
        sha256: parsedDocument.contentHash,
        encryptedStorageKey: storageKey,
        status: 'review',
        requiresOcr: false,
        importedAt: now,
        updatedAt: now,
        ...(pages.length === 0 ? {} : { pageCount: Math.max(...pages) }),
      }
      const fragments = parsedDocument.fragments.map((fragment) => ({
        id: fragment.id,
        workspaceId: workspace.id,
        documentId,
        ordinal: fragment.ordinal,
        ...(fragment.page === null ? {} : { page: fragment.page }),
        text: fragment.content,
        sha256: fragment.contentHash,
        createdAt: now,
      }))
      const importInput = ImportParsedDocumentInputSchema.parse({
        workspaceId: workspace.id,
        document,
        fragments,
      })
      if (state.persistenceMode === 'encrypted') {
        if (state.dataDirectory === null) {
          throw new ApplicationError('STORAGE_FAILED', 'Encrypted data directory is unavailable')
        }
        const encryptedBytes = state.codec.encrypt(
          Buffer.from(bytes).toString('base64'),
          `blob:${parsedDocument.contentHash}`,
        )
        const vaultDirectory = join(state.dataDirectory, SOURCE_BLOB_DIRECTORY_NAME)
        await mkdir(vaultDirectory, { recursive: true })
        const verifiedVault = await this.#verifiedDeletableDirectory(
          state.dataDirectory,
          vaultDirectory,
        )
        if (verifiedVault === null) {
          throw new ApplicationError('STORAGE_FAILED', 'Vault directory could not be created')
        }
        const blobPath = this.#verifiedChildPath(
          verifiedVault,
          join(verifiedVault, `${parsedDocument.contentHash}.bhenc`),
        )
        await writeFile(blobPath, encryptedBytes, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        stagedBlobPath = blobPath
      } else {
        this.#memoryBlobs.set(parsedDocument.contentHash, Uint8Array.from(bytes))
        stagedMemoryHash = parsedDocument.contentHash
      }
      state.application.importParsedDocument(importInput)
      importCommitted = true
      return {
        name,
        status: 'imported',
        documentId,
        fragmentCount: fragments.length,
        characterCount: fragments.reduce((total, fragment) => total + fragment.text.length, 0),
        message:
          state.persistenceMode === 'encrypted'
            ? '已在本机解析并加密保存；尚未发送给 AI。'
            : '已在本次运行的临时内存中解析；尚未发送给 AI，退出应用后会丢失。',
      }
    } catch (error) {
      if (!importCommitted) {
        if (stagedMemoryHash !== null) this.#memoryBlobs.delete(stagedMemoryHash)
        if (stagedBlobPath !== null) await unlink(stagedBlobPath).catch(() => undefined)
      }
      const normalized = error instanceof IngestError ? error : null
      return {
        name,
        status: normalized?.code === 'OCR_REQUIRED' ? 'needs_ocr' : 'rejected',
        documentId: null,
        fragmentCount: 0,
        characterCount: 0,
        message: normalized === null ? '资料导入失败，未写入职业档案。' : ingestMessage(normalized),
      }
    }
  }

  async #readSelectedFile(filePath: string): Promise<Buffer> {
    // Windows file identifiers routinely exceed Number.MAX_SAFE_INTEGER. Keep both
    // path and handle metadata as bigint so equivalent inode values cannot be
    // rounded differently. Electron's Windows lstat/fstat report incompatible
    // device ids, so inode remains the stable handle identity there.
    const before = await lstat(filePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new IngestError('UNSUPPORTED_TYPE', 'Selected path is not a regular file')
    }
    if (before.size > BigInt(MAX_IMPORT_BYTES)) {
      throw new IngestError('FILE_TOO_LARGE', 'File exceeds desktop import limit')
    }

    const handle = await open(filePath, 'r')
    try {
      const after = await handle.stat({ bigint: true })
      if (after.size > BigInt(MAX_IMPORT_BYTES) || !isSameOpenedFile(before, after)) {
        throw new IngestError('MAGIC_MISMATCH', 'Selected file changed before it was read')
      }
      const bytes = await handle.readFile()
      const finalMetadata = await handle.stat({ bigint: true })
      if (BigInt(bytes.byteLength) !== after.size || !isSameOpenedFile(after, finalMetadata)) {
        throw new IngestError('MAGIC_MISMATCH', 'Selected file changed while it was read')
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  #snapshot(state: BackendState): CareerSnapshot {
    const workspace = state.storage.list('workspace')[0]
    if (workspace === undefined) {
      return {
        persistenceMode: state.persistenceMode,
        vaultAccess: {
          status: state.vaultAccess,
          message: state.vaultAccess === 'locked' ? LOCKED_VAULT_MESSAGE : null,
        },
        workspace: null,
        sources: [],
        proposals: [],
        facts: [],
        jobs: [],
        resumeDrafts: [],
      }
    }
    const profile = this.#requireProfile(state, workspace.id)
    const revisions = state.storage.list('evidence_revision', workspace.id)
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
    const facts = state.storage
      .list('evidence_fact', workspace.id)
      .filter((fact) => fact.status === 'verified' && fact.currentRevisionId !== undefined)
      .map((fact) => this.#factSummary(fact, revisionById.get(fact.currentRevisionId ?? '')))
      .filter((fact): fact is CareerFactSummary => fact !== null)
    const factIdByRevisionId = new Map(facts.map((fact) => [fact.revisionId, fact.id]))
    const fragments = state.storage.list('document_fragment', workspace.id)
    const requirements = state.storage.list('job_requirement', workspace.id)
    const reports = state.storage.list('match_report', workspace.id)
    const learningActions = state.storage.list('learning_action', workspace.id)
    const jobs = state.storage.list('job_snapshot', workspace.id).map((job) => {
      const latestReport = reports
        .filter((report) => report.jobSnapshotId === job.id)
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
      return this.#jobSummary(
        job,
        requirements.filter((requirement) => requirement.jobSnapshotId === job.id),
        latestReport,
        latestReport === undefined
          ? []
          : learningActions.filter((action) => action.matchReportId === latestReport.id),
        factIdByRevisionId,
      )
    })
    return {
      persistenceMode: state.persistenceMode,
      vaultAccess: { status: 'ready', message: null },
      workspace: {
        id: workspace.id,
        profileId: profile.id,
        name: workspace.name,
        displayName: profile.displayName,
        targetRoles: [...profile.targetRoles],
        locale: workspace.locale,
      },
      sources: state.storage.list('source_document', workspace.id).map((document) => {
        const documentFragments = fragments.filter(
          (fragment) => fragment.documentId === document.id,
        )
        return {
          id: document.id,
          name: document.originalName,
          kind: document.kind,
          mimeType: document.mimeType,
          size: document.byteSize,
          status: document.status,
          requiresOcr: document.requiresOcr,
          importedAt: document.importedAt,
          fragmentCount: documentFragments.length,
          characterCount: documentFragments.reduce(
            (total, fragment) => total + fragment.text.length,
            0,
          ),
        }
      }),
      proposals: state.storage
        .list('fact_proposal', workspace.id)
        .filter((proposal) => proposal.status === 'pending')
        .map((proposal) => ({
          id: proposal.id,
          category: proposal.category,
          title: proposal.title,
          claim: proposal.proposedClaim,
          confidence: proposal.confidence,
          rationale: proposal.rationale ?? null,
          sourceCount: proposal.sources.length,
          sources: proposal.sources.map(sourceLocatorSummary),
        })),
      facts,
      jobs,
      resumeDrafts: [...this.#drafts.entries()]
        .filter(([versionId]) => state.storage.get('resume_version', versionId) !== undefined)
        .map(([versionId, draft]) => this.#draftSummary(state, versionId, draft)),
    }
  }

  #factSummary(
    fact: EvidenceFact,
    revision: EvidenceRevision | undefined,
  ): CareerFactSummary | null {
    if (revision === undefined || revision.status !== 'verified') return null
    return {
      id: fact.id,
      revisionId: revision.id,
      category: fact.category,
      title: fact.title,
      claim: revision.claim,
      sourceCount: revision.sources.length,
      sources: revision.sources.map(sourceLocatorSummary),
      aiAllowed: fact.permissions.aiAllowed,
      resumeAllowed: fact.permissions.resumeAllowed,
      sensitivity: fact.sensitivity,
    }
  }

  #jobSummary(
    job: JobSnapshot,
    requirements: readonly JobRequirement[],
    report: MatchReport | undefined,
    learningActions: readonly LearningAction[],
    factIdByRevisionId: ReadonlyMap<string, string>,
  ): CareerJobSummary {
    const assessmentByRequirement = new Map(
      report?.assessments.map((assessment) => [assessment.requirementId, assessment]) ?? [],
    )
    return {
      id: job.id,
      company: job.companyName,
      title: job.title,
      location: job.location ?? null,
      salary: job.salaryText ?? null,
      source: job.source,
      capturedAt: job.capturedAt,
      evidenceCoverage: report?.evidenceCoverage ?? null,
      requirements: [...requirements]
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            (left.sourceStart ?? Number.MAX_SAFE_INTEGER) -
              (right.sourceStart ?? Number.MAX_SAFE_INTEGER) ||
            left.id.localeCompare(right.id),
        )
        .map((requirement) => {
          const assessment = assessmentByRequirement.get(requirement.id)
          return {
            id: requirement.id,
            text: requirement.text,
            category: requirement.category,
            priority: requirement.priority,
            verdict: assessment?.verdict ?? null,
            explanation: assessment?.explanation ?? null,
            factIds:
              assessment?.revisionIds
                .map((revisionId) => factIdByRevisionId.get(revisionId))
                .filter((factId): factId is string => factId !== undefined) ?? [],
          }
        }),
      learningActions: learningActions.map((action) => ({
        id: action.id,
        title: action.title,
        outcome: action.outcome,
        evidenceToProduce: action.evidenceToProduce,
      })),
    }
  }

  #draftSummary(state: BackendState, versionId: string, draft: StoredDraft): ResumeDraftSummary {
    const version = state.storage.get('resume_version', versionId)
    return {
      versionId,
      jobId: draft.jobId,
      name: draft.name,
      exported: version?.status === 'exported',
      validationValid: version?.validationErrors.length === 0,
      blockingIssues: [...(version?.validationErrors ?? ['未找到简历版本'])],
      atsText: toAtsText(draft.document),
      sections: draft.document.sections.map((section) => ({
        id: section.id,
        kind: section.kind,
        title: section.title,
        claims: section.claims.map((claim) => {
          const revisionId = claim.evidenceRevisionIds[0] ?? ''
          const revision = state.storage.get('evidence_revision', revisionId)
          return {
            id: claim.id,
            text: claim.text,
            revisionId,
            originalText:
              revision !== undefined && revision.claim !== claim.text ? revision.claim : null,
            rationale: draft.tailoringRationales[revisionId] ?? null,
            reviewRequired: revision !== undefined && revision.claim !== claim.text,
            reviewed:
              revision !== undefined &&
              (revision.claim === claim.text ||
                claim.userAttestation?.confirmedText === claim.text),
            reviewedAt:
              claim.userAttestation?.confirmedText === claim.text
                ? claim.userAttestation.confirmedAt
                : null,
          }
        }),
      })),
    }
  }

  #requireWorkspace(state: BackendState): Workspace {
    this.#assertVaultReadable(state)
    const workspace = state.storage.list('workspace')[0]
    if (workspace === undefined) {
      throw new ApplicationError('NOT_FOUND', 'Career workspace has not been initialized', {
        userMessage: '请先创建个人职业档案。',
      })
    }
    return workspace
  }

  #assertVaultReadable(state: BackendState): void {
    if (state.vaultAccess === 'locked') {
      throw new ApplicationError('STORAGE_FAILED', 'Persistent career vault is locked', {
        userMessage: LOCKED_VAULT_MESSAGE,
      })
    }
  }

  #requireProfile(state: BackendState, workspaceId: string): PersonProfile {
    const profile = state.storage.list('person_profile', workspaceId)[0]
    if (profile === undefined) {
      throw new ApplicationError('STORAGE_FAILED', 'Career profile is missing')
    }
    return profile
  }

  #mapCodexStatus(status: {
    availability: string
    authMode: 'chatgpt' | 'api_key' | null
    planType: string | null
    message: string
    retryAt: number | null
  }): CodexStatusSummary {
    const availability =
      status.availability === 'ready' ||
      status.availability === 'auth_required' ||
      status.availability === 'rate_limited'
        ? status.availability
        : 'offline'
    return {
      availability,
      authMode: status.authMode,
      planType: status.planType,
      message: status.message,
      retryAt: status.retryAt === null ? null : timestampFromEpoch(status.retryAt),
    }
  }

  #e2eCodexStatus(): CodexStatusSummary {
    return {
      availability: 'offline',
      authMode: null,
      planType: null,
      message: '端到端测试未连接真实 Codex 账号',
      retryAt: null,
    }
  }

  async #confirmAiDisclosure(title: string, detail: string): Promise<void> {
    if (IS_E2E) {
      throw new ApplicationError('CONSENT_REQUIRED', 'E2E cannot approve real AI processing')
    }
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      title: '确认发送给 Codex',
      message: title,
      detail,
      buttons: ['取消', '同意并发送'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (confirmation.response !== 1) {
      throw new ApplicationError('CONSENT_REQUIRED', 'User cancelled AI disclosure')
    }
  }

  #e2eImportPaths(): string[] | null {
    if (!IS_E2E) return null
    const serialized = process.env.BOSSHUNTER_E2E_IMPORT_PATHS
    if (serialized === undefined) return []
    try {
      const parsed = z.array(z.string().min(1)).max(20).safeParse(JSON.parse(serialized))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  #verifiedChildPath(parent: string, candidate: string): string {
    const resolvedParent = resolve(parent)
    const resolvedCandidate = resolve(candidate)
    const pathFromParent = relative(resolvedParent, resolvedCandidate)
    if (
      pathFromParent.length === 0 ||
      pathFromParent === '..' ||
      pathFromParent.startsWith(`..${sep}`) ||
      isAbsolute(pathFromParent)
    ) {
      throw new ApplicationError('STORAGE_FAILED', 'Refused a path outside its allowed parent')
    }
    return resolvedCandidate
  }

  async #verifiedDeletableDirectory(parent: string, candidate: string): Promise<string | null> {
    const lexicalCandidate = this.#verifiedChildPath(parent, candidate)
    try {
      const metadata = await lstat(lexicalCandidate)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ApplicationError('STORAGE_FAILED', 'Refused to recursively delete a link')
      }
      const realParent = await realpath(parent)
      const realCandidate = await realpath(lexicalCandidate)
      return this.#verifiedChildPath(realParent, realCandidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async #cleanupDeletionTombstones(userData: string): Promise<void> {
    await cleanupEncryptedVaultTombstones({
      parentDirectory: userData,
      tombstonePrefix: DELETE_TOMBSTONE_PREFIX,
      keyFileName: KEY_FILE_NAME,
      verifyDirectory: (parent, candidate) => this.#verifiedDeletableDirectory(parent, candidate),
    })
  }

  async #readSourceBytes(state: BackendState, document: SourceDocument): Promise<Uint8Array> {
    if (document.encryptedStorageKey.startsWith('memory:')) {
      const bytes = this.#memoryBlobs.get(document.sha256)
      if (bytes === undefined) {
        throw new ApplicationError('STORAGE_FAILED', 'In-memory source document is unavailable')
      }
      return Uint8Array.from(bytes)
    }
    if (state.dataDirectory === null) {
      throw new ApplicationError('STORAGE_FAILED', 'Encrypted source directory is unavailable')
    }
    const sourcePath = this.#verifiedChildPath(
      state.dataDirectory,
      join(state.dataDirectory, document.encryptedStorageKey),
    )
    const sourceMetadata = await lstat(sourcePath)
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new ApplicationError('STORAGE_FAILED', 'Source blob is not a regular file')
    }
    const verifiedSourcePath = this.#verifiedChildPath(
      await realpath(state.dataDirectory),
      await realpath(sourcePath),
    )
    const encrypted = await readFile(verifiedSourcePath, 'utf8')
    return Buffer.from(state.codec.decrypt(encrypted, `blob:${document.sha256}`), 'base64')
  }

  async #migrateLegacyDraftSidecar(
    storage: SingleWriterStorage,
    codec: SensitiveFieldCodec,
    dataDirectory: string | null,
  ): Promise<void> {
    if (dataDirectory === null) return
    const versions = storage
      .list('workspace')
      .flatMap((workspace) => storage.list('resume_version', workspace.id))
    if (
      versions.every((version) => storage.get('resume_draft_artifact', version.id) !== undefined)
    ) {
      return
    }

    try {
      const legacyPath = this.#verifiedChildPath(
        dataDirectory,
        join(dataDirectory, DRAFT_FILE_NAME),
      )
      const encrypted = await readFile(legacyPath, 'utf8')
      const parsed = JSON.parse(codec.decrypt(encrypted, 'resume-drafts:v1')) as unknown
      if (!Array.isArray(parsed)) throw new Error('Resume draft index is not an array')
      const legacyDrafts = new Map<
        string,
        StoredDraft & { readonly versionId: string; readonly legacyContentSha256: string }
      >()
      for (const candidate of parsed) {
        if (typeof candidate !== 'object' || candidate === null) {
          throw new Error('Resume draft index contains a non-object entry')
        }
        const value = candidate as Partial<StoredDraft> & { versionId?: unknown }
        if (
          typeof value.versionId !== 'string' ||
          typeof value.name !== 'string' ||
          typeof value.jobId !== 'string'
        ) {
          throw new Error('Resume draft index contains an invalid identity')
        }
        if (typeof value.document !== 'object' || value.document === null) {
          throw new Error('Resume draft index contains an invalid document')
        }
        const legacyContentSha256 = sha256Text(
          JSON.stringify({ ...value.document, approvedAt: null }),
        )
        const document = resumeDocumentSchema.parse(value.document)
        const rationaleEntries =
          typeof value.tailoringRationales === 'object' &&
          value.tailoringRationales !== null &&
          !Array.isArray(value.tailoringRationales)
            ? Object.entries(value.tailoringRationales)
            : []
        const validatedRationales: Array<[string, string]> = []
        for (const [revisionId, rationale] of rationaleEntries) {
          if (typeof rationale !== 'string') {
            throw new Error('Resume draft index contains an invalid rationale')
          }
          validatedRationales.push([revisionId, rationale])
        }
        if (legacyDrafts.has(value.versionId)) {
          throw new Error('Resume draft index contains duplicate versions')
        }
        legacyDrafts.set(value.versionId, {
          versionId: value.versionId,
          name: value.name,
          jobId: value.jobId,
          document,
          legacyContentSha256,
          tailoringRationales: Object.fromEntries(validatedRationales),
        })
      }

      storage.transaction(() => {
        for (const version of versions) {
          if (storage.get('resume_draft_artifact', version.id) !== undefined) continue
          const legacy = legacyDrafts.get(version.id)
          if (
            legacy === undefined ||
            legacy.document.id !== version.id ||
            legacy.document.targetJobSnapshotId !== legacy.jobId ||
            legacy.legacyContentSha256 !== version.contentSha256
          ) {
            throw new Error(`Legacy resume draft ${version.id} does not match its database version`)
          }
          const migratedContentSha256 = resumeContentSha256(legacy.document)
          if (migratedContentSha256 !== version.contentSha256) {
            storage.put('resume_version', {
              ...version,
              contentSha256: migratedContentSha256,
            })
          }
          storage.put('resume_draft_artifact', {
            id: version.id,
            workspaceId: version.workspaceId,
            resumeVersionId: version.id,
            jobSnapshotId: legacy.jobId,
            name: legacy.name,
            documentJson: JSON.stringify(legacy.document),
            contentSha256: migratedContentSha256,
            tailoringRationales: legacy.tailoringRationales,
            createdAt: version.createdAt,
            updatedAt: version.createdAt,
          })
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new ApplicationError('STORAGE_FAILED', 'Legacy resume drafts could not be migrated', {
        userMessage:
          '旧版简历草稿无法安全迁移到加密职业库。为避免静默丢失，应用已停止加载；请从完整导出或备份恢复。',
        cause: error,
      })
    }
  }

  #loadDraftsFromStorage(storage: SingleWriterStorage): void {
    this.#drafts.clear()
    try {
      for (const workspace of storage.list('workspace')) {
        for (const artifact of storage.list('resume_draft_artifact', workspace.id)) {
          const document = resumeDocumentSchema.parse(JSON.parse(artifact.documentJson) as unknown)
          if (this.#drafts.has(artifact.resumeVersionId)) {
            throw new Error(`Duplicate resume draft artifact ${artifact.resumeVersionId}`)
          }
          this.#drafts.set(artifact.resumeVersionId, {
            name: artifact.name,
            jobId: artifact.jobSnapshotId,
            document,
            tailoringRationales: artifact.tailoringRationales,
          })
        }
      }
    } catch (error) {
      this.#drafts.clear()
      throw new ApplicationError('STORAGE_FAILED', 'Resume draft record could not be loaded', {
        userMessage:
          '本机简历草稿记录损坏或无法解密。为避免静默丢失，应用已停止加载职业库；请从完整导出或备份恢复。',
        cause: error,
      })
    }
  }

  async #reconcileSourceBlobs(
    storage: SingleWriterStorage,
    dataDirectory: string | null,
  ): Promise<void> {
    if (dataDirectory === null) return
    const sourceDirectory = await this.#verifiedDeletableDirectory(
      dataDirectory,
      join(dataDirectory, SOURCE_BLOB_DIRECTORY_NAME),
    )
    if (sourceDirectory === null) return
    const referencedNames = new Set<string>()
    for (const workspace of storage.list('workspace')) {
      for (const document of storage.list('source_document', workspace.id)) {
        referencedNames.add(basename(document.encryptedStorageKey))
      }
    }
    try {
      await reconcileEncryptedSourceBlobs({ sourceDirectory, referencedNames })
    } catch (error) {
      if (error instanceof UnsafeSourceBlobEntryError) {
        throw new ApplicationError('STORAGE_FAILED', 'Referenced source blob is not a file', {
          cause: error,
        })
      }
      throw error
    }
  }

  #assertDraftIndexConsistent(storage: SingleWriterStorage): void {
    const expectedVersionIds = new Set<string>()
    let inconsistent = false
    for (const workspace of storage.list('workspace')) {
      for (const version of storage.list('resume_version', workspace.id)) {
        expectedVersionIds.add(version.id)
        const artifact = storage.get('resume_draft_artifact', version.id)
        const project = storage.get('resume_project', version.resumeProjectId)
        const draft = this.#drafts.get(version.id)
        const documentClaimIds =
          draft?.document.sections.flatMap((section) => section.claims.map((claim) => claim.id)) ??
          []
        const expectedClaimIds = new Set(version.claimIds)
        const actualClaimIds = new Set(documentClaimIds)
        if (
          artifact === undefined ||
          project === undefined ||
          draft === undefined ||
          artifact.workspaceId !== workspace.id ||
          artifact.resumeVersionId !== version.id ||
          artifact.contentSha256 !== version.contentSha256 ||
          resumeContentSha256(draft.document) !== version.contentSha256 ||
          artifact.jobSnapshotId !== project.jobSnapshotId ||
          draft.document.id !== version.id ||
          draft.document.targetJobSnapshotId !== artifact.jobSnapshotId ||
          documentClaimIds.length !== version.claimIds.length ||
          expectedClaimIds.size !== actualClaimIds.size ||
          [...expectedClaimIds].some((claimId) => !actualClaimIds.has(claimId)) ||
          version.claimIds.some(
            (claimId) => storage.get('resume_claim', claimId)?.resumeVersionId !== version.id,
          )
        ) {
          inconsistent = true
        }
      }
    }
    const actualVersionIds = new Set(this.#drafts.keys())
    inconsistent ||=
      expectedVersionIds.size !== actualVersionIds.size ||
      [...expectedVersionIds].some((versionId) => !actualVersionIds.has(versionId))
    if (inconsistent) {
      throw new ApplicationError('STORAGE_FAILED', 'Resume draft records are inconsistent', {
        userMessage:
          '简历草稿与职业库版本不一致。为避免静默丢失或错配，应用已停止加载；请从完整导出或备份恢复。',
      })
    }
  }
}
