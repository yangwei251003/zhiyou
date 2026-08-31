import {
  ArrowRight,
  BookOpenCheck,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  Plus,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CareerRequirementSummary } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Field } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useRealCareerStore } from '../store/RealCareerStore'
import type { PageKey } from '../store/types'

const verdictPresentation: Record<
  Exclude<CareerRequirementSummary['verdict'], null>,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  supported: { label: '有直接证据', tone: 'success' },
  partial: { label: '部分覆盖', tone: 'warning' },
  gap: { label: '真实缺口', tone: 'danger' },
  unknown: { label: '尚未判断', tone: 'neutral' },
}

export function RealOpportunitiesPage({ navigate }: { navigate: (page: PageKey) => void }) {
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const snapshot = realCareer.snapshot
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(snapshot?.jobs[0]?.id ?? '')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [salary, setSalary] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)

  const jobs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return (snapshot?.jobs ?? []).filter(
      (job) =>
        !needle ||
        `${job.company}${job.title}${job.location ?? ''}`
          .toLocaleLowerCase('zh-CN')
          .includes(needle),
    )
  }, [query, snapshot?.jobs])
  const selected = snapshot?.jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null

  useEffect(() => {
    if (!selectedId && snapshot?.jobs[0]) setSelectedId(snapshot.jobs[0].id)
  }, [selectedId, snapshot?.jobs])

  if (!snapshot?.workspace) return null

  const resetForm = () => {
    setCompany('')
    setTitle('')
    setDescription('')
    setLocation('')
    setSalary('')
    setSubmitAttempted(false)
  }

  const analyze = async () => {
    setSubmitAttempted(true)
    if (!company.trim() || !title.trim() || description.trim().length < 20) return
    const result = await realCareer.analyzeJob({
      company: company.trim(),
      title: title.trim(),
      description: description.trim(),
      ...(location.trim() ? { location: location.trim() } : {}),
      ...(salary.trim() ? { salary: salary.trim() } : {}),
    })
    if (!result.ok) return
    setSelectedId(result.value.job.id)
    setDialogOpen(false)
    resetForm()
    show('岗位描述已拆成要求、证据判断和学习行动。未知项没有被伪装成缺口。')
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="岗位机会"
        description="粘贴真实 JD，逐项对照已核验事实；不计算伪精确的录用概率。"
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden="true" size={18} />
            新增岗位 JD
          </Button>
        }
      />

      <div className="opportunity-layout">
        <aside className="opportunity-list" aria-labelledby="real-opportunity-list-title">
          <h2 id="real-opportunity-list-title">岗位列表</h2>
          <Field label="搜索岗位">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="公司、职位或城市"
            />
          </Field>
          <div className="opportunity-list__items">
            {jobs.map((job) => (
              <button
                type="button"
                key={job.id}
                data-selected={selected?.id === job.id}
                onClick={() => setSelectedId(job.id)}
              >
                <span>{job.company}</span>
                <strong>{job.title}</strong>
                <small>
                  {job.location ?? '地点未提供'} ·{' '}
                  {job.evidenceCoverage === null
                    ? '覆盖待分析'
                    : `证据覆盖 ${job.evidenceCoverage}%`}
                </small>
              </button>
            ))}
            {!jobs.length ? (
              <div className="empty-state compact">
                <BriefcaseBusiness aria-hidden="true" />
                <h3>{snapshot.jobs.length ? '没有匹配岗位' : '还没有岗位'}</h3>
                <p>{snapshot.jobs.length ? '清除搜索词重试。' : '添加 JD 后才能生成证据矩阵。'}</p>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="matrix-panel" aria-labelledby="real-matrix-title">
          {selected ? (
            <>
              <div className="matrix-heading">
                <div>
                  <span>
                    {selected.company} · {selected.location ?? '地点未提供'}
                  </span>
                  <h2 id="real-matrix-title">{selected.title}</h2>
                  <p>
                    {selected.source} · {new Date(selected.capturedAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => navigate('resume')}>
                  针对该岗位写简历 <ArrowRight aria-hidden="true" size={18} />
                </Button>
              </div>
              <div className="matrix-legend" aria-label="覆盖状态说明">
                {Object.values(verdictPresentation).map((item) => (
                  <StatusBadge tone={item.tone} key={item.label}>
                    {item.label}
                  </StatusBadge>
                ))}
              </div>
              <div
                className="evidence-matrix"
                role="table"
                aria-label={`${selected.title} 要求与证据矩阵`}
              >
                <div className="evidence-matrix__header" role="row">
                  <span role="columnheader">岗位要求</span>
                  <span role="columnheader">判断</span>
                  <span role="columnheader">依据</span>
                </div>
                {selected.requirements.map((requirement) => {
                  const presentation = requirement.verdict
                    ? verdictPresentation[requirement.verdict]
                    : { label: '尚未分析', tone: 'neutral' as const }
                  const facts = snapshot.facts.filter((fact) =>
                    requirement.factIds.includes(fact.id),
                  )
                  return (
                    <div className="evidence-matrix__row" role="row" key={requirement.id}>
                      <div role="cell">
                        <strong>{requirement.text}</strong>
                        <span>
                          {requirement.category} · 优先级 {requirement.priority}/5
                        </span>
                      </div>
                      <div role="cell">
                        <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
                      </div>
                      <div role="cell">
                        <p>{requirement.explanation ?? '当前没有足够信息作出判断。'}</p>
                        {facts.length ? (
                          <ul>
                            {facts.map((fact) => (
                              <li key={fact.id}>
                                <CheckCircle2 aria-hidden="true" size={15} />
                                {fact.claim}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="unknown-copy">
                            <CircleAlert aria-hidden="true" size={15} />
                            没有绑定核验事实
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <section className="learning-actions" aria-labelledby="learning-actions-title">
                <div className="section-heading">
                  <div>
                    <h3 id="learning-actions-title">学习与补证行动</h3>
                    <p>只用于未来成长，不会写进当前简历。</p>
                  </div>
                </div>
                <ol>
                  {selected.learningActions.map((action) => (
                    <li key={action.id}>
                      <BookOpenCheck aria-hidden="true" size={18} />
                      <div>
                        <strong>{action.title}</strong>
                        <p>{action.outcome}</p>
                        <span>可产出证据：{action.evidenceToProduce}</span>
                      </div>
                    </li>
                  ))}
                  {!selected.learningActions.length ? <li>当前没有建议的学习行动。</li> : null}
                </ol>
              </section>
            </>
          ) : (
            <div className="empty-state">
              <BriefcaseBusiness aria-hidden="true" />
              <h2 id="real-matrix-title">添加第一份岗位 JD</h2>
              <p>系统会明确区分“有证据”“部分覆盖”“未知”和“真实缺口”。</p>
              <Button onClick={() => setDialogOpen(true)}>新增岗位 JD</Button>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="新增岗位 JD"
        description="岗位内容将交给已连接的 Codex 分析；不会执行投递或访问招聘平台。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void analyze()} disabled={realCareer.busy === 'analyze-job'}>
              {realCareer.busy === 'analyze-job' ? '正在分析…' : '确认发送并分析'}
            </Button>
          </>
        }
      >
        <div className="dialog-form-stack">
          <Field
            label="公司"
            required
            {...(submitAttempted && !company.trim() ? { error: '请输入公司。' } : {})}
          >
            <input
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              maxLength={240}
            />
          </Field>
          <Field
            label="岗位名称"
            required
            {...(submitAttempted && !title.trim() ? { error: '请输入岗位名称。' } : {})}
          >
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={240}
            />
          </Field>
          <div className="form-grid-two">
            <Field label="地点（选填）">
              <input value={location} onChange={(event) => setLocation(event.target.value)} />
            </Field>
            <Field label="薪资（选填）">
              <input value={salary} onChange={(event) => setSalary(event.target.value)} />
            </Field>
          </div>
          <Field
            label="完整岗位描述"
            required
            hint="本次会发送公司、岗位名和下面的完整 JD。"
            {...(submitAttempted && description.trim().length < 20
              ? { error: '至少输入 20 个字符。' }
              : {})}
          >
            <textarea
              rows={10}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={50_000}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  )
}
