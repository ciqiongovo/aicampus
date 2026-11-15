# 知枢 · 桌面端

高校公众号活动对标与决策支持。界面由模块注册表驱动，第一条是「公众号」，往后依次是
面板、日报、邮件、待办、日程、资料、设置。

技术栈：Electron 44 + React 18 + TypeScript + electron-vite + Ant Design 5，
数据库是 Node 内置的 `node:sqlite`（`DatabaseSync`），不依赖任何原生扩展。

产品说明与使用方式见仓库根目录的 [`../README.md`](../README.md)。

## 开发

```bash
npm install
npm run dev             # 开发模式（热更新）
npm run typecheck       # 主进程与界面两端类型检查
npm test                # 单元测试
npm run build           # 构建到 out/
npm run dist            # 打包 NSIS 安装程序 + 便携版
npm run dist:portable   # 只打便携版 exe（release/ZhiShu-<版本>-portable.exe）
```

Windows 上也有两个双击就能用的脚本：`启动知枢.bat`（选开发/启动/重建）与
`打包知枢.bat`（构建并打包，末尾打印 SHA-256）。

## 目录

```
src/main/          主进程：窗口、托盘、IPC、数据库与业务服务
  services/benchmark/    公众号采集、学校判定、字段抽取、简报生成
  db/                    建表与迁移（benchmarkSchema.ts 是版本数组）
  brand.ts               应用名与数据目录的唯一出处
src/preload/       contextBridge 白名单 API
src/renderer/      React 界面（modules/registry.tsx 决定导航顺序）
src/shared/        前后端共享类型、IPC 通道常量、学校清单
tests/             单元测试
resources/         图标、托盘图，以及 bench-seeds.json（随包带的样本链接）
tools/bench/       命令行工具（与界面共用同一套 DAO 与判定逻辑）
```

## 数据放在哪

`%APPDATA%\ZhiShu\zhishu.db`（macOS 是 `~/Library/Application Support/ZhiShu/`）。
目录名用英文而不是中文：这个路径会进 spawn 参数和 SQLite 连接串，中文在某些环节会出事。

第一次启动时，如果发现旧版 `InfoAgent/infoagent.db`，会用 `VACUUM INTO` 把整库搬过来一次。
用 `VACUUM INTO` 而不是复制文件，是因为 WAL 里可能还有没落盘的写入，拷主库文件会丢最后几条。
搬完不动旧库，删不删由用户决定。

**换版本不会丢数据**：数据库在 userData 里，跟程序目录分离；便携版 exe 换成新的一扔就行。

## 采集三条硬约束

写在这里是因为踩过，改代码前先看一眼。

1. **账号名必须加引号。** 查询是 `site:mp.weixin.qq.com "上海科技大学学生会"`。
   不加引号会被拆成三个词做与匹配，返回的全是别校的「学生会」稿子——实测 25 篇里只有 4 篇对。
2. **配额是硬的。** 一个出口 IP 连查 4–5 次就触发验证码。所以每个账号之间停 3.5–6.5 秒，
   连续两次被拦立刻停手，一次最多查五六个账号。别为了「快一点」把间隔改小。
3. **正文必须真渲染。** 公众号页面是 JS 外壳，直接拿源码是空的。主进程开隐藏窗口渲染，
   兜底用外部浏览器 `--headless=new --dump-dom`。

去重键是 `__biz + mid + idx`（`articleUrlKey()`），必须保留 `chksm`，否则同一篇会因为
分享来源不同被当成两篇。

## 抽取两套链路

- **规则**（`rule-extract.ts`）：不需要任何 key，装完即用。够拿到类型、时间、地点、主办。
- **模型**（`extractor.ts`）：配了 API key 后多出议程、特色环节、规模、可迁移性和依据。
  提示词里明确要求「特色环节与议程不重复」「规模只写原文数字，不换算」。

两边输出的字段结构一致，界面上不分来源，只在设置里显示当前走的是哪条。

## 许可

内部项目，暂不开源。
