import { Database, FilePlus2, FileSearch, FileText, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CareerSourceSummary } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Field, FieldGroup } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useRealCareerStore } from '../store/RealCareerStore'

const sensitivityLabels = {
  standard: '标准',
  sensitive: '敏感',
  highly_sensitive: '高度敏感',
} as const

export function RealProfilePage() {
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const snapshot = realCareer.snapshot
  const [selectedSourceId, setSelectedSourceId] = useState(snapshot?.sources[0]?.id ?? '')
  const [selectedProposalId, setSelectedProposalId] = useState(snapshot?.proposals[0]?.id ?? '')
  const [extractConsentOpen, setExtractConsentOpen] = useState(false)
  const [claim, setClaim] = useState('')
  const [aiAllowed, setAiAllowed] = useState(false)
  const [resumeAllowed, setResumeAllowed] = useState(false)
  const [sensitivity, setSensitivity] = useState<'standard' | 'sensitive' | 'highly_sensitive'>(
    'standard',
  )

  const selectedSource = snapshot?.sources.find((source) => source.id === selectedSourceId) ?? null
  const selectedProposal =
    snapshot?.proposals.find((proposal) => proposal.id === selectedProposalId) ?? null
  const memoryOnly = snapshot?.persistenceMode === 'memory-only'

  useEffect(() => {
    if (!selectedSource && snapshot?.sources[0]) setSelectedSourceId(snapshot.sources[0].id)
  }, [selectedSource, snapshot?.sources])

  useEffect(() => {
    if (!selectedProposal && snapshot?.proposals[0]) {
      setSelectedProposalId(snapshot.proposals[0].id)
      setClaim(snapshot.proposals[0].claim)
      return
    }
    if (selectedProposal) {
      setClaim(selectedProposal.claim)
      setAiAllowed(false)
      setResumeAllowed(false)
      setSensitivity('standard')
    }
  }, [selectedProposal, snapshot?.proposals])

  if (!snapshot?.workspace) return null

  const importEvidence = async () => {
    const result = await realCareer.importEvidence()
    if (!result.ok) return
    if (!result.value.items.length) {
      show('没有选择资料，个人库没有变化。', 'warning')
      return
    }
    const imported = result.value.items.filter((item) => item.status === 'imported').length
    const needsOcr = result.value.items.filter((item) => item.status === 'needs_ocr').length
    const rejected = result.value.items.filter((item) => item.status === 'rejected').length
    show(`已导入 ${imported} 份，待 OCR ${needsOcr} 份，拒绝 ${rejected} 份。资料尚未发送给 AI。`)
  }

  const extract = async () => {
    if (!selectedSource) return
    const result = await realCareer.extractFacts({ documentId: selectedSource.id })
    if (result.ok) {
      setExtractConsentOpen(false)
      show('已生成待核验候选事实。AI 没有直接写入已核验事实。')
    }
  }

  const accept = async () => {
    if (!selectedProposal || !claim.trim()) return
    const result = await realCareer.acceptProposal({
      proposalId: selectedProposal.id,
      claim: claim.trim(),
      aiAllowed,
      resumeAllowed,
      sensitivity,
    })
    if (result.ok) {
      show('候选事实已由你确认为已核验事实。')
      const next = result.value.proposals[0]
      setSelectedProposalId(next?.id ?? '')
      setClaim(next?.claim ?? '')
    }
  }

  const updatePermissions = async (
    factId: string,
    nextAiAllowed: boolean,
    nextResumeAllowed: boolean,
  ) => {
    const result = await realCareer.updateFactPermissions({
      factId,
      aiAllowed: nextAiAllowed,
      resumeAllowed: nextResumeAllowed,
    })
    if (result.ok) {
      show('事实权限已更新；新权限会立即影响后续 AI 与简历操作。')
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="职业档案"
        description="个人库中的资料、待核验候选和已核验事实严格分开。"
        actions={
          <Button onClick={() => void importEvidence()} disabled={realCareer.busy === 'import'}>
            <FilePlus2 aria-hidden="true" size={18} />
            {realCareer.busy === 'import' ? '正在导入…' : '导入真实资料'}
          </Button>
        }
      />

      <div className={memoryOnly ? 'notice notice--danger' : 'notice'}>
        <ShieldCheck aria-hidden="true" size={18} />
        {memoryOnly
          ? '资料只保留在本次运行的内存中，退出后全部丢失；尚未发送给 AI。'
          : '资料导入完成后仍只保存在本机，尚未发送给 AI。只有你在独立确认对话框中同意后，才会提取候选事实。'}
      </div>

      {realCareer.importReport.length ? (
        <section className="plain-section" aria-labelledby="import-report-title">
          <div className="section-heading">
            <div>
              <h2 id="import-report-title">最近导入结果</h2>
              <p>拒绝或需要 OCR 的资料不会被当作可用文本。</p>
            </div>
          </div>
          <ul className="import-report">
            {realCareer.importReport.map((item) => (
              <li key={`${item.name}-${item.documentId ?? item.message}`}>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {memoryOnly && item.status === 'imported'
                      ? '已载入本次运行的内存；退出应用后会丢失。'
                      : item.message}
                  </small>
                </span>
                <StatusBadge
                  tone={
                    item.status === 'imported'
                      ? 'success'
                      : item.status === 'needs_ocr'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {item.status === 'imported'
                    ? '已导入'
                    : item.status === 'needs_ocr'
                      ? '需要 OCR'
                      : '已拒绝'}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="real-profile-grid" aria-label="个人职业库内容">
        <div className="real-source-pane">
          <div className="section-heading">
            <div>
              <h2>原始资料</h2>
              <p>{snapshot.sources.length} 份本机资料</p>
            </div>
          </div>
          <div className="source-choice-list">
            {snapshot.sources.map((source) => (
              <SourceChoice
                key={source.id}
                source={source}
                selected={source.id === selectedSource?.id}
                onSelect={() => setSelectedSourceId(source.id)}
              />
            ))}
            {!snapshot.sources.length ? (
              <div className="empty-state compact">
                <Database aria-hidden="true" />
                <h3>还没有资料</h3>
                <p>导入简历或项目复盘后，再决定是否让 AI 提取。</p>
              </div>
            ) : null}
          </div>
          {selectedSource ? (
            <div className="source-action-panel">
              <dl className="definition-grid">
                <div>
                  <dt>导入状态</dt>
                  <dd>{selectedSource.status}</dd>
                </div>
                <div>
                  <dt>文本规模</dt>
                  <dd>{selectedSource.characterCount.toLocaleString('zh-CN')} 字</dd>
                </div>
              </dl>
              <Button
                variant="secondary"
                disabled={selectedSource.requiresOcr || realCareer.busy === 'extract'}
                onClick={() => setExtractConsentOpen(true)}
              >
                <Sparkles aria-hidden="true" size={17} />
                {selectedSource.requiresOcr ? '先完成 OCR' : '提取候选事实'}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="real-fact-pane">
          <section aria-labelledby="proposal-title">
            <div className="section-heading">
              <div>
                <h2 id="proposal-title">待核验候选</h2>
                <p>{snapshot.proposals.length} 条，尚不是个人事实</p>
              </div>
            </div>
            {selectedProposal ? (
              <div className="proposal-review">
                <div className="proposal-review__heading">
                  <div>
                    <span>{selectedProposal.category}</span>
                    <h3>{selectedProposal.title}</h3>
                  </div>
                  <StatusBadge tone="warning">
                    信心 {Math.round(selectedProposal.confidence * 100)}%
                  </StatusBadge>
                </div>
                <div className="proposal-selector" aria-label="待核验候选列表">
                  {snapshot.proposals.map((proposal) => (
                    <button
                      type="button"
                      key={proposal.id}
                      data-selected={proposal.id === selectedProposal.id}
                      onClick={() => setSelectedProposalId(proposal.id)}
                    >
                      {proposal.claim}
                    </button>
                  ))}
                </div>
                {(selectedProposal.sources ?? []).length ? (
                  <details className="proposal-sources">
                    <summary>查看 {selectedProposal.sources.length} 处原始来源</summary>
                    <ul className="source-list">
                      {(selectedProposal.sources ?? []).map((locator, index) => {
                        const source = snapshot.sources.find(
                          (candidate) => candidate.id === locator.documentId,
                        )
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
                    </ul>
                  </details>
                ) : null}
                <Field
                  label="你确认的表述"
                  required
                  hint="可以改成更精确的句子；不知道的数字应删除。"
                >
                  <textarea
                    value={claim}
                    onChange={(event) => setClaim(event.target.value)}
                    rows={4}
                  />
                </Field>
                <FieldGroup legend="接受后的独立权限">
                  <label className="switch-row">
                    <span>
                      <strong>允许 AI 在深访和分析中使用</strong>
                      <small>关闭后，事实仍保存在本机。</small>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={aiAllowed}
                      onChange={(event) => setAiAllowed(event.target.checked)}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      <strong>允许用于简历</strong>
                      <small>实际构建时仍需选择这条事实。</small>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={resumeAllowed}
                      onChange={(event) => setResumeAllowed(event.target.checked)}
                    />
                  </label>
                </FieldGroup>
                <Field label="敏感级别">
                  <select
                    value={sensitivity}
                    onChange={(event) =>
                      setSensitivity(
                        event.target.value as 'standard' | 'sensitive' | 'highly_sensitive',
                      )
                    }
                  >
                    {Object.entries(sensitivityLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  onClick={() => void accept()}
                  disabled={!claim.trim() || realCareer.busy === 'accept'}
                >
                  <ShieldCheck aria-hidden="true" size={17} />
                  确认为已核验事实
                </Button>
              </div>
            ) : (
              <div className="empty-state compact">
                <FileSearch aria-hidden="true" />
                <h3>没有待核验候选</h3>
                <p>导入资料后，在独立同意对话框中启动提取。</p>
              </div>
            )}
          </section>

          <section className="verified-fact-section" aria-labelledby="verified-real-facts-title">
            <div className="section-heading">
              <div>
                <h2 id="verified-real-facts-title">已核验事实</h2>
                <p>{snapshot.facts.length} 条由你确认的事实；权限可随时独立撤回</p>
              </div>
            </div>
            <ul className="verified-fact-list">
              {snapshot.facts.map((fact) => (
                <li key={fact.id}>
                  <ShieldCheck aria-hidden="true" size={18} />
                  <div>
                    <strong>{fact.claim}</strong>
                    <span>
                      {fact.category} · {sensitivityLabels[fact.sensitivity]} · {fact.sourceCount}{' '}
                      个来源
                    </span>
                    {(fact.sources ?? []).length ? (
                      <small>
                        {(fact.sources ?? [])
                          .map(
                            (locator) =>
                              snapshot.sources.find((source) => source.id === locator.documentId)
                                ?.name ?? '原始资料',
                          )
                          .join('、')}
                      </small>
                    ) : null}
                  </div>
                  <div className="fact-permission-controls" aria-label={`${fact.title}的使用权限`}>
                    <label>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`${fact.title}：允许 AI 使用`}
                        checked={fact.aiAllowed}
                        disabled={realCareer.busy === 'update-permissions'}
                        onChange={(event) =>
                          void updatePermissions(fact.id, event.target.checked, fact.resumeAllowed)
                        }
                      />
                      <span>{fact.aiAllowed ? 'AI 可用' : 'AI 禁用'}</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`${fact.title}：允许用于简历`}
                        checked={fact.resumeAllowed}
                        disabled={realCareer.busy === 'update-permissions'}
                        onChange={(event) =>
                          void updatePermissions(fact.id, fact.aiAllowed, event.target.checked)
                        }
                      />
                      <span>{fact.resumeAllowed ? '简历可用' : '简历禁用'}</span>
                    </label>
                  </div>
                </li>
              ))}
              {!snapshot.facts.length ? (
                <li className="empty-state compact">
                  <FileText aria-hidden="true" />
                  <div>
                    <strong>还没有已核验事实</strong>
                    <span>候选事实必须由你亲自接受。</span>
                  </div>
                </li>
              ) : null}
            </ul>
          </section>
        </div>
      </section>

      <Dialog
        open={extractConsentOpen}
        onClose={() => setExtractConsentOpen(false)}
        title="允许 AI 读取这份资料？"
        description={selectedSource?.name ?? '未选择资料'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setExtractConsentOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void extract()} disabled={realCareer.busy === 'extract'}>
              {realCareer.busy === 'extract' ? '正在提取…' : '同意并提取候选事实'}
            </Button>
          </>
        }
      >
        <div className="consent-summary">
          <strong>本次将发送</strong>
          <ul>
            <li>{selectedSource?.fragmentCount ?? 0} 个文本片段</li>
            <li>{selectedSource?.characterCount.toLocaleString('zh-CN') ?? 0} 个字符</li>
            <li>资料名称与类型，用于保留来源关系</li>
          </ul>
          <div className="notice">
            AI 只能生成待核验候选，不能自动创建已核验事实。取消后不会发送任何内容。
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function SourceChoice({
  source,
  selected,
  onSelect,
}: {
  source: CareerSourceSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" data-selected={selected} onClick={onSelect}>
      <FileText aria-hidden="true" size={18} />
      <span>
        <strong>{source.name}</strong>
        <small>
          {source.fragmentCount} 个片段 · {source.requiresOcr ? '需要 OCR' : source.status}
        </small>
      </span>
      <StatusBadge tone={source.requiresOcr ? 'warning' : 'success'}>
        {source.requiresOcr ? '待 OCR' : '已导入'}
      </StatusBadge>
    </button>
  )
}
