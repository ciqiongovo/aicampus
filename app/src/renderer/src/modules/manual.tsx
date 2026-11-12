import { useMemo, useState } from 'react'
import { Button, Empty, Input, Tag } from 'antd'
import { ArrowRightOutlined, BookOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { MANUAL_SECTIONS } from '@shared/manual'
import './manual.css'

/** 设置 > 用户手册：与 JARVIS 注入的是同一份 MANUAL_SECTIONS。 */
export function ManualPane(): JSX.Element {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  const sections = useMemo(() => {
    if (!keyword) return MANUAL_SECTIONS
    return MANUAL_SECTIONS.map((section) => {
      const titleHit = `${section.title} ${section.intro}`.toLowerCase().includes(keyword)
      return {
        ...section,
        items: titleHit
          ? section.items
          : section.items.filter((item) => `${item.title} ${item.text}`.toLowerCase().includes(keyword))
      }
    }).filter((section) => section.items.length > 0)
  }, [keyword])
  const total = MANUAL_SECTIONS.reduce((sum, section) => sum + section.items.length, 0)

  return <div className="manual-page">
    <header className="manual-hero">
      <div>
        <div className="manual-overline"><BookOutlined /> 用户手册</div>
        <h2>每个功能的入口与用法</h2>
        <p>按板块整理，保持简短。不想翻页时，直接把问题发给 JARVIS：它读过同一份手册。</p>
      </div>
      <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate('/jarvis')}>去问 JARVIS</Button>
    </header>

    <div className="manual-tools">
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder={`搜索 ${total} 条功能说明，例如“灵敏度”“继续阅读”`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="搜索用户手册"
      />
      <span>{keyword ? `找到 ${sections.reduce((sum, section) => sum + section.items.length, 0)} 条` : `${MANUAL_SECTIONS.length} 个板块 · ${total} 条`}</span>
    </div>

    <div className={`manual-layout${keyword ? ' is-search' : ''}`}>
      {keyword ? null : <nav className="manual-toc" aria-label="手册目录">
        {MANUAL_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => document.getElementById(`manual-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {section.title}
          </button>
        ))}
      </nav>}

      <div className="manual-sections">
        {sections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的说明，换个词试试，或直接问 JARVIS" />
        ) : sections.map((section) => (
          <section className="manual-section" id={`manual-${section.id}`} key={section.id}>
            <div className="manual-section-head">
              <h3>{section.title}</h3>
              <Tag bordered={false}>{section.items.length} 条</Tag>
            </div>
            <p className="manual-intro">{section.intro}</p>
            <div className="manual-items">
              {section.items.map((item) => (
                <article className="manual-item" key={`${section.id}-${item.title}`}>
                  <h4>{item.title}</h4>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        ))}
        {keyword && sections.length > 0 && <p className="manual-foot">没找到的内容可以直接问 JARVIS，它会按当前应用能力回答。</p>}
      </div>
    </div>
  </div>
}
