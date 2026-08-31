import { FileText, Filter, LockKeyhole, ShieldCheck, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import type { FactStatus } from '../store/types'
import { RealProfilePage } from './RealProfilePage'

const statusLabels: Record<FactStatus, string> = {
  proposed: '待核验',
  verified: '已核验',
  disputed: '有争议',
}

export function ProfilePage() {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const [filter, setFilter] = useState<FactStatus | 'all'>('all')
  const [selectedId, setSelectedId] = useState(workspace.facts[0]?.id ?? '')
  const facts = useMemo(
    () => workspace.facts.filter((fact) => filter === 'all' || fact.status === filter),
    [filter, workspace.facts],
  )
  const selected = workspace.facts.find((fact) => fact.id === selectedId) ?? facts[0]

  if (realCareer.mode === 'personal') return <RealProfilePage />

  const setStatus = (status: FactStatus) => {
    if (!selected) return
    dispatch({ type: 'setFactStatus', factId: selected.id, status })
    show(
      status === 'verified' ? '事实已核验，可以用于简历。' : '事实已标记，相关简历表述将受到限制。',
      status === 'verified' ? 'success' : 'warning',
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="职业档案"
        description="把经历拆成可核验事实；简历只是这些事实针对岗位的一次选择。"
        actions={
          <Button variant="secondary">
            <FileText aria-hidden="true" size={18} />
            管理资料
          </Button>
        }
      />

      <div className="toolbar" aria-label="事实筛选">
        <Filter aria-hidden="true" size={17} />
        {(['all', 'proposed', 'verified', 'disputed'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? '全部事实' : statusLabels[value]}
            <span>
              {value === 'all'
                ? workspace.facts.length
                : workspace.facts.filter((fact) => fact.status === value).length}
            </span>
          </button>
        ))}
      </div>

      <div className="master-detail">
        <section className="fact-list" aria-label="职业事实列表">
          {facts.map((fact) => (
            <button
              type="button"
              className="fact-row"
              data-selected={selected?.id === fact.id}
              key={fact.id}
              onClick={() => setSelectedId(fact.id)}
            >
              <span className="fact-row__icon" data-status={fact.status}>
                {fact.status === 'verified' ? (
                  <ShieldCheck aria-hidden="true" />
                ) : fact.status === 'disputed' ? (
                  <XCircle aria-hidden="true" />
                ) : (
                  <LockKeyhole aria-hidden="true" />
                )}
              </span>
              <span className="fact-row__body">
                <strong>{fact.statement}</strong>
                <small>
                  {fact.category} · 模型信心 {Math.round(fact.confidence * 100)}%
                </small>
              </span>
              <StatusBadge
                tone={
                  fact.status === 'verified'
                    ? 'success'
                    : fact.status === 'disputed'
                      ? 'danger'
                      : 'warning'
                }
              >
                {statusLabels[fact.status]}
              </StatusBadge>
            </button>
          ))}
          {!facts.length ? (
            <div className="empty-state compact">
              <h3>此筛选下没有事实</h3>
              <p>切换筛选或通过深访补充经历。</p>
            </div>
          ) : null}
        </section>

        <aside className="detail-pane" aria-live="polite">
          {selected ? (
            <>
              <div className="detail-pane__heading">
                <div>
                  <span>事实详情</span>
                  <h2>{selected.statement}</h2>
                </div>
                {selected.restricted ? <StatusBadge tone="neutral">私密</StatusBadge> : null}
              </div>
              <p className="detail-copy">{selected.detail}</p>
              <dl className="definition-grid">
                <div>
                  <dt>当前状态</dt>
                  <dd>{statusLabels[selected.status]}</dd>
                </div>
                <div>
                  <dt>模型信心</dt>
                  <dd>{Math.round(selected.confidence * 100)}%</dd>
                </div>
                <div>
                  <dt>可用于简历</dt>
                  <dd>{selected.status === 'verified' && !selected.restricted ? '是' : '否'}</dd>
                </div>
                <div>
                  <dt>来源数量</dt>
                  <dd>{selected.sourceIds.length || '用户确认'}</dd>
                </div>
              </dl>
              <section className="source-block" aria-labelledby="fact-source-title">
                <h3 id="fact-source-title">原始来源</h3>
                <ul>
                  {workspace.sources
                    .filter((source) => selected.sourceIds.includes(source.id))
                    .map((source) => (
                      <li key={source.id}>
                        <FileText aria-hidden="true" size={17} />
                        <span>
                          <strong>{source.name}</strong>
                          <small>等待接入精确页码或段落定位</small>
                        </span>
                      </li>
                    ))}
                  {!selected.sourceIds.length ? (
                    <li>此事实来自用户直接确认，没有上传文件。</li>
                  ) : null}
                </ul>
              </section>
              <div className="detail-actions">
                <Button
                  onClick={() => setStatus('verified')}
                  disabled={selected.status === 'verified'}
                >
                  确认为真实
                </Button>
                <Button variant="secondary" onClick={() => setStatus('disputed')}>
                  标记有争议
                </Button>
              </div>
              <p className="safety-copy">确认代表“这件事真实发生过”，不代表必须写进每一份简历。</p>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
