# AgentLink

在 QQ 群里提供受限的 AI 对话。群成员通过 @机器人或 `/chat` 发起提问；每个群拥有独立会话和隔离 Worker。

默认群聊支持联网查询；主人可为指定群分别开启文件和终端。所有工具仍受群级隔离工作区限制，子代理与工作流始终关闭。

## 快速开始

**运行条件：** macOS、Node.js、Docker（或一个可用的 Redis）、QQ Bot 配置。首次启动时会自动创建插件专用 Python 环境并安装 DSH SDK。

```bash
yarn install
docker compose up -d redis
yarn dev --login qq-bot
```

在启动前，将 QQ Bot、Redis 和主人账号配置写入本机的 `alemon.config.yaml`。该文件包含密钥，已经被 Git 忽略；不要提交、截图或复制到公开环境。配置示例与所有可调参数见 [配置指南](docs/config.md)。

在 `alemon.config.yaml` 的 `alemonjs-agent-link` 中设置 `apiKey`、可选 `baseUrl` 与 `model` 后启动。发送 `/agentstatus` 确认服务已就绪。

生产环境先构建再启动：

```bash
yarn build
yarn start --login qq-bot
```

不要将带热重载的 `yarn dev` 用作生产进程。

## 使用方法

### 群成员

| 操作           | 用法                                                       |
| -------------- | ---------------------------------------------------------- |
| 提问           | `@机器人 帮我总结刚才的讨论` 或 `/chat 帮我总结刚才的讨论` |
| 取消自己的请求 | `/cancel`                                                  |
| 查看服务状态   | `/agentstatus`                                             |
| 查看隐私说明   | `/agentprivacy`                                            |
| 查看帮助       | `/agenthelp`                                               |

普通群消息不会单独触发模型；它们会在短时间内作为下一次提问的参考。默认保留最近 20 条、15 分钟，且会被压缩后提供给模型。

### 群管理员或机器人主人

| 操作         | 用法                  | 影响                       |
| ------------ | --------------------- | -------------------------- |
| 开始新话题   | `/new`                | 清除本群正式会话和短时参考 |
| 调整工具权限 | `/agentpolicy web     | files                      | terminal on | off` | 变更当前群的能力并开始新会话 |
| 预览参考摘要 | `/agentcontext`       | 不修改数据                 |
| 清除参考摘要 | `/agentcontext clear` | 保留正式会话               |

### 机器人主人（私聊）

| 操作               | 用法                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| 配置模型凭证       | 修改 `alemon.config.yaml` 的 `alemonjs-agent-link.apiKey` 后重启     |
| 查看模型           | `/agentmodels`、`/agentmodel`                                        |
| 查看完整状态       | `/agentstatus`                                                       |
| 私聊使用 Agent     | `/chat 你的问题`                                                     |
| 彻底删除指定群数据 | 在目标群中执行 `/agentpurge`，再于 60 秒内执行 `/agentpurge confirm` |

## 运行模型

```text
QQ / AlemonJS
  → Redis：去重、限流、会话代际、短时上下文
  → Node 编排：群内串行、全局并发控制
  → 本机 Bridge：鉴权与受限模型代理
  → 每群 sandbox Worker：DSH chat-only 会话
```

AgentLink 仅支持**单 Node 进程**连接同一个 QQ 机器人。不要同时启动多个副本；分布式协调尚未实现。

## 文档

- [配置指南](docs/config.md)：配置项、默认值和示例。
- [运维手册](docs/operations.md)：部署、状态检查和故障处理。
- [安全与数据](docs/security.md)：沙箱边界、数据生命周期和凭证处理。

## 验证

```bash
yarn test
npx eslint src
```
