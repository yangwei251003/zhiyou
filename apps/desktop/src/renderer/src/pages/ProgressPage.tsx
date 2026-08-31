import { ArrowRight, BookOpenCheck, CalendarClock, LockKeyhole } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import type { ApplicationRecord } from '../store/types'

const stageLabels: Record<ApplicationRecord['stage'], string> = {
  analyzed: '已分析',
  tailored: '简历已定制',
  ready: '待人工投递',
  applied: '已投递',
  interview: '面试中',
}

const stageTones: Record<ApplicationRecord['stage'], 'neutral' | 'info' | 'warning' | 'success'> = {
  analyzed: 'neutral',
  tailored: 'info',
  ready: 'warning',
  applied: 'info',
  interview: 'success',
}

export function ProgressPage() {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()

  if (realCareer.mode === 'personal') {
    return (
      <div className="page-stack">
        <PageHeader
          title="求职进展"
          description="平台连接尚未开放；个人工作区不会混入演示申请记录。"
        />
        <section className="unavailable-feature" aria-labelledby="personal-progress-title">
          <LockKeyhole aria-hidden="true" />
          <div>
            <StatusBadge tone="neutral">平台连接未开放</StatusBadge>
            <h2 id="personal-progress-title">当前没有真实申请记录来源</h2>
            <p>
              BossHunter 不会把岗位分析、简历导出或保存草稿误报为“已投递”。后续连接招聘平台时，
              每次外部动作仍需明确授权并返回可核验结果。
            </p>
          </div>
        </section>
      </div>
    )
  }

  const advance = (application: ApplicationRecord) => {
    dispatch({ type: 'advanceApplication', applicationId: application.id })
    show('进展已更新。演示版不会向招聘平台执行任何操作。')
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="求职进展"
        description="记录每次申请的真实状态；外部结果不确定时绝不自动重试。"
        actions={
          <Button variant="secondary">
            <BookOpenCheck aria-hidden="true" size={18} />
            新增申请记录
          </Button>
        }
      />

      <section aria-labelledby="progress-overview-title">
        <div className="section-heading">
          <div>
            <h2 id="progress-overview-title">申请概览</h2>
            <p>仅记录你确认过的状态。</p>
          </div>
        </div>
        <dl className="metric-strip metric-strip--compact">
          <div>
            <dt>进行中</dt>
            <dd>{workspace.applications.length}</dd>
            <span>全部本地记录</span>
          </div>
          <div>
            <dt>待人工投递</dt>
            <dd>{workspace.applications.filter((item) => item.stage === 'ready').length}</dd>
            <span>不会自动发送</span>
          </div>
          <div>
            <dt>面试中</dt>
            <dd>{workspace.applications.filter((item) => item.stage === 'interview').length}</dd>
            <span>可准备面试故事</span>
          </div>
        </dl>
      </section>

      <section className="progress-table-section" aria-labelledby="progress-table-title">
        <div className="section-heading">
          <div>
            <h2 id="progress-table-title">申请记录</h2>
            <p>更新时间与下一步均可追溯。</p>
          </div>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th scope="col">公司与岗位</th>
                <th scope="col">当前阶段</th>
                <th scope="col">最近更新</th>
                <th scope="col">下一步</th>
              </tr>
            </thead>
            <tbody>
              {workspace.applications.map((application) => (
                <tr key={application.id}>
                  <td data-label="公司与岗位">
                    <strong>{application.company}</strong>
                    <span>{application.title}</span>
                  </td>
                  <td data-label="当前阶段">
                    <StatusBadge tone={stageTones[application.stage]}>
                      {stageLabels[application.stage]}
                    </StatusBadge>
                  </td>
                  <td data-label="最近更新">
                    <span className="icon-text">
                      <CalendarClock aria-hidden="true" size={16} />
                      {application.updatedAt}
                    </span>
                  </td>
                  <td data-label="下一步">
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={application.stage === 'interview'}
                      onClick={() => advance(application)}
                    >
                      {application.stage === 'interview' ? '准备面试' : '推进一阶段'}{' '}
                      <ArrowRight aria-hidden="true" size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
