import { ArrowRight, BriefcaseBusiness, CheckCircle2, CircleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import type { PageKey } from '../store/types'
import { RealOpportunitiesPage } from './RealOpportunitiesPage'

export function OpportunitiesPage({ navigate }: { navigate: (page: PageKey) => void }) {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const [query, setQuery] = useState('')
  const jobs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return workspace.jobs.filter(
      (job) =>
        !needle ||
        `${job.company}${job.title}${job.location}`.toLocaleLowerCase('zh-CN').includes(needle),
    )
  }, [query, workspace.jobs])
  const selected = workspace.jobs.find((job) => job.id === workspace.selectedJobId) ?? jobs[0]

  if (realCareer.mode === 'personal') return <RealOpportunitiesPage navigate={navigate} />

  return (
    <div className="page-stack">
      <PageHeader
        title="岗位机会"
        description="将 JD 拆成要求，再逐项寻找真实证据；这里不展示伪精确的录用概率。"
        actions={
          <Button>
            <BriefcaseBusiness aria-hidden="true" size={18} />
            添加岗位快照
          </Button>
        }
      />

      <div className="opportunity-layout">
        <aside className="opportunity-list" aria-labelledby="opportunity-list-title">
          <h2 id="opportunity-list-title">岗位列表</h2>
          <Field label="搜索岗位">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="公司、职位或城市"
            />
          </Field>
          <div className="opportunity-list__items">
            {jobs.map((job) => {
              const supported = job.requirements.filter(
                (item) => item.coverage === 'supported',
              ).length
              return (
                <button
                  type="button"
                  key={job.id}
                  data-selected={selected?.id === job.id}
                  onClick={() => dispatch({ type: 'setSelectedJob', jobId: job.id })}
                >
                  <span>{job.company}</span>
                  <strong>{job.title}</strong>
                  <small>
                    {job.location} · {supported}/{job.requirements.length} 项有直接证据
                  </small>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="matrix-panel" aria-labelledby="matrix-title">
          {selected ? (
            <>
              <div className="matrix-heading">
                <div>
                  <span>
                    {selected.company} · {selected.location}
                  </span>
                  <h2 id="matrix-title">{selected.title}</h2>
                  <p>
                    {selected.source} · 快照于{' '}
                    {new Date(selected.capturedAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => navigate('resume')}>
                  针对该岗位写简历 <ArrowRight aria-hidden="true" size={18} />
                </Button>
              </div>
              <div className="matrix-legend" aria-label="覆盖状态说明">
                <StatusBadge tone="success">有直接证据</StatusBadge>
                <StatusBadge tone="warning">证据偏弱</StatusBadge>
                <StatusBadge tone="danger">真实缺口</StatusBadge>
              </div>
              <div
                className="evidence-matrix"
                role="table"
                aria-label={`${selected.title} 要求与证据矩阵`}
              >
                <div className="evidence-matrix__header" role="row">
                  <span role="columnheader">岗位要求</span>
                  <span role="columnheader">覆盖</span>
                  <span role="columnheader">依据与下一步</span>
                </div>
                {selected.requirements.map((requirement) => {
                  const facts = workspace.facts.filter((fact) =>
                    requirement.factIds.includes(fact.id),
                  )
                  return (
                    <div className="evidence-matrix__row" role="row" key={requirement.id}>
                      <div role="cell">
                        <strong>{requirement.label}</strong>
                        <span>{requirement.importance === 'required' ? '必备' : '加分项'}</span>
                      </div>
                      <div role="cell">
                        <StatusBadge
                          tone={
                            requirement.coverage === 'supported'
                              ? 'success'
                              : requirement.coverage === 'partial'
                                ? 'warning'
                                : 'danger'
                          }
                        >
                          {requirement.coverage === 'supported'
                            ? '有证据'
                            : requirement.coverage === 'partial'
                              ? '偏弱'
                              : '缺口'}
                        </StatusBadge>
                      </div>
                      <div role="cell">
                        <p>{requirement.rationale}</p>
                        {facts.length ? (
                          <ul>
                            {facts.map((fact) => (
                              <li key={fact.id}>
                                {fact.status === 'verified' ? (
                                  <CheckCircle2 aria-hidden="true" size={15} />
                                ) : (
                                  <CircleAlert aria-hidden="true" size={15} />
                                )}
                                {fact.statement}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <Button
                            size="small"
                            variant="quiet"
                            onClick={() => navigate('interview')}
                          >
                            通过深访寻找相邻证据
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="notice">
                缺口建议只用于学习计划，尚未掌握的技能绝不会写入当前简历。
              </div>
            </>
          ) : (
            <div className="empty-state">
              <BriefcaseBusiness aria-hidden="true" />
              <h2>没有匹配岗位</h2>
              <p>清除搜索或添加一份岗位快照。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
