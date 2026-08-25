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

### 一、去开放平台抓 Token（卡片数据来源）

1. 打开 **DeepSeek 开放平台**：<https://platform.deepseek.com>
2. 登录（手机号 / 邮箱注册过的账号，与 chat.deepseek.com 同一个账号体系）
3. 左侧菜单 → **API Keys** → 点 **「创建 API Key」**
4. 给 key 起个名字（如 `usage-card`），点确认
5. 复制生成的密钥（`sk-` 开头，约 35 位），**只显示一次，立刻保存**

要点：

- **这一个 key 就能查余额和用量**（余额接口 `GET /user/balance` 用任意有效 key 都可调用）
- 想隔离的话可以**单独建一个「查询专用」key**（只用来给卡片/脚本查余额，不参与模型调用），和调模型用的 key 分开管理
- ⚠️ key 等于密码：别提交进代码、别发聊天/截图

### 二、看懂余额与用量明细（卡片显示的是什么）

#### 余额（卡片「余额」项）

来自 DeepSeek 接口 `GET https://api.deepseek.com/user/balance`。命令行自查：

```bash
curl -s https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer sk-你的key"
```

返回字段说明：

| 字段 | 含义 |
|---|---|
| `is_available` | 账户是否可用 |
| `balance_infos[].currency` | 币种（CNY / USD） |
| `balance_infos[].total_balance` | **总余额**（卡片显示的数值） |
| `balance_infos[].granted_balance` | 赠送余额（活动赠送部分） |
| `balance_infos[].topped_up_balance` | 充值余额 |

> 总余额 = 赠送余额 + 充值余额。卡片显示的就是 `total_balance`，按币种自适应显示 ¥ / $。

#### Token 消费明细（卡片「今日 Tokens / 今日金额」）

- **开放平台视角**：登录 platform.deepseek.com → 左侧 **「用量管理 / Usage」**，可按日/小时查看 **token 消耗明细**（输入/输出/缓存 token 分开统计）——这是官方的消费明细。
- **卡片视角**：卡片上的「今日 Tokens / 今日金额」由 `dsh-host-billing` 按 DSH 配置的价目表**逐事件估算**（金额是估算值，卡片上有标注），用于侧边栏快速看一眼今天的消耗，不用每次去开放平台。
- **峰谷时段**：DeepSeek 官方计费分峰谷（高峰：北京 09:00–12:00、14:00–18:00；其余谷时段半价）。卡片按官方窗口算出当前时段，谷时段显示绿色「谷 · 半价」徽标。

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
