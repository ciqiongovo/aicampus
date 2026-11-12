import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, Button, Dropdown, Slider, Spin, Tag } from 'antd'
import { DownOutlined, FontSizeOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { MAIL_PARENT_LABELS } from '@shared/mailTags'
import {
  DEFAULT_FEEDBACK_SENSITIVITY,
  isFeedbackSensitivityLevel
} from '@shared/panel'
import type { FeedbackSensitivityLevel, PanelKeywordProfile } from '@shared/panel'
import { FeedbackSensitivityMenu } from './feedbackSensitivityMenu'
import { KeywordProfileEditor } from './keywordProfileEditor'
import type { KeywordView } from './keywordProfileEditor'
import './tagPreferences.css'

const dimensions = MAIL_PARENT_LABELS
const initialWeights = (): Record<string, number> => Object.fromEntries(dimensions.map((d) => [d.id, 5]))
const clamp = (value: number): number => Math.max(0, Math.min(10, Math.round(value)))
const KEYWORD_VIEW_KEY = 'infoagent.keywordView'

function readKeywordView(): KeywordView {
  return localStorage.getItem(KEYWORD_VIEW_KEY) === 'list' ? 'list' : 'cloud'
}

function Radar({ weights }: { weights: Record<string, number> }) {
  const cx = 150, cy = 130, radius = 92
  const point = (index: number, scale: number): string => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / dimensions.length
    return [cx + Math.cos(angle) * radius * scale, cy + Math.sin(angle) * radius * scale].map((n) => n.toFixed(1)).join(',')
  }
  const polygon = (scale: number): string => dimensions.map((_, i) => point(i, scale)).join(' ')
  const colors = ['#E11D48', '#EA580C', '#B45309', '#059669', '#0891B2', '#4F46E5', '#9333EA', '#DB2777']
  return <div className="interest-radar"><svg viewBox="0 0 300 270" role="img" aria-label="八维关心程度雷达图">
    {[0.25, 0.5, 0.75, 1].map((level) => <polygon key={level} points={polygon(level)} fill="none" style={{ stroke: 'var(--line-soft)' }} />)}
    {dimensions.map((d, i) => <g key={d.id}>
      <line x1={cx} y1={cy} x2={point(i, 1).split(',')[0]} y2={point(i, 1).split(',')[1]} stroke="var(--line-soft)" />
      <text x={point(i, 1.12).split(',')[0]} y={point(i, 1.12).split(',')[1]} textAnchor="middle" dominantBaseline="middle" fill={colors[i]} fontSize="9" fontWeight="600">{d.name}</text>
    </g>)}
    <polygon points={dimensions.map((d, i) => point(i, (weights[d.id] ?? 5) / 10)).join(' ')} fill="#818cf844" stroke="#6366f1" strokeWidth="2" />
    {dimensions.map((d, i) => <circle key={d.id} cx={point(i, (weights[d.id] ?? 5) / 10).split(',')[0]} cy={point(i, (weights[d.id] ?? 5) / 10).split(',')[1]} r="3" fill={colors[i]} />)}
  </svg></div>
}

export function TagPreferencesEditor() {
  const { message } = AntApp.useApp()
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights)
  const [radarSensitivity, setRadarSensitivity] = useState<FeedbackSensitivityLevel>(DEFAULT_FEEDBACK_SENSITIVITY)
  const [keywordSensitivity, setKeywordSensitivity] = useState<FeedbackSensitivityLevel>(DEFAULT_FEEDBACK_SENSITIVITY)
  const [keywords, setKeywords] = useState<PanelKeywordProfile[]>([])
  const [keywordView, setKeywordView] = useState<KeywordView>(readKeywordView)
  const [keywordLoading, setKeywordLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadKeywords = useCallback(async (): Promise<void> => {
    setKeywordLoading(true)
    try {
      setKeywords(await window.api.panelKeywordProfile(200))
    } catch (error) {
      message.error('读取关键词画像失败：' + String(error))
    } finally {
      setKeywordLoading(false)
    }
  }, [message])

  const load = useCallback(async () => {
    try {
      const [preferences, settings] = await Promise.all([
        window.api.tagPreferencesGet(),
        window.api.settingsGet()
      ])
      setWeights({ ...initialWeights(), ...preferences.parentWeights })
      setRadarSensitivity(
        isFeedbackSensitivityLevel(settings.radarSensitivity)
          ? settings.radarSensitivity
          : DEFAULT_FEEDBACK_SENSITIVITY
      )
      setKeywordSensitivity(
        isFeedbackSensitivityLevel(settings.keywordSensitivity)
          ? settings.keywordSensitivity
          : DEFAULT_FEEDBACK_SENSITIVITY
      )
    } catch (error) {
      message.error('读取关心设置失败：' + String(error))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
    void loadKeywords()
  }, [load, loadKeywords])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = Object.fromEntries(dimensions.map((d) => [d.id, clamp(weights[d.id] ?? 5)]))
      await window.api.tagPreferencesSet(next)
      await window.api.settingsSet({ radarSensitivity, keywordSensitivity })
      message.success('关心设置已保存；灵敏度只影响之后的新反馈')
    } catch (error) {
      message.error('保存关心设置失败：' + String(error))
    } finally {
      setSaving(false)
    }
  }

  const changeKeywordView = (next: KeywordView): void => {
    setKeywordView(next)
    localStorage.setItem(KEYWORD_VIEW_KEY, next)
  }

  if (loading) return <Spin tip="正在读取关心设置"><div className="interest-loading" /></Spin>

  return <div className="interest-editor">
    <div className="interest-intro">调整每个维度的关心程度（0–10）；雷达图实时预览。灵敏度在两张卡片右上角单独调节。</div>

    <section className="interest-section" aria-labelledby="interest-radar-title">
      <div className="interest-section-head">
        <div><strong id="interest-radar-title">关心雷达</strong><span>8 个维度 · 每维 0–10</span></div>
        <FeedbackSensitivityMenu kind="radar" value={radarSensitivity} onChange={setRadarSensitivity} showLabel />
      </div>
      <p className="interest-section-desc">面板处置与邮件 A/B/C/D 评级会改变这 8 个维度的权重；灵敏度决定单条反馈改变多少。</p>
      <div className="interest-radar-layout">
        <Radar weights={weights} />
        <div className="interest-controls">{dimensions.map((d) => <div className="interest-row" key={d.id}>
          <div className="interest-name"><strong>{d.name}</strong><Tag>{weights[d.id] ?? 5}/10</Tag></div>
          <Slider min={0} max={10} value={weights[d.id] ?? 5} onChange={(value) => setWeights((w) => ({ ...w, [d.id]: value }))} aria-label={d.name + '关心分值'} />
        </div>)}</div>
      </div>
    </section>

    <section className="interest-section" aria-labelledby="interest-keyword-title">
      <div className="interest-section-head">
        <div className="interest-keyword-heading">
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'cloud', icon: <FontSizeOutlined />, label: '字号混排' },
                { key: 'list', icon: <UnorderedListOutlined />, label: '列表' }
              ],
              selectedKeys: [keywordView],
              onClick: ({ key }) => changeKeywordView(key === 'list' ? 'list' : 'cloud')
            }}
          >
            <Button size="small" type="text" className="interest-view-trigger">
              {keywordView === 'cloud' ? <FontSizeOutlined /> : <UnorderedListOutlined />}
              <span>{keywordView === 'cloud' ? '字号混排' : '列表'}</span>
              <DownOutlined className="interest-view-caret" />
            </Button>
          </Dropdown>
          <strong id="interest-keyword-title">关键词画像</strong>
          <span>全局 · 邮件与 QQ 共用 · {keywordLoading ? '读取中…' : `${keywords.length} 个`}</span>
        </div>
        <span className="interest-head-actions">
          <Button size="small" loading={keywordLoading} onClick={() => void loadKeywords()}>刷新</Button>
          <FeedbackSensitivityMenu kind="keyword" value={keywordSensitivity} onChange={setKeywordSensitivity} showLabel />
        </span>
      </div>
      <p className="interest-section-desc">词云仅用黑色文字，按权重大小排布；列表用单行长条显示权重。点击词可编辑，列表中还可删除。</p>
      <KeywordProfileEditor items={keywords} loading={keywordLoading} view={keywordView} onChanged={setKeywords} />
    </section>

    <div className="interest-actions">
      <Button type="primary" loading={saving} onClick={() => void save()}>保存关心设置</Button>
    </div>
  </div>
}
