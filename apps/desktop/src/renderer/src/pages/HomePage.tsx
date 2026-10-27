import { ArrowRight, CheckCircle2, CircleAlert, FileSearch, MessageSquareText } from 'lucide-react'
import { desktopDomainAdapter } from '../domain/desktopDomainAdapter'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import type { PageKey } from '../store/types'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/layout/PageHeader'
import { StatusBadge } from '../components/ui/StatusBadge'

export function HomePage({ navigate }: { navigate: (page: PageKey) => void }) {
  const { workspace } = useDemoStore()
  const realCareer = useRealCareerStore()

  if (realCareer.mode === 'personal' && realCareer.snapshot?.workspace) {
    const snapshot = realCareer.snapshot
    const personalWorkspace = snapshot.workspace!
    const memoryOnly = snapshot.persistenceMode === 'memory-only'
    const nextAction = !snapshot.sources.length
      ? {
          title: '导入一份真实资料',
          detail: '简历、项目复盘或证书都可以；导入不会自动发送给 AI。',
          page: 'profile' as const,
        }
      : snapshot.proposals.length
        ? {
            title: `核验 ${snapshot.proposals.length} 条候选事实`,
            detail: '只有你接受的内容才能用于简历。',
            page: 'profile' as const,
          }
        : !snapshot.jobs.length
          ? {
              title: '添加第一个目标岗位',
              detail: '将 JD 拆为要求，再与已核验事实对照。',
              page: 'opportunities' as const,
            }
          : {
              title: '为目标岗位构建简历草稿',
              detail: '只选用允许进入简历的已核验事实。',
              page: 'resume' as const,
            }
    const blockingCount = snapshot.resumeDrafts.reduce(
      (count, draft) => count + draft.blockingIssues.length,
      0,
    )
    const targetJob = snapshot.jobs[0]

    return (
      <div className="page-stack">
        <PageHeader
          title={`${personalWorkspace.displayName}，今天先完成最重要的一步`}
          description={
            memoryOnly
              ? '这里的数字来自本次运行的临时内存工作区；退出应用后全部丢失。'
              : '这里的数字全部来自个人加密职业库，不使用演示数据或伪录用率。'
          }
        />

        <section className="focus-panel" aria-labelledby="real-focus-title">
          <div>
            <StatusBadge tone="info">真实下一步</StatusBadge>
            <h2 id="real-focus-title">{nextAction.title}</h2>
            <p>{nextAction.detail}</p>
          </div>
          <Button onClick={() => navigate(nextAction.page)}>
            开始处理 <ArrowRight aria-hidden="true" size={18} />
          </Button>
        </section>

        <section aria-labelledby="real-overview-title">
          <div className="section-heading">
            <div>
              <h2 id="real-overview-title">个人库概览</h2>
              <p>每一项都可回到本地资料或你的确认。</p>
            </div>
          </div>
          <dl className="metric-strip">
            <div>
              <dt>已导入资料</dt>
              <dd>{snapshot.sources.length}</dd>
              <span>
                {snapshot.sources.filter((source) => source.requiresOcr).length} 份需要 OCR
              </span>
            </div>
            <div>
              <dt>待核验候选</dt>
              <dd>{snapshot.proposals.length}</dd>
              <span>尚不可用于简历</span>
            </div>
            <div>
              <dt>已核验事实</dt>
              <dd>{snapshot.facts.length}</dd>
              <span>
                {snapshot.facts.filter((fact) => fact.resumeAllowed).length} 条允许用于简历
              </span>
            </div>
            <div>
              <dt>草稿阻断项</dt>
              <dd>{blockingCount}</dd>
              <span>必须处理后才能导出</span>
            </div>
          </dl>
        </section>

        <section className="two-column">
          <div className="plain-section">
            <div className="section-heading">
              <div>
                <h2>个人库边界</h2>
                <p>{memoryOnly ? '本次运行保留' : '本地加密保存'}、AI 允许和简历允许是独立状态。</p>
              </div>
            </div>
            <ul className="action-list">
              <li>
                <CheckCircle2 aria-hidden="true" />
                <div>
                  <strong>
                    {snapshot.facts.filter((fact) => fact.aiAllowed).length} 条事实允许 AI 使用
                  </strong>
                  <span>深访前还会逐次展示实际发送范围</span>
                </div>
                <Button size="small" variant="secondary" onClick={() => navigate('interview')}>
                  查看
                </Button>
              </li>
              <li>
                <FileSearch aria-hidden="true" />
                <div>
                  <strong>{snapshot.resumeDrafts.length} 份岗位简历草稿</strong>
                  <span>导出状态以真实校验结果为准</span>
                </div>
                <Button size="small" variant="secondary" onClick={() => navigate('resume')}>
                  打开
                </Button>
              </li>
            </ul>
          </div>

          <aside className="plain-section" aria-labelledby="real-target-job-title">
            <div className="section-heading">
              <div>
                <h2 id="real-target-job-title">当前目标岗位</h2>
                <p>来自你实际添加的 JD。</p>
              </div>
            </div>
            {targetJob ? (
              <div className="job-snapshot">
                <strong>{targetJob.company}</strong>
                <h3>{targetJob.title}</h3>
                <p>
                  {targetJob.location ?? '地点未填'} · {targetJob.source}
                </p>
                <Button variant="quiet" onClick={() => navigate('opportunities')}>
                  查看真实证据矩阵
                </Button>
              </div>
            ) : (
              <div className="empty-state compact">
                <FileSearch aria-hidden="true" />
                <h3>尚未添加岗位</h3>
                <p>添加 JD 后才会出现要求与证据。</p>
              </div>
            )}
          </aside>
        </section>
      </div>
    )
  }

  const verified = desktopDomainAdapter.verifiedFacts(workspace).length
  const proposed = workspace.facts.filter((fact) => fact.status === 'proposed').length
  const selectedJob = workspace.jobs.find((job) => job.id === workspace.selectedJobId)
  const missing =
    selectedJob?.requirements.filter((item) => item.coverage === 'missing').length ?? 0
  const unsupported = desktopDomainAdapter.unsupportedClaims(workspace).length

  return (
    <div className="page-stack">
      <PageHeader
        title="今天先完成最重要的一步"
        description="职业证据台按真实性与阻塞程度排序，不用从一张空白简历开始。"
      />

      <section className="focus-panel" aria-labelledby="focus-title">
        <div>
          <StatusBadge tone="warning">需要你确认</StatusBadge>
          <h2 id="focus-title">核验“发布流程从 7 步缩短到 4 步”</h2>
          <p>这条成果与目标岗位高度相关，但目前只来自项目复盘中的候选描述。</p>
        </div>
        <Button onClick={() => navigate('profile')}>
          去核验事实 <ArrowRight aria-hidden="true" size={18} />
        </Button>
      </section>

      <section aria-labelledby="overview-title">
        <div className="section-heading">
          <div>
            <h2 id="overview-title">工作区概览</h2>
            <p>数字代表可解释的事实状态，不是录用概率。</p>
          </div>
        </div>
        <dl className="metric-strip">
          <div>
            <dt>已核验事实</dt>
            <dd>{verified}</dd>
            <span>可用于简历</span>
          </div>
          <div>
            <dt>待核验候选</dt>
            <dd>{proposed}</dd>
            <span>需要人工确认</span>
          </div>
          <div>
            <dt>岗位真实缺口</dt>
            <dd>{missing}</dd>
            <span>不会写进当前简历</span>
          </div>
          <div>
            <dt>受限简历表述</dt>
            <dd>{unsupported}</dd>
            <span>导出前必须处理</span>
          </div>
        </dl>
      </section>

      <section className="two-column" aria-labelledby="next-actions-title">
        <div className="plain-section">
          <div className="section-heading">
            <div>
              <h2 id="next-actions-title">下一步行动</h2>
              <p>按依赖顺序排列。</p>
            </div>
          </div>
          <ol className="action-list">
            <li>
              <CircleAlert aria-hidden="true" />
              <div>
                <strong>核验 1 条关键成果</strong>
                <span>决定是否可支撑“洞察落地”要求</span>
              </div>
              <Button size="small" variant="secondary" onClick={() => navigate('profile')}>
                处理
              </Button>
            </li>
            <li>
              <MessageSquareText aria-hidden="true" />
              <div>
                <strong>补充一次困难与取舍</strong>
                <span>让项目经历不再只是职责流水账</span>
              </div>
              <Button size="small" variant="secondary" onClick={() => navigate('interview')}>
                开始深访
              </Button>
            </li>
            <li>
              <FileSearch aria-hidden="true" />
              <div>
                <strong>检查目标岗位简历</strong>
                <span>{unsupported} 条表述引用了待核验事实</span>
              </div>
              <Button size="small" variant="secondary" onClick={() => navigate('resume')}>
                打开
              </Button>
            </li>
          </ol>
        </div>

        <aside className="plain-section" aria-labelledby="job-snapshot-title">
          <div className="section-heading">
            <div>
              <h2 id="job-snapshot-title">当前目标岗位</h2>
              <p>要求与证据的可解释快照。</p>
            </div>
          </div>
          {selectedJob ? (
            <div className="job-snapshot">
              <strong>{selectedJob.company}</strong>
              <h3>{selectedJob.title}</h3>
              <p>
                {selectedJob.location} · {selectedJob.source}
              </p>
              <ul>
                {selectedJob.requirements.slice(0, 3).map((requirement) => (
                  <li key={requirement.id}>
                    {requirement.coverage === 'supported' ? (
                      <CheckCircle2 aria-hidden="true" />
                    ) : (
                      <CircleAlert aria-hidden="true" />
                    )}
                    <span>{requirement.label}</span>
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
                          ? '证据偏弱'
                          : '真实缺口'}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
              <Button variant="quiet" onClick={() => navigate('opportunities')}>
                查看完整证据矩阵
              </Button>
            </div>
          ) : null}
        </aside>
      </section>
    </div>
  )
}
