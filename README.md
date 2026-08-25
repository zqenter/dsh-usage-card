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

---

## Token（DeepSeek API Key）配置详细教程

余额卡片本身**不填写密钥**——它通过 host 端 billing 服务代读 DeepSeek 余额，密钥只存在于宿主侧，永不进入浏览器。**你需要做的只是把 DeepSeek API Key 配给 DSH**（与 DeepSeek LLM 提供者共用同一把钥匙）。

### 第 1 步：获取 API Key

1. 打开 DeepSeek 开放平台：<https://platform.deepseek.com>
2. 登录 → 左侧 **API Keys** → **创建 API Key**
3. 复制生成的密钥（形如 `sk-xxxxxxxx...`），**只显示一次，先复制保存好**
4. 充值/确认账户有余额（查询余额本身免费）

> ⚠️ API Key 相当于密码，别提交进代码仓库、别发到聊天里。

### 第 2 步：把 Key 配给 DSH（三选一）

#### 方式 A：环境变量 `DEEPSEEK_API_KEY`（推荐，最简单）

billing 默认读取环境变量 `DEEPSEEK_API_KEY`：

```bash
# 临时验证（当前终端有效）
export DEEPSEEK_API_KEY=sk-你的key
```

想让 DSH 服务常驻读取：

- **macOS（launchd 启动 DSH）**：在 DSH 服务的 launchd plist 里加：
  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEEPSEEK_API_KEY</key>
    <string>sk-你的key</string>
  </dict>
  ```
  或写到 shell 启动脚本里 `export DEEPSEEK_API_KEY=...` 再启动 DSH。

- **Windows**：
  ```bat
  setx DEEPSEEK_API_KEY "sk-你的key"
  ```
  （重新打开终端生效；或写进启动脚本 `set DEEPSEEK_API_KEY=sk-你的key`）

#### 方式 B：在 DSH 设置里配置 DeepSeek 提供者密钥

如果 DSH 已通过界面/配置文件配好了 DeepSeek LLM 提供者的 API Key（同一个 key），billing 会自动复用**同一凭证源**——无需重复配置，余额卡片直接就能显示。

#### 方式 C：自定义环境变量名

部署端若不想用默认名，可给 `dsh-host-billing` 配置 `apiKeyEnv` 指向别的环境变量：
```yaml
# dsh-host-billing 配置示例
billing:
  apiKeyEnv: MY_CUSTOM_KEY_ENV
```

### 第 3 步：验证 Key 可用

```bash
curl -s https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer sk-你的key"
```
应返回类似：
```json
{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00",...}]}
```

### 第 4 步：重启 DSH 看卡片

重启 DSH 服务后，侧边栏底部（设置按钮上方）应显示余额卡片；数据每 60 秒自动刷新，点击卡片立即刷新。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 卡片不显示或余额为空 | `DEEPSEEK_API_KEY` 未配置或值不对 → 按第 2、3 步检查 |
| 改了 Key 不生效 | 环境变量改了要**重启 DSH 服务**；billing 每次请求都重新解析，但环境本身要重启加载 |
| 余额显示 0 / 金额不对 | 确认账户有余额；估算金额按默认价目表，单价不同时配置 `dsh-host-billing` 的 `pricing` |
| 显示「未授权 / 401」 | Key 无效或已过期 → 去 platform.deepseek.com 重新生成 |
