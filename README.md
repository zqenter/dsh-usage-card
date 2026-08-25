![Uploading image.png…]()

# dsh-usage-card — DSH 侧边栏余额用量卡片

DeepSeek Harness 左侧边栏的 **余额用量卡片** 插件：显示在侧边栏底部（设置按钮上方）。宽侧栏显示完整卡片，窄侧栏（56px）显示紧凑的"时段圆点 + 余额"胶囊。

## 功能（卡片到底显示什么）

卡片显示三类数据，其中**「今日金额」有两种来源（官方 / 估算）**——这是最容易搞混的地方：

### 1️⃣ 余额（官方）
- 显示你的 DeepSeek **账户余额**（¥ 或 $ 按币种自适应）
- 来源：官方接口 `api.deepseek.com/user/balance`，用 **API Key（`sk-` 开头）** 调用
- 数据只经过 host 端，API Key 不出浏览器

### 2️⃣ 今日 Tokens / 今日金额 —— 官方 或 估算，二选一

| 模式（卡片标签） | 什么时候显示 | 数据来源 |
|---|---|---|
| **官方** | 配置了 **`DEEPSEEK_PLATFORM_TOKEN`**（开放平台 F12 复制的 `userToken`） | `platform.deepseek.com/api/v0/usage/...` 平台官网的**真实消费数据** |
| **估算** | 没配平台 token | 基于本地会话日志按价目表**估算**（金额是估算值，卡片上有标注） |

> 卡片上有 **⚙ 按钮**：点击翻面，出现「平台 Token」输入框——把 F12 复制的 `userToken` 粘贴进去保存（保存前自动验证），卡片就从「估算」切到「**官方**」。卡片内置了完整的 6 步 F12 教程。

### 3️⃣ 峰谷时段徽标
- 按 DeepSeek 官方计费窗口计算：**峰** = 北京 09:00–12:00、14:00–18:00；其余为**谷**（半价）
- 谷时段显示绿色「谷 · 半价」徽标

### 其他
- 每 60 秒自动轮询刷新，点击卡片立即刷新
- 7 日用量柱状图（峰/谷分色堆叠）

---

## ⚠️ 两个 token 的分工（务必分清）

| Token | 长什么样 | 从哪拿 | 卡片用它显示什么 |
|---|---|---|---|
| **`DEEPSEEK_API_KEY`** | `sk-` 开头 | 开放平台 → **API Keys** 页创建 | **余额**（调 `api.deepseek.com/user/balance`） |
| **`DEEPSEEK_PLATFORM_TOKEN`** | F12 复制的 `userToken`（`eyJ...` 长串） | 开放平台 → **F12 → Application → Local Storage** | **今日金额/用量（官方）**（调 `platform.deepseek.com/api/v0/usage/...`） |

- 只配 API_KEY → 余额显示官方，今日金额显示**估算**
- 两个都配 → 余额 + 今日金额**全部官方**，真实数据
- 只配 PLATFORM_TOKEN → 今日金额官方，但余额取不到（余额需要 API Key）

> 卡片 **⚙ 设置面**里粘贴的就是 `PLATFORM_TOKEN`（userToken）；卡片内置 6 步教程教你怎么在 F12 里找到它。

---

## 组成

```
packages/client/ui-usage-card/    # 前端插件（UsageCard.tsx / CSS / store / 内置教程）
packages/host/billing/            # host 端计费服务（余额 balance / 平台用量 platform / 定价 pricing）
packages/bundle/web-app/          # cordis 补丁 + 打包集成
（另有侧边栏/标题栏 UI 微调 CSS）
```

## 安装（应用到 DSH）

本插件是对 DSH（`deepseek-ai/deepseek-harness`）的一个本地提交。两种应用方式：

### 方式 A：打补丁

```bash
cd deepseek-harness
git apply dsh-usage-card.patch
pnpm install && pnpm build:lib
```

### 方式 B：手动放置

将 `packages/` 下的目录复制到 DSH 仓库对应位置，并把 `packages/bundle/web-app/cordis.patch.yml` 与 `package.json` 的改动合入。

---

## Token 获取教程

### 一、F12 复制 userToken（给「今日金额官方」用）

**第 1 步**：用 Chrome/Edge 打开并登录 <https://platform.deepseek.com>

**第 2 步**：按 **F12**（或右键 → 检查）打开开发者工具，顶部选 **Application**（应用）标签页

**第 3 步**：左侧展开 **Local Storage**（本地存储）→ 点击 `https://platform.deepseek.com`

**第 4 步**：在右侧键值列表里找到 **`userToken`**，双击 Value 列，全选复制那个长串（形如 `eyJ...`）

**第 5 步**：把复制到的 `userToken` 粘贴到**卡片 ⚙ 设置面**的「平台 Token」输入框 → 保存（会自动验证）。成功后卡片「今日金额」标签显示**官方**。

> 也可以不走卡片设置面：把这个值配成环境变量 `DEEPSEEK_PLATFORM_TOKEN`，重启 DSH 服务即可。

### 二、创建 API Key（给「余额」用）

**第 1 步**：登录开放平台 → 左侧 **API Keys** → **创建 API Key**

**第 2 步**：复制生成的 `sk-` 开头密钥，配到环境变量 `DEEPSEEK_API_KEY`（macOS launchd plist 加 EnvironmentVariables / Windows `setx DEEPSEEK_API_KEY "sk-..."`）

**第 3 步**：重启 DSH 服务，卡片「余额」显示官方数值

### 三、验证 token 是否有效

```bash
# 验证 API Key（余额）
curl -s https://api.deepseek.com/user/balance -H "Authorization: Bearer sk-你的key"
# 返回 {"is_available":true,"balance_infos":[...]} 即有效
```

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 余额空 | `DEEPSEEK_API_KEY` 没配或无效 → 创建 API Key 并配置 |
| 今日金额显示「估算」而不是「官方」 | 没配 `DEEPSEEK_PLATFORM_TOKEN`（userToken）→ 按教程一配置 |
| 粘贴 userToken 保存时报无效 | token 过期/复制错 → 重新 F12 复制最新 `userToken` |
| 改了环境变量不生效 | 改完要**重启 DSH 服务** |
| 今日金额不准 | 估算模式按默认价目表；配了官方 token 后即为平台真实数据 |
