import { Button, Drawer } from 'antd'
import type { AgentResourceDetail, ResourceReference } from '@shared/workspace'
import { RESOURCE_LABEL, RESOURCE_TARGETS } from './resources'

export interface ResourceViewerState {
  ref: ResourceReference
  detail: AgentResourceDetail
}

export function ResourceDrawer({ viewer, loading, onClose, onLoadMore }: {
  viewer: ResourceViewerState | null
  loading: boolean
  onClose: () => void
  onLoadMore: () => void
}) {
  const target = viewer ? RESOURCE_TARGETS[viewer.ref.kind] : null
  const title = viewer
    ? viewer.ref.title || (RESOURCE_LABEL[viewer.ref.kind] + ' #' + String(viewer.ref.id))
    : '资源详情'

  return (
    <Drawer
      rootClassName="jarvis-resource-drawer"
      title={title}
      open={viewer !== null}
      onClose={onClose}
      width={560}
      getContainer={false}
      extra={viewer && target ? (
        <Button
          size="small"
          onClick={() => {
            onClose()
            window.location.hash = target.route
          }}
        >
          {target.label}
        </Button>
      ) : null}
    >
      {viewer && (
        <div className="jarvis-resource">
          <div className="jarvis-resource-meta">
            <span className="jarvis-resource-kind">
              {RESOURCE_LABEL[viewer.ref.kind]} #{viewer.ref.id}
            </span>
            <span className="jarvis-resource-count">
              共 {viewer.detail.totalChars} 字符 · 已加载 {viewer.detail.content.length}
            </span>
          </div>
          <pre className="jarvis-resource-content">{viewer.detail.content}</pre>
          {viewer.detail.hasMore && (
            <div className="jarvis-resource-more">
              <Button size="small" loading={loading} onClick={onLoadMore}>加载更多</Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}
