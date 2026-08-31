import {
  BookOpenCheck,
  BriefcaseBusiness,
  FileCheck2,
  Gauge,
  Inbox,
  MessageSquareText,
  Settings2,
  UserRoundSearch,
  type LucideIcon,
} from 'lucide-react'
import type { PageKey } from '../../store/types'

export interface NavigationItem {
  key: PageKey
  label: string
  shortLabel: string
  icon: LucideIcon
}

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { key: 'home', label: '首页', shortLabel: '首页', icon: Gauge },
  { key: 'profile', label: '职业档案', shortLabel: '档案', icon: UserRoundSearch },
  { key: 'interview', label: 'AI 深访', shortLabel: '深访', icon: MessageSquareText },
  { key: 'opportunities', label: '岗位机会', shortLabel: '岗位', icon: BriefcaseBusiness },
  { key: 'resume', label: '简历工作室', shortLabel: '简历', icon: FileCheck2 },
  { key: 'progress', label: '求职进展', shortLabel: '进展', icon: BookOpenCheck },
  { key: 'inbox', label: 'HR 收件箱', shortLabel: '收件箱', icon: Inbox },
  { key: 'settings', label: '连接与隐私', shortLabel: '设置', icon: Settings2 },
]

export function Navigation({
  activePage,
  collapsed = false,
  onNavigate,
}: {
  activePage: PageKey
  collapsed?: boolean
  onNavigate: (page: PageKey) => void
}) {
  return (
    <nav aria-label="主导航" className="primary-navigation">
      {NAVIGATION_ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <button
            type="button"
            key={item.key}
            aria-current={activePage === item.key ? 'page' : undefined}
            aria-label={collapsed ? item.label : undefined}
            title={collapsed ? item.label : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
            {collapsed ? null : <span>{item.label}</span>}
          </button>
        )
      })}
    </nav>
  )
}
