import { FileText, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useDemoStore } from '../store/DemoStore'
import type { ResumeClaim } from '../store/types'
import { StatusBadge } from './ui/StatusBadge'

export function SourceInspector({ claim }: { claim: ResumeClaim | null }) {
  const { workspace } = useDemoStore()

  if (!claim) {
    return (
      <div className="empty-state compact">
        <FileText aria-hidden="true" size={24} />
        <h3>选择一条简历表述</h3>
        <p>这里会显示它引用的事实、原始资料和风险提示。</p>
      </div>
    )
  }

  const facts = workspace.facts.filter((fact) => claim.sourceFactIds.includes(fact.id))

  return (
    <div className="source-inspector">
      <div className="inspector-summary">
        <span>来源完整度</span>
        <strong>{facts.length ? `${facts.length} 条事实` : '无来源'}</strong>
      </div>
      {!facts.length ? (
        <div className="notice notice--danger">这条表述没有绑定核验事实，不能导出或用于投递。</div>
      ) : null}
      {facts.map((fact) => {
        const sources = workspace.sources.filter((source) => fact.sourceIds.includes(source.id))
        return (
          <section className="evidence-reference" key={fact.id}>
            <div className="evidence-reference__heading">
              {fact.status === 'verified' ? (
                <ShieldCheck aria-hidden="true" size={18} />
              ) : (
                <LockKeyhole aria-hidden="true" size={18} />
              )}
              <strong>{fact.statement}</strong>
            </div>
            <StatusBadge tone={fact.status === 'verified' ? 'success' : 'warning'}>
              {fact.status === 'verified' ? '已核验' : '待核验，暂不可导出'}
            </StatusBadge>
            <p>{fact.detail}</p>
            <ul className="source-list" aria-label="事实来源">
              {sources.length ? (
                sources.map((source) => (
                  <li key={source.id}>
                    <FileText aria-hidden="true" size={15} />
                    {source.name}
                  </li>
                ))
              ) : (
                <li>来自用户直接确认，无上传文件</li>
              )}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
