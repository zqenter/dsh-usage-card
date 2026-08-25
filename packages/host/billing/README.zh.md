# @deepseek-ai/dsh-host-billing

[English](README.md) | 中文

用量仪表盘的**数据层**：本宿主插件注册了 `/billing` 回环 RPC 通道，供[浏览器用量卡片](../../client/ui-usage-card/README.md)读取。

- `balance` —— **在宿主侧**请求所配置 DeepSeek 端点的 `GET /user/balance`，API 密钥不会进入浏览器。连接事实的解析与 `llm-deepseek` 完全一致（`$DEEPSEEK_BASE_URL` 或 `https://api.deepseek.com`；密钥先走凭据服务，再退回启动环境），按请求解析。
- `today` —— 汇总最近 7 个本地日所有会话（内存中的已挂载会话 + 持久化冷会话）里提供商上报的 token 用量，并按 DeepSeek 官方**峰谷分时**（2026-08-17 起生效）逐事件计价：高峰时段为北京时间 09:00–12:00、14:00–18:00，其余为空闲（半价）。金额是**估算值**：harness 只按步骤记录 token 用量、不记录账单价格，因此每个用量事件按配置的模型**高峰价**目表计价（默认 DeepSeek 官方 v4-flash / v4-pro 人民币单价），落在高峰窗口之外的事件再乘 `offPeakFactor`（默认 0.5）。报告（含 7 日序列）按（时区、日期、模型）缓存 `refreshCacheMs`。

日窗口按调用方（卡片自身）的 IANA 时区计算，通过午夜二分处理夏令时长短不一的日期。

## 配置

两档模式——**默认只需 API key**（零额外配置），平台 token 可选、用于解锁官方精确数字。

**第一档（默认 · 本地估算，零配置）**：只配置 `DEEPSEEK_API_KEY` 即可。`today` 用官方峰谷价目表给 harness 自身记录的 token 用量计价，开箱即用；卡片上标注"估算"。

**第二档（可选 · 平台官方数据）**：加一个平台会话 token 后，`today` 直接返回平台后台的按日精确数据（今日金额、按 命中/输入/输出 的 token 拆分、7 日历史、本月与累计消费）。**API key 无法访问这些数据**——DeepSeek 没有公开用量接口（实测 `/user/usage`、`/dashboard/billing/usage` 等全部 404，只有 `/user/balance` 能用 key）。

获取 token（一次性，约 30 秒）：
1. 浏览器登录 `https://platform.deepseek.com`
2. F12 → Application → Local Storage → `https://platform.deepseek.com` → 复制 `userToken` 的值
3. 写进凭据文件 `~/.dsh/.credentials.yaml`（或导出环境变量），插件会实时重读：

```yaml
DEEPSEEK_PLATFORM_TOKEN: <userToken>
```

When the token is absent, expired, or the platform endpoints fail, the card automatically falls back to Tier 1 and keeps working.

```yaml
- id: billing
  name: '@deepseek-ai/dsh-host-billing'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY   # credential ref; default DEEPSEEK_API_KEY
    platformTokenEnv: DEEPSEEK_PLATFORM_TOKEN  # optional: official data
    baseURL: https://api.deepseek.com  # default: $DEEPSEEK_BASE_URL, then the public API
    defaultModel: deepseek-v4-flash    # which price table prices the estimate
    pricing:                           # PEAK-hour prices, CNY per million tokens
      deepseek-v4-flash: { inputPerMillion: 3, cacheReadPerMillion: 0.1, outputPerMillion: 9 }
      deepseek-v4-pro:   { inputPerMillion: 9, cacheReadPerMillion: 0.3, outputPerMillion: 27 }
    offPeakFactor: 0.5       # multiplier outside peak windows (official: half price)
    refreshCacheMs: 10000    # report cache TTL
```

## Model Experience

无；本插件只服务 GUI，不触达模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供商请求（余额端点是账户查询）。

## 已知限制与后续工作

- **估算是估算** —— 第一档金额按配置的价目表计价；提供商调价或部署使用不同单价时，需要更新 `pricing`。权威数字以提供商的用量后台为准——DeepSeek 没有公开的用量金额 API（私有平台接口必须用会话 token）。
- **无按请求的模型归属** —— 估算把所有事件都按 `defaultModel` 计价；按模型分价有待会话日志记录每步的模型。
- **第一档的 7 日历史仅限本机** —— 估算图表只覆盖 harness 自身会话日志记录到的用量；harness 启动之前（或之外）的用量不可见。第二档显示平台的完整历史。
