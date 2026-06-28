# Lambda 实操笔记：第一个无服务器 API

> 实操 B 全过程 ｜ 2026-06-28
> 目标：Lambda 函数 → 控制台测试 → 接 API Gateway → 公网访问 → 看日志
> 全程免费（Lambda 每月 100 万次调用免费，HTTP API 每月 100 万次免费）

---

## 全流程

```
1. 创建 Lambda 函数（Runtime: Python 3.13）
2. 写 handler 代码 → Deploy
3. 控制台 Test（喂事件 JSON，验证函数本身）
4. Add trigger → API Gateway（HTTP API, Open）
5. 浏览器/curl 访问 API endpoint → 拿到 JSON
6. Monitor → CloudWatch 日志看调用记录
```

---

## handler 代码（Python）

```python
import json

def lambda_handler(event, context):
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json; charset=utf-8'},
        'body': json.dumps(
            {'message': '你好，这是 dudu 的第一个 Lambda API！'},
            ensure_ascii=False   # 让中文正常输出（呼应 nginx 那个编码坑）
        )
    }
```

- ⚠️ 改完代码**必须点 Deploy（橙色按钮）**才生效。
- `lambda_handler(event, context)` = 入口契约：Lambda 喂 event(JSON)，你返回结果。
- `statusCode / headers / body` = 给 HTTP 用的标准响应格式，API Gateway 认这个。

---

## 关键操作要点

| 步骤 | 要点 |
|------|------|
| 创建函数 | Author from scratch；Runtime **主动选** Python 3.13（不是检测的） |
| 控制台测试 | Test 标签 → 建测试事件（默认 `{}`）→ 看到 statusCode 200 即成功 |
| 接 API Gateway | 函数页 Function overview → Add trigger → API Gateway → **Create new API** → **HTTP API**（比 REST API 简单便宜）→ Security: **Open** |
| 拿到网址 | 触发器展开后有 **API endpoint**，形如 `https://xxx.execute-api.ap-southeast-1.amazonaws.com/default/my-first-api` |
| 访问 | 浏览器直接打开，或 `curl <网址>` |

---

## 完整链路（对照理论，全是学过的）

```
浏览器请求 URL
  → API Gateway 接收，按路由匹配到函数（路由是 Gateway 管的，不是 Lambda）
  → 把 HTTP 请求打包成事件 JSON
  → 触发 Lambda：放置/调度服务找机器、起执行环境
  → Runtime 把事件喂给 lambda_handler
  → 函数返回 → API Gateway 转成 HTTP 响应 → 浏览器
```

## 和 EC2 部署的本质对比

| | EC2（实操A） | Lambda（实操B） |
|---|---|---|
| 服务器 | 自己开、自己 SSH、自己运维 | 完全不用管 |
| 网络 | 要配安全组、开端口 | 不用碰 |
| 闲置时 | 一直开机一直花钱（或要手动停） | 不运行、0 花费 |
| 适合 | 长期跑的完整应用 | API、事件触发的小逻辑 |

---

## CloudWatch 日志（监控）

- 函数页 **Monitor** 标签：看 Invocations / Duration / Errors 指标（CloudWatch 自动收集）。
- **View CloudWatch logs** → 日志组 `/aws/lambda/my-first-api` → Log stream 看每次调用的 START/END/REPORT。
- 调试技巧：代码里加 `print("...")`，Deploy 后再访问，日志里就能看到 → Lambda 最常用的调试方式。

---

## 清理 / 计费
- Lambda + API Gateway **闲置不花钱**（按调用计费），可以直接留着继续玩。
- 要删干净：删 Lambda 函数（连带触发器）+ 去 API Gateway 控制台删该 API。

---

## 下一步可以加的功能（留作练习）
- 读取 URL 查询参数（从 `event` 里取 `queryStringParameters`）
- 根据不同路径返回不同内容
- 连数据库（DynamoDB / RDS）做真正的数据读写
```
