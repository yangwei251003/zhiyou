import { Download, Eye, FileText, FileWarning, PanelRightOpen, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ResumeDraftSummary } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Field, FieldGroup } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useRealCareerStore } from '../store/RealCareerStore'

const templateLabels = {
  ats_single_column: 'ATS 单栏',
  professional: '专业经历',
  campus_project: '校园项目',
} as const

const sensitivityLabels = {
  standard: '标准',
  sensitive: '敏感',
  highly_sensitive: '高度敏感',
} as const

export function RealResumeStudioPage() {
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const snapshot = realCareer.snapshot
  const narrowInspector = useMediaQuery('(max-width: 1180px)')
  const localEligibleFacts = useMemo(
    () => snapshot?.facts.filter((fact) => fact.resumeAllowed) ?? [],
    [snapshot?.facts],
  )
  const [jobId, setJobId] = useState(snapshot?.jobs[0]?.id ?? '')
  const [factIds, setFactIds] = useState<string[]>([])
  const [resumeName, setResumeName] = useState('岗位定制简历')
  const [template, setTemplate] = useState<keyof typeof templateLabels>('ats_single_column')
  const [draftVersionId, setDraftVersionId] = useState(snapshot?.resumeDrafts[0]?.versionId ?? '')
  const [selectedClaimId, setSelectedClaimId] = useState('')
  const [previewMode, setPreviewMode] = useState<'recruiter' | 'ats'>('recruiter')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [buildConsentOpen, setBuildConsentOpen] = useState(false)
  const [lastExport, setLastExport] = useState<string | null>(null)

  const selectedJob = snapshot?.jobs.find((job) => job.id === jobId) ?? null
  const selectedDraft =
    snapshot?.resumeDrafts.find((draft) => draft.versionId === draftVersionId) ??
    snapshot?.resumeDrafts.find((draft) => draft.jobId === jobId) ??
    null
  const claims = selectedDraft?.sections.flatMap((section) => section.claims) ?? []
  const selectedClaim = claims.find((claim) => claim.id === selectedClaimId) ?? claims[0] ?? null
  const selectedCodexFacts = useMemo(
    () => localEligibleFacts.filter((fact) => factIds.includes(fact.id) && fact.aiAllowed),
    [factIds, localEligibleFacts],
  )
  const excludedFromCodexCount = factIds.length - selectedCodexFacts.length

  useEffect(() => {
    if (!jobId && snapshot?.jobs[0]) setJobId(snapshot.jobs[0].id)
  }, [jobId, snapshot?.jobs])

  useEffect(() => {
    if (!draftVersionId && snapshot?.resumeDrafts[0]) {
      setDraftVersionId(snapshot.resumeDrafts[0].versionId)
    }
  }, [draftVersionId, snapshot?.resumeDrafts])

  useEffect(() => {
    if (selectedDraft && !selectedClaimId) {
      setSelectedClaimId(selectedDraft.sections[0]?.claims[0]?.id ?? '')
    }
  }, [selectedClaimId, selectedDraft])

  useEffect(() => {
    const allowedIds = new Set(localEligibleFacts.map((fact) => fact.id))
    setFactIds((current) => {
      const next = current.filter((factId) => allowedIds.has(factId))
      return next.length === current.length ? current : next
    })
  }, [localEligibleFacts])

  if (!snapshot?.workspace) return null

  const toggleFact = (factId: string) => {
    setFactIds((current) =>
      current.includes(factId)
        ? current.filter((candidate) => candidate !== factId)
        : [...current, factId],
    )
  }

  const build = async (mode: 'local' | 'tailored') => {
    const submittedFactIds =
      mode === 'tailored' ? selectedCodexFacts.map((fact) => fact.id) : factIds
    if (!jobId || !submittedFactIds.length || !resumeName.trim()) return
    const input = {
      jobId,
      factIds: submittedFactIds,
      name: resumeName.trim(),
      template,
    }
    const result =
      mode === 'tailored'
        ? await realCareer.tailorResume(input)
        : await realCareer.buildResume(input)
    if (!result.ok) return
    setLastExport(null)
    setDraftVersionId(result.value.draft.versionId)
    setSelectedClaimId(result.value.draft.sections[0]?.claims[0]?.id ?? '')
    setBuildConsentOpen(false)
    show(
      result.value.draft.validationValid
        ? mode === 'tailored'
          ? '已生成岗位定制版本，未产生需要逐条确认的偏离改写。'
          : '已在本机生成可追溯基础版本，未调用 AI。'
        : `已生成草稿，但有 ${result.value.draft.blockingIssues.length} 项真实阻断。`,
      result.value.draft.validationValid ? 'success' : 'warning',
    )
  }

  const exportDraft = async (format: 'html' | 'text') => {
    if (!selectedDraft?.validationValid) {
      show('当前版本未通过来源检查，不能导出。', 'warning')
      return
    }
    const result = await realCareer.exportResume({ versionId: selectedDraft.versionId, format })
    if (!result.ok) return
    if (!result.value.saved) {
      setLastExport(null)
      show('已取消保存，没有产生导出文件。', 'warning')
      return
    }
    setLastExport(result.value.filePath ?? result.value.filename)
    show(`已导出 ${result.value.filename}。`)
  }

  const inspect = (claimId: string) => {
    setSelectedClaimId(claimId)
    if (narrowInspector) setInspectorOpen(true)
  }

  return (
    <div className="page-stack resume-page">
      <PageHeader
        title="简历工作室"
        description="用岗位与已核验事实生成不可变版本；导出前必须通过真实来源检查。"
        actions={
          narrowInspector ? (
            <Button
              variant="secondary"
              onClick={() => setInspectorOpen(true)}
              disabled={!selectedDraft}
            >
              <PanelRightOpen aria-hidden="true" size={18} />
              来源检查器
            </Button>
          ) : null
        }
      />

      <section className="resume-builder" aria-labelledby="resume-builder-title">
        <div className="section-heading">
          <div>
            <h2 id="resume-builder-title">生成岗位版本</h2>
            <p>本机基础版不发送任何事实；Codex 定制只发送同时允许 AI 与简历使用的已选事实。</p>
          </div>
        </div>
        <div className="resume-builder-grid">
          <Field label="目标岗位" required>
            <select
              value={jobId}
              onChange={(event) => {
                const nextJobId = event.target.value
                setJobId(nextJobId)
                setDraftVersionId(
                  snapshot.resumeDrafts.find((draft) => draft.jobId === nextJobId)?.versionId ?? '',
                )
                setSelectedClaimId('')
              }}
            >
              <option value="">请选择</option>
              {snapshot.jobs.map((job) => (
                <option value={job.id} key={job.id}>
                  {job.company} · {job.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="版本名称" required>
            <input value={resumeName} onChange={(event) => setResumeName(event.target.value)} />
          </Field>
          <Field label="版式">
            <select
              value={template}
              onChange={(event) => setTemplate(event.target.value as keyof typeof templateLabels)}
            >
              {Object.entries(templateLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <FieldGroup legend={`选择简历事实（已选 ${factIds.length} 条）`}>
          <div className="resume-fact-picker">
            {localEligibleFacts.map((fact) => (
              <label className="check-row" key={fact.id}>
                <input
                  type="checkbox"
                  checked={factIds.includes(fact.id)}
                  onChange={() => toggleFact(fact.id)}
                />
                <span>
                  <strong>{fact.title}</strong>
                  <small>{fact.claim}</small>
                  <small>
                    {fact.aiAllowed ? 'Codex 可用' : '仅本机基础版'} ·{' '}
                    {sensitivityLabels[fact.sensitivity]}
                  </small>
                </span>
              </label>
            ))}
            {!localEligibleFacts.length ? (
              <div className="empty-state compact">
                <FileText aria-hidden="true" />
                <h3>没有可用于简历的事实</h3>
                <p>请先在职业档案中核验并授权至少一条事实。</p>
              </div>
            ) : null}
          </div>
        </FieldGroup>
        <div className="resume-builder-actions">
          <span>
            本机基础版使用 {factIds.length} 条已选事实，不会调用 AI。Codex 定制将发送岗位描述和{' '}
            {selectedCodexFacts.length} 条双重授权事实
            {excludedFromCodexCount > 0
              ? `；已排除 ${excludedFromCodexCount} 条未允许 AI 使用的已选事实`
              : ''}
            。
          </span>
          <div>
            <Button
              variant="secondary"
              onClick={() => void build('local')}
              disabled={
                !jobId ||
                !factIds.length ||
                !resumeName.trim() ||
                realCareer.busy === 'build-resume'
              }
            >
              <ShieldCheck aria-hidden="true" size={18} />
              仅用原事实生成
            </Button>
            <Button
              onClick={() => setBuildConsentOpen(true)}
              disabled={
                !jobId ||
                !selectedCodexFacts.length ||
                !resumeName.trim() ||
                realCareer.codexStatus?.availability !== 'ready' ||
                realCareer.busy === 'tailor-resume'
              }
            >
              用 Codex 定制草稿
            </Button>
          </div>
        </div>
        {realCareer.codexStatus?.availability !== 'ready' ? (
          <p className="safety-copy">Codex 当前不可用，仍可生成不调用 AI 的本机基础版。</p>
        ) : null}
      </section>

      {snapshot.resumeDrafts.length ? (
        <div className="resume-version-picker">
          <Field label="查看简历版本">
            <select
              value={selectedDraft?.versionId ?? ''}
              onChange={(event) => {
                const nextVersionId = event.target.value
                const nextDraft = snapshot.resumeDrafts.find(
                  (draft) => draft.versionId === nextVersionId,
                )
                setDraftVersionId(nextVersionId)
                if (nextDraft) setJobId(nextDraft.jobId)
                setSelectedClaimId('')
                setLastExport(null)
              }}
            >
              {snapshot.resumeDrafts.map((draft) => (
                <option value={draft.versionId} key={draft.versionId}>
                  {draft.name} · {draft.validationValid ? '可导出' : '有阻断'}
                  {draft.exported ? ' · 已导出过' : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}

      {selectedDraft ? (
        <>
          <div className="resume-toolbar">
            <div role="group" aria-label="简历查看模式">
              <button
                type="button"
                aria-pressed={previewMode === 'recruiter'}
                onClick={() => setPreviewMode('recruiter')}
              >
                <Eye aria-hidden="true" size={16} />
                招聘者阅读
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'ats'}
                onClick={() => setPreviewMode('ats')}
              >
                ATS 纯文本
              </button>
            </div>
            <span data-valid={selectedDraft.validationValid}>
              <ShieldCheck aria-hidden="true" size={16} />
              {selectedDraft.validationValid
                ? '来源检查通过'
                : `${selectedDraft.blockingIssues.length} 项阻断`}
            </span>
          </div>

          <div className="resume-workbench" data-inspector-hidden={narrowInspector}>
            <section className="resume-editor" aria-labelledby="real-resume-title">
              <div className="resume-document">
                <header>
                  <div>
                    <h2 id="real-resume-title">{snapshot.workspace.displayName}</h2>
                    <p>
                      {selectedJob
                        ? `${selectedJob.company} · ${selectedJob.title}`
                        : '岗位定制版本'}
                    </p>
                  </div>
                  <span>{selectedDraft.name} · 内容锁定版本</span>
                </header>
                {previewMode === 'recruiter' ? (
                  <div className="resume-sections">
                    {selectedDraft.sections.map((section) => (
                      <section
                        key={section.id}
                        aria-labelledby={`real-resume-section-${section.id}`}
                      >
                        <h3 id={`real-resume-section-${section.id}`}>{section.title}</h3>
                        {section.claims.map((claim) => (
                          <button
                            className="real-resume-claim"
                            type="button"
                            data-selected={selectedClaim?.id === claim.id}
                            key={claim.id}
                            onClick={() => inspect(claim.id)}
                          >
                            <span>{claim.text}</span>
                            <small>
                              {claim.reviewRequired
                                ? claim.reviewed
                                  ? '已确认真实'
                                  : '待逐条确认真实'
                                : '查看原始事实'}
                            </small>
                          </button>
                        ))}
                      </section>
                    ))}
                  </div>
                ) : (
                  <pre className="ats-preview" aria-label="ATS 纯文本预览">
                    {selectedDraft.atsText}
                  </pre>
                )}
              </div>
            </section>
            {!narrowInspector ? (
              <aside className="inspector-pane" aria-labelledby="real-inspector-title">
                <div className="section-heading">
                  <div>
                    <h2 id="real-inspector-title">来源检查器</h2>
                    <p>按事实修订版本定位原始资料。</p>
                  </div>
                </div>
                <RealSourceInspector draft={selectedDraft} claimId={selectedClaim?.id ?? null} />
              </aside>
            ) : null}
          </div>

          {!selectedDraft.validationValid ? (
            <div className="resume-blocker" role="status">
              <FileWarning aria-hidden="true" size={20} />
              <div>
                <strong>导出已阻断</strong>
                <span>{selectedDraft.blockingIssues.join('；') || '版本未通过来源检查。'}</span>
              </div>
            </div>
          ) : (
            <section className="resume-export-bar" aria-label="导出简历">
              <span>
                {selectedDraft.exported
                  ? '此不可变版本已导出过。'
                  : '检查通过，可选择开放格式导出。'}
                {lastExport ? ` 最近保存：${lastExport}` : ''}
              </span>
              <div>
                <Button
                  variant="secondary"
                  onClick={() => void exportDraft('text')}
                  disabled={selectedDraft.exported || realCareer.busy === 'export-resume'}
                >
                  <Download aria-hidden="true" size={17} /> 导出 TXT
                </Button>
                <Button
                  onClick={() => void exportDraft('html')}
                  disabled={selectedDraft.exported || realCareer.busy === 'export-resume'}
                >
                  <Download aria-hidden="true" size={17} /> 导出 HTML
                </Button>
              </div>
            </section>
          )}
        </>
      ) : (
        <div className="empty-state resume-empty-state">
          <FileText aria-hidden="true" />
          <h2>还没有真实简历版本</h2>
          <p>选择岗位和至少一条已核验事实后生成。</p>
        </div>
      )}

      <Dialog
        open={buildConsentOpen}
        onClose={() => setBuildConsentOpen(false)}
        title="确认用 Codex 定制草稿"
        description="主进程还会展示一次原生发送确认；生成后，任何偏离原事实的改写都必须再逐条确认真实。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBuildConsentOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void build('tailored')}
              disabled={realCareer.busy === 'tailor-resume'}
            >
              {realCareer.busy === 'tailor-resume' ? '正在定制…' : '继续至系统确认'}
            </Button>
          </>
        }
      >
        <div className="consent-summary">
          <strong>本次将发送</strong>
          <ul>
            <li>{selectedJob ? `${selectedJob.company} · ${selectedJob.title}` : '未选择岗位'}</li>
            <li>{selectedCodexFacts.length} 条同时允许 AI 与简历使用的事实</li>
            {selectedCodexFacts.map((fact) => (
              <li key={fact.id}>
                {fact.title}：{fact.claim}（{sensitivityLabels[fact.sensitivity]}）
              </li>
            ))}
            {excludedFromCodexCount > 0 ? (
              <li>{excludedFromCodexCount} 条已选事实因未允许 AI 使用而排除</li>
            ) : null}
            <li>不发送未选事实、原始资料全文或本机生成模板</li>
          </ul>
          <small>本机生成设置：{templateLabels[template]}</small>
        </div>
      </Dialog>

      <Dialog
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title="来源检查器"
        description="按事实修订版本定位原始资料"
        variant="drawer"
      >
        <RealSourceInspector draft={selectedDraft} claimId={selectedClaim?.id ?? null} />
      </Dialog>
    </div>
  )
}

function RealSourceInspector({
  draft,
  claimId,
}: {
  draft: ResumeDraftSummary | null
  claimId: string | null
}) {
  const realCareer = useRealCareerStore()
  const { snapshot } = realCareer
  const { show } = useToast()
  const claim = draft?.sections
    .flatMap((section) => section.claims)
    .find((item) => item.id === claimId)
  const fact = snapshot?.facts.find((item) => item.revisionId === claim?.revisionId)

  const approve = async () => {
    if (!draft || !claim) return
    const result = await realCareer.approveResumeClaim({
      versionId: draft.versionId,
      claimId: claim.id,
    })
    if (!result.ok) return
    show(
      result.value.confirmed
        ? '已记录你对这一条精确文字的真实性确认。'
        : '已取消，该表述仍不能导出。',
      result.value.confirmed ? 'success' : 'warning',
    )
  }

  if (!claim) {
    return (
      <div className="empty-state compact">
        <FileText aria-hidden="true" />
        <h3>选择一条简历表述</h3>
        <p>这里会显示核验事实与原始资料定位。</p>
      </div>
    )
  }

  return (
    <div className="source-inspector">
      <div className="inspector-summary">
        <span>来源状态</span>
        <strong>{fact ? '已绑定核验事实' : '缺少事实修订版本'}</strong>
      </div>
      {!fact ? (
        <div className="notice notice--danger">该表述没有可解析的核验事实，不能安全导出。</div>
      ) : null}
      {fact ? (
        <section className="evidence-reference">
          <div className="evidence-reference__heading">
            <ShieldCheck aria-hidden="true" size={18} />
            <strong>{fact.claim}</strong>
          </div>
          <StatusBadge tone="success">已核验 · 修订 {fact.revisionId}</StatusBadge>
          {claim.originalText && claim.originalText !== claim.text ? (
            <div className="tailoring-rationale">
              <strong>原事实表述</strong>
              <p>{claim.originalText}</p>
              <strong>岗位定制建议</strong>
              <p>{claim.text}</p>
              <strong>改写理由</strong>
              <p>{claim.rationale ?? '未提供改写理由。'}</p>
              <div className="notice">
                任何偏离原事实的改写都必须由你逐条确认；新数字或日期即使确认也会继续阻断，应先回事实库更正。
              </div>
              {claim.reviewRequired ? (
                claim.reviewed ? (
                  <StatusBadge tone="success">
                    已逐条确认真实
                    {claim.reviewedAt
                      ? ` · ${new Date(claim.reviewedAt).toLocaleString('zh-CN')}`
                      : ''}
                  </StatusBadge>
                ) : (
                  <Button
                    onClick={() => void approve()}
                    disabled={realCareer.busy === 'approve-resume-claim'}
                  >
                    {realCareer.busy === 'approve-resume-claim'
                      ? '正在等待系统确认…'
                      : '逐条确认此改写完全真实'}
                  </Button>
                )
              ) : null}
            </div>
          ) : null}
          <ul className="source-list" aria-label="原始资料定位">
            {(fact.sources ?? []).map((locator, index) => {
              const source = snapshot?.sources.find((item) => item.id === locator.documentId)
              return (
                <li key={`${locator.documentId}-${locator.fragmentId ?? index}`}>
                  <FileText aria-hidden="true" size={15} />
                  <span>
                    <strong>{source?.name ?? '原始资料'}</strong>
                    <small>
                      {[
                        locator.page ? `第 ${locator.page} 页` : null,
                        locator.section,
                        locator.quote,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '已绑定资料，暂无页码或段落定位'}
                    </small>
                  </span>
                </li>
              )
            })}
            {!(fact.sources ?? []).length ? <li>来自用户直接确认，没有上传资料定位。</li> : null}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
