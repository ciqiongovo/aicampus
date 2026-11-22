import { useState } from 'react'
import { Modal } from 'antd'
import {
  BookOutlined,
  MailOutlined,
  MessageOutlined,
  RobotOutlined,
  CheckOutlined
} from '@ant-design/icons'
import './onboarding.css'

/** 只认「看过没」这一个状态，不值当为它写一条数据库字段 */
const STORAGE_KEY = 'zhishu:onboarded:v1'

export function hasSeenGuide(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* 隐私模式写不进去就算了，下次再弹一遍不算毛病 */
  }
}

/** 第一步里的示例问题：点一下就能抄进输入框，不用自己想办法开口 */
const EXAMPLES = [
  '这周有哪些学校在办迎新晚会？',
  '去年同类活动都请了什么嘉宾？',
  '我邮件里有哪些还没回的通知？'
]

const SOURCES = [
  {
    icon: <BookOutlined />,
    name: '公众号对标',
    text: '按校名去搜兄弟高校的学生会、团委，把公开推文收进来。要全量就先导出表格再导入。'
  },
  {
    icon: <MailOutlined />,
    name: '邮件',
    text: '收件箱里的通知、邀请、活动预告，同步进本地库，能搜也能让 JARVIS 读。'
  },
  {
    icon: <MessageOutlined />,
    name: 'QQ 群',
    text: '群里贴的活动链接和通知，同样是消息来源，落在面板里一起看。'
  }
]

const STEPS = ['先说话', '消息从哪来', '怎么出成果']

export function OnboardingGuide({
  open,
  onClose,
  onOpenSettings
}: {
  open: boolean
  onClose: () => void
  /** 引导里直接跳去配模型：光说「去设置」等于让人自己找 */
  onOpenSettings?: () => void
}): JSX.Element {
  const [step, setStep] = useState(0)

  const close = (): void => {
    markGuideSeen()
    setStep(0)
    onClose()
  }

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      width={620}
      centered
      destroyOnClose
      className="onb-modal"
      title={null}
    >
      <div className="onb">
        <div className="onb-head">
          <span className="onb-kicker">使用引导 · {step + 1}/{STEPS.length}</span>
          <h2 className="onb-title">{STEPS[step]}</h2>
        </div>

        {step === 0 && (
          <div className="onb-body">
            <p className="onb-lead">
              打开就能直接问。JARVIS 连着你的邮件、待办、日报，也连着别的学校的公众号库，
              它会自己翻，翻完给你一版能用的东西。
            </p>
            <div className="onb-examples">
              {EXAMPLES.map((q) => (
                <div key={q} className="onb-example">
                  <RobotOutlined />
                  <span>{q}</span>
                </div>
              ))}
            </div>
            <p className="onb-note">
              第一次用要先填一个模型服务：点右上角齿轮旁边的「AI 设置」，填服务商、接口地址和 Key。
              {onOpenSettings && (
                <button type="button" className="onb-link" onClick={onOpenSettings}>
                  现在去配
                </button>
              )}
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="onb-body">
            <p className="onb-lead">
              左边的「<b>消息来源</b>」就是全部入口。三个来源收在同一处，不用到处找。
            </p>
            <div className="onb-sources">
              {SOURCES.map((s) => (
                <div key={s.name} className="onb-source">
                  <div className="onb-source-icon">{s.icon}</div>
                  <div>
                    <div className="onb-source-name">{s.name}</div>
                    <div className="onb-source-text">{s.text}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="onb-note">
              以前公众号采集摆在第一页，看着像这个软件只干这一件事。它其实是原料，不是主角。
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="onb-body">
            <div className="onb-flow">
              <div className="onb-flow-item">
                <span className="onb-flow-no">1</span>
                <div>
                  <div className="onb-flow-title">找活动</div>
                  <div className="onb-flow-text">选学校，点「一键采集」，或直接把工具导出的表格导进来。</div>
                </div>
              </div>
              <div className="onb-flow-item">
                <span className="onb-flow-no">2</span>
                <div>
                  <div className="onb-flow-title">采正文</div>
                  <div className="onb-flow-text">要类型、地点、议程这些字段，就点「采集正文」补上。</div>
                </div>
              </div>
              <div className="onb-flow-item">
                <span className="onb-flow-no">3</span>
                <div>
                  <div className="onb-flow-title">出简报</div>
                  <div className="onb-flow-text">勾几篇做对比，或按当前筛选导出一份 HTML 报告。</div>
                </div>
              </div>
            </div>
            <p className="onb-note">
              想省事就跳过中间：直接跟 JARVIS 说「把上海交大这学期的活动整理成表」，它去做。
            </p>
          </div>
        )}

        <div className="onb-foot">
          <div className="onb-dots">
            {STEPS.map((s, i) => (
              <span key={s} className={i === step ? 'onb-dot onb-dot-on' : 'onb-dot'} />
            ))}
          </div>
          <div className="onb-actions">
            {step > 0 && (
              <button type="button" className="onb-btn" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button type="button" className="onb-btn onb-btn-primary" onClick={() => setStep(step + 1)}>
                下一步
              </button>
            ) : (
              <button type="button" className="onb-btn onb-btn-primary" onClick={close}>
                <CheckOutlined /> 开始用
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
