import { CircleAlert, LoaderCircle, X } from 'lucide-react'
import { useRealCareerStore } from '../store/RealCareerStore'
import { Button } from './ui/Button'

const operationLabels = {
  import: '正在导入资料',
  extract: '正在提取待核验事实',
  accept: '正在保存已核验事实',
  'update-permissions': '正在更新事实权限',
  interview: '正在继续深访',
  'analyze-job': '正在分析岗位要求',
  'build-resume': '正在组装可追溯简历',
  'tailor-resume': '正在按岗位改写简历表述',
  'approve-resume-claim': '正在记录逐条事实确认',
  'export-resume': '正在校验并导出',
  'export-vault': '正在导出个人数据明文副本',
  'delete-vault': '正在永久删除个人职业库',
  'codex-status': '正在刷新 Codex 状态',
  'codex-login': '正在打开 Codex 登录',
  'codex-logout': '正在退出 Codex',
} as const

export function RealOperationBanner() {
  const { busy, error, clearError, snapshot } = useRealCareerStore()

  if (error) {
    return (
      <div className="operation-banner operation-banner--error" role="alert">
        <CircleAlert aria-hidden="true" size={18} />
        <div>
          <strong>{error.code}</strong>
          <span>{error.message}</span>
          <small>{error.retryable ? '可在核对连接或输入后重试。' : '请先解决上述条件。'}</small>
        </div>
        <Button variant="quiet" size="small" aria-label="关闭错误" onClick={clearError}>
          <X aria-hidden="true" size={17} />
        </Button>
      </div>
    )
  }

  if (!busy) return null

  const operationLabel =
    busy === 'initialize'
      ? snapshot?.persistenceMode === 'memory-only'
        ? '正在创建临时内存工作区'
        : '正在创建个人加密工作区'
      : operationLabels[busy]

  return (
    <div className="operation-banner" role="status">
      <LoaderCircle className="spin" aria-hidden="true" size={18} />
      <span>{operationLabel}…</span>
    </div>
  )
}
