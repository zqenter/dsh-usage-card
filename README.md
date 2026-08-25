# dsh-usage-card — DSH 侧边栏余额用量卡片

DeepSeek Harness 左侧边栏的 **余额用量卡片** 插件：侧边栏底部（设置按钮上方）显示 DeepSeek 余额、今日 Tokens/金额、峰谷时段徽标，宽侧栏显示完整卡片，窄侧栏（56px）显示紧凑余额胶囊。

## 功能

- **余额** — 通过 host 端 billing 获取，API Key 不出浏览器
- **峰谷时段** — 按 DeepSeek 官方峰谷窗口计算（峰: 北京 9–12 点 / 14–18 点; 其余谷时段半价），谷时段显示绿色「谷 · 半价」徽标
- **今日 Tokens / 今日金额** — 按价格表对今日事件定价估算
- 每 60 秒轮询刷新，点击卡片立即刷新

## 组成

```
packages/client/ui-usage-card/    # 前端插件（UsageCard.tsx / CSS / store）
packages/host/billing/            # host 端计费服务（余额/用量/定价）
packages/bundle/web-app/          # cordis 补丁 + 打包集成
（另有侧边栏/标题栏 UI 微调 CSS）
```

## 安装（应用到 DSH）

本插件是对 DSH（`deepseek-ai/deepseek-harness`）的一个本地提交，包含 41 个文件的改动。两种应用方式：

### 方式 A：打补丁

```bash
cd deepseek-harness
git apply dsh-usage-card.patch
pnpm install && pnpm build:lib
```

### 方式 B：手动放置

将 `packages/` 下的目录复制到 DSH 仓库对应位置，并把 `packages/bundle/web-app/cordis.patch.yml` 与 `package.json` 的改动合入。

## 说明

- 余额数据来自 host 端 `billing` 服务，浏览器侧不接触 API Key
- 金额为估算值（按默认价格表），部署端可配置 `dsh-host-billing` 的 `pricing`
- 时段徽标随 60s 刷新周期更新
