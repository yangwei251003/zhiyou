import { Download, Eye, FileWarning, PanelRightOpen, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '../components/layout/PageHeader'
import { SourceInspector } from '../components/SourceInspector'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { desktopDomainAdapter } from '../domain/desktopDomainAdapter'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import { RealResumeStudioPage } from './RealResumeStudioPage'

export function ResumeStudioPage() {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const narrowInspector = useMediaQuery('(max-width: 1180px)')
  const [selectedClaimId, setSelectedClaimId] = useState(workspace.resumeClaims[0]?.id ?? '')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [previewMode, setPreviewMode] = useState<'recruiter' | 'ats'>('recruiter')
  const selectedClaim = workspace.resumeClaims.find((claim) => claim.id === selectedClaimId) ?? null
  const selectedJob = workspace.jobs.find((job) => job.id === workspace.selectedJobId)
  const unsupportedIds = useMemo(
    () => new Set(desktopDomainAdapter.unsupportedClaims(workspace).map((claim) => claim.id)),
    [workspace],
  )

  if (realCareer.mode === 'personal') return <RealResumeStudioPage />

  const inspect = (claimId: string) => {
    setSelectedClaimId(claimId)
    if (narrowInspector) setInspectorOpen(true)
  }

  const exportResume = () => {
    if (unsupportedIds.size) {
      show(`仍有 ${unsupportedIds.size} 条表述引用待核验事实，已阻止导出。`, 'warning')
      return
    }
    show('演示版已通过来源检查；真实 PDF/DOCX 导出将在文档引擎接入后启用。')
  }

  return (
    <div className="page-stack resume-page">
      <PageHeader
        title="简历工作室"
        description={
          selectedJob
            ? `正在为 ${selectedJob.company} · ${selectedJob.title} 选择真实证据。`
            : '选择岗位后开始。'
        }
        actions={
          <>
            {narrowInspector ? (
              <Button variant="secondary" onClick={() => setInspectorOpen(true)}>
                <PanelRightOpen aria-hidden="true" size={18} />
                来源检查器
              </Button>
            ) : null}
            <Button onClick={exportResume}>
              <Download aria-hidden="true" size={18} />
              检查并导出
            </Button>
          </>
        }
      />

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
        <span>
          <ShieldCheck aria-hidden="true" size={16} />
          {workspace.resumeClaims.length - unsupportedIds.size}/{workspace.resumeClaims.length}{' '}
          条表述来源可用
        </span>
      </div>

      <div className="resume-workbench" data-inspector-hidden={narrowInspector}>
        <section className="resume-editor" aria-labelledby="resume-editor-title">
          <div className="resume-document">
            <header>
              <div>
                <h2 id="resume-editor-title">林知夏</h2>
                <p>用户研究 / 产品方向 · 上海</p>
              </div>
              <span>内容演示 · 不含真实联系方式</span>
            </header>
            {previewMode === 'recruiter' ? (
              <div className="resume-sections">
                {(['summary', 'experience', 'project', 'skill'] as const).map((section) => {
                  const claims = workspace.resumeClaims.filter((claim) => claim.section === section)
                  if (!claims.length) return null
                  const labels = {
                    summary: '职业概述',
                    experience: '经历',
                    project: '项目',
                    skill: '技能',
                  }
                  return (
                    <section key={section} aria-labelledby={`resume-section-${section}`}>
                      <h3 id={`resume-section-${section}`}>{labels[section]}</h3>
                      {claims.map((claim) => (
                        <div
                          className="claim-editor"
                          data-selected={claim.id === selectedClaimId}
                          data-warning={unsupportedIds.has(claim.id)}
                          key={claim.id}
                        >
                          <label htmlFor={`claim-${claim.id}`}>
                            <span>{claim.included ? '已纳入简历' : '已从本版本排除'}</span>
                            {unsupportedIds.has(claim.id) ? (
                              <StatusBadge tone="warning">待核验来源</StatusBadge>
                            ) : (
                              <StatusBadge tone="success">来源通过</StatusBadge>
                            )}
                          </label>
                          <textarea
                            id={`claim-${claim.id}`}
                            value={claim.text}
                            disabled={!claim.included}
                            onFocus={() => inspect(claim.id)}
                            onChange={(event) =>
                              dispatch({
                                type: 'updateResumeClaim',
                                claimId: claim.id,
                                text: event.target.value,
                              })
                            }
                            rows={section === 'summary' ? 2 : 3}
                          />
                          <div>
                            <Button size="small" variant="quiet" onClick={() => inspect(claim.id)}>
                              查看来源
                            </Button>
                            <Button
                              size="small"
                              variant="quiet"
                              onClick={() =>
                                dispatch({ type: 'toggleResumeClaim', claimId: claim.id })
                              }
                            >
                              {claim.included ? '从本版本排除' : '重新纳入'}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>
                  )
                })}
              </div>
            ) : (
              <pre className="ats-preview" aria-label="ATS 纯文本预览">
                {`林知夏\n用户研究 / 产品方向 · 上海\n\n${workspace.resumeClaims
                  .filter((claim) => claim.included)
                  .map((claim) => `• ${claim.text}`)
                  .join('\n')}`}
              </pre>
            )}
          </div>
        </section>

        {!narrowInspector ? (
          <aside className="inspector-pane" aria-labelledby="inspector-title">
            <div className="section-heading">
              <div>
                <h2 id="inspector-title">来源检查器</h2>
                <p>选中表述后查看事实与原始资料。</p>
              </div>
            </div>
            <SourceInspector claim={selectedClaim} />
          </aside>
        ) : null}
      </div>

      {unsupportedIds.size ? (
        <div className="resume-blocker" role="status">
          <FileWarning aria-hidden="true" size={20} />
          <div>
            <strong>导出已受限</strong>
            <span>{unsupportedIds.size} 条表述引用了待核验事实。核验或排除后才能导出。</span>
          </div>
        </div>
      ) : null}

      <Dialog
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title="来源检查器"
        description="核对当前表述的事实与资料来源"
        variant="drawer"
      >
        <SourceInspector claim={selectedClaim} />
      </Dialog>
    </div>
  )
}
