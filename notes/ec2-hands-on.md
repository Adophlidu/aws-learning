# EC2 实操笔记：部署第一个网站

> 实操 A 全过程 + 踩坑记录 ｜ 2026-06-28
> 目标：启动 EC2 → SSH 登录 → 装 nginx → 公网访问 → 自定义网页

---

## 全流程回顾

```
1. 启动 EC2（Amazon Linux 2023, t2.micro 免费套餐）
2. SSH 登录
3. sudo dnf install -y nginx
4. sudo systemctl start nginx && sudo systemctl enable nginx
5. 浏览器访问 http://<公网IP> → 看到网页
6. 自定义 index.html
7. 用完 Stop（停止）实例
```

---

## 启动 EC2 的关键选项

| 选项 | 选什么 | 说明 |
|------|--------|------|
| AMI（镜像） | Amazon Linux 2023 | 操作系统模板，选带 "Free tier eligible" 的 |
| 实例类型 | t2.micro / t3.micro | 配置档位，micro 免费套餐每月 750 小时 |
| 密钥对 Key pair | 新建 RSA + .pem | SSH 登录的钥匙，下载的 .pem 要保管好 |
| 网络 | 默认 VPC + 公有子网 | 保持默认；确保 Auto-assign public IP = Enable |
| 安全组 | 放行 22 + 80 | SSH 来源=My IP；HTTP 来源=0.0.0.0/0 |
| 存储 EBS | 8GB（免费套餐含30GB） | 这台机器的"硬盘" |

### 登录命令
```bash
chmod 400 ~/Downloads/my-key.pem          # 必做：私钥权限收紧，否则 SSH 拒绝
ssh -i ~/Downloads/my-key.pem ec2-user@<公网IP>
```
- 用户名是 `ec2-user`（Amazon Linux 默认），不是 root。
- `-i` 指定私钥（identity）。

---

## ⭐ 踩过的坑（重点，以后照查）

### 坑 1：VPN/代理劫持，连到 198.18.x.x
- 现象：`kex_exchange_identification: Connection closed by 198.18.3.100`
- 原因：`198.18.0.0/15` 是保留段，是 Clash/Surge 等代理 "fake-ip" 模式用的虚拟地址。流量被本地代理劫持。
- 关键判断：一看到 `198.18.x` 出现在连接里，基本就是本地代理在搞鬼。
- 解决：关掉 VPN；若退出后仍劫持，是残留的虚拟网卡(utun)+路由没清 → 重启 Mac 最彻底。
- 排查命令：`ping -c2 <真实IP>`、`ifconfig | grep utun`、`netstat -rn | grep 198.18`

### 坑 2：命令里的 `-i` 横杠被复制坏
- 现象：`ssh: Could not resolve hostname i`
- 原因：从聊天/文档复制时，普通减号 `-` 变成了 unicode 长横，ssh 把 `i` 当成主机名。
- 解决：手动逐字敲命令，确保 `-i` 是英文减号。

### 坑 3：连接超时 Operation timed out（最经典）⭐
- 现象：`ssh: connect to host 13.x.x.x port 22: Operation timed out`
- 判断：**超时 = 防火墙默默丢包**（对比：`Connection refused` = 端口没开）。
- 原因：安全组 SSH 来源设的是创建时的 "My IP"，但**开关 VPN/网络切换后，我的公网 IP 变了**，旧 IP 被挡。
- 解决：
  1. 查当前 IP：`curl https://checkip.amazonaws.com`（VPN 要关）
  2. EC2 → 实例 → Security → 安全组 → 编辑入站规则 → SSH 来源重选 "My IP"（自动填当前IP）→ 保存
  3. 重新 SSH
- 教训：**"My IP" 是创建那一刻的快照，IP 一变就连不上。**

### 坑 4：nginx 装了但 inactive (dead)
- 现象：status 显示 `Active: inactive (dead)`（没 failed）。
- 原因：start 命令没真正执行成功。
- 解决：重新 `sudo systemctl start nginx`，再 `status` 看是否 `active (running)`。
- 排查：`sudo nginx -t`（查配置语法）、`sudo journalctl -xeu nginx`、`sudo ss -tlnp | grep :80`（查端口占用）。

### 坑 5：中文网页乱码
- 原因：HTML 没声明编码，浏览器用错误码表解读 UTF-8 中文。
- 解决：HTML 的 `<head>` 里加 `<meta charset="UTF-8">`。
- （备选：nginx 配置加 `charset utf-8;`）

---

## 自定义网页
- nginx 网页根目录：`/usr/share/nginx/html/index.html`
- 写带编码的完整 HTML：
```bash
sudo tee /usr/share/nginx/html/index.html > /dev/null << 'EOF'
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>...</title></head>
<body><h1>...</h1></body>
</html>
EOF
```
- `sudo tee` 是往需要管理员权限的文件写内容的常用技巧。

---

## 清理 / 计费
| 操作 | 效果 | 计费 |
|------|------|------|
| 保持运行 | 网站一直在线 | 免费套餐每月 750h t2.micro，一台全月免费（前12月） |
| Stop 停止 | 关机，保留实例+硬盘 | 计算不收费；EBS 在 30GB 免费内也免费 |
| Terminate 终止 | 彻底删除 | 不收费 |

- ⚠️ 停止后再启动，**公网 IP 会变**（要重连新 IP、可能重刷安全组 My IP）。
- 想要固定 IP → 绑 **Elastic IP**（以后学）。
- 1 美元 Budgets 账单告警在兜底。

---

## 概念回路（这次实操串起了哪些知识）
请求链路：浏览器 → Internet Gateway → 公有子网 → 安全组放行的 80 端口 → nginx
- 这正是 VPC 笔记里那张大图"最左上角的最小单元"，亲手搭了一遍。
```
