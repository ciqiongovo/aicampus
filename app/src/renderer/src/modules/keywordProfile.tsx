import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PanelKeywordProfile } from '@shared/panel'
import './keywordProfile.css'

type KeywordTier = 'high' | 'medium' | 'low'

const KEYWORD_TIERS: { key: KeywordTier; label: string }[] = [
  { key: 'high', label: '高关注' },
  { key: 'medium', label: '中关注' },
  { key: 'low', label: '低关注' }
]

/** 全局关键词画像：面板右栏与“设置 > 我的关心”共用同一份数据与分层规则。 */
export function KeywordProfile({
  items,
  variant = 'rail',
  loading = false,
  action = null
}: {
  items: PanelKeywordProfile[] | undefined
  variant?: 'rail' | 'settings'
  loading?: boolean
  /** 右栏卡片右上角的操作（反馈灵敏度菜单）；设置页不需要。 */
  action?: ReactNode
}): JSX.Element {
  const ranked = useMemo(() => [...(items ?? [])].sort((a, b) => b.weight - a.weight), [items])
  const highest = ranked.reduce((max, item) => Math.max(max, Number.isFinite(item.weight) ? item.weight : 0), 0)
  const groups = KEYWORD_TIERS.map((tier) => ({
    ...tier,
    items: ranked.filter((item) => {
      const weight = Number.isFinite(item.weight) ? Math.max(0, item.weight) : 0
      const level: KeywordTier = highest === 0 || weight < highest / 3
        ? 'low'
        : weight < highest * 2 / 3
          ? 'medium'
          : 'high'
      return level === tier.key
    })
  })).filter((group) => group.items.length > 0)

  return (
    <section className={`kwp-card kwp-card-${variant}`} aria-label="全局关键词画像">
      {variant === 'rail' && (
        <div className="kwp-head">
          <span>关键词画像</span>
          {action ? <span className="kwp-head-tail">{action}</span> : null}
        </div>
      )}
      {loading ? (
        <p className="kwp-quiet">正在读取关键词画像…</p>
      ) : ranked.length === 0 ? (
        <p className="kwp-quiet">还没有关键词线索。处理邮件或 QQ 结论后，这里会逐渐形成你的关注画像。</p>
      ) : (
        <div className="kwp-groups">
          {groups.map((group) => (
            <div className={`kwp-group kwp-${group.key}`} key={group.key}>
              <div className="kwp-tier-head">
                <strong>{group.label}</strong>
              </div>
              <ul className="kwp-list">
                {group.items.map((item, index) => {
                  const weight = Number.isFinite(item.weight) ? item.weight : 0
                  const label = `权重 ${weight.toFixed(1)}`
                  return (
                    <li className="kwp-item" key={`${item.keyword}-${index}`}>
                      <span className="kwp-name" title={item.keyword}>{item.keyword}</span>
                      <span className="kwp-weight" title={label}>{weight.toFixed(1)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
