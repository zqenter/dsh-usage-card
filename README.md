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


## 开放平台 Token 获取 & 余额/用量明细教程

> 卡片本身不含密钥逻辑——安装插件后它就会显示余额和用量，**前提是你去 DeepSeek 开放平台抓一个 API Token**，并把它配给 DSH（与 DeepSeek 提供者共用一把钥匙）。本教程分三部分：**① 抓 Token → ② 看懂余额/用量明细 → ③ 喂给卡片**。

### 一、从开放平台抓 Token（F12 复制法）

**第 1 步：打开开放平台并登录**

浏览器打开 <https://platform.deepseek.com>，登录你的账号（手机号/邮箱）。

**第 2 步：按 F12 打开开发者工具**

- 键盘按 **F12**（或右键 → 检查）
- 顶部面板选 **Application**（中文界面叫「应用」）

**第 3 步：找到 Local Storage**

- 左侧展开 **Local Storage**（本地存储）→ 点开 `https://platform.deepseek.com` 这一项
- 右侧会出现该网站存的所有键值对

**第 4 步：复制 token**

- 在键值列表里找名字带 token 的条目，常见的有：
  `token`、`userToken`、`access_token`、`apiKey`、`ds_token` 等
- 找到后，**双击 Value 那一列** → 全选 → 复制那个长字符串

**第 5 步：判断你复制到的是什么（重要）**

| 复制的值长什么样 | 是什么 | 能不能用 |
|---|---|---|
| 以 `sk-` 开头（约 35 位） | **API Key**（开放平台的密钥） | ✅ 直接可用 |
| 形如 `eyJxxxxx.yyyyy.zzzzz`（两三个点分隔的长串） | **网页会话 JWT**（网站内部接口用的） | ⚠️ 不一定能直接查余额，见下方验证 |

**第 6 步：验证这个 token 能不能查余额**

```bash
curl -s https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer 你复制的token"
```

- 返回 `{"is_available":true,"balance_infos":[...]}` → **能用**，记下这个 token
- 返回 401 / 认证失败 → 这个 token 查不了余额，改用下面的「兜底：API Keys 页面」方法

> **兜底（最稳的方法）**：登录开放平台 → 左侧 **API Keys** → **创建 API Key** → 复制生成的 `sk-` 开头的密钥。这个一定能查余额，也是卡片最可靠的 token。

### 三、把这个 Token 喂给卡片

billing 默认从环境变量 `DEEPSEEK_API_KEY` 读 key（与 DeepSeek LLM 提供者同一凭证源）：

```bash
# 临时生效（当前终端）
export DEEPSEEK_API_KEY=sk-你的key
```

常驻配置：
- **macOS（launchd）**：在 DSH 服务的 plist 加
  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEEPSEEK_API_KEY</key>
    <string>sk-你的key</string>
  </dict>
  ```
- **Windows**：`setx DEEPSEEK_API_KEY "sk-你的key"`（重开终端生效）

改完**重启 DSH 服务**，侧边栏底部（设置按钮上方）即显示余额卡片，每 60 秒自动刷新，点击卡片立即刷新。

> 如果 DSH 已在设置里配过 DeepSeek 提供者的 API Key，卡片自动复用同一把钥匙，无需重复配置。

### 四、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 卡片不显示 / 余额空 | `DEEPSEEK_API_KEY` 没配或值不对 → 按第一部分重新抓 key、第三部分配置 |
| 显示 401 / 未授权 | key 无效或过期 → 去开放平台重新生成 |
| 改了 key 不生效 | 环境变量改完要**重启 DSH 服务** |
| 今日金额不准 | 是估算值（按默认价目表）；单价不同时配置 `dsh-host-billing` 的 `pricing`，明细以开放平台「用量管理」为准 |
| 想确认 key 有没有额度 | 用第二部分的 `curl` 命令直接查 |
