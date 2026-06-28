# AWS 学习路线图

> 为「会编程、想部署实际应用、喜欢先理解概念」量身定制
> 开始日期：2026-06-27

## 学习方式
每一课的结构：**先讲概念原理 → 再动手实操 → 最后小结**。
概念讲完确认理解了，再进入实操，避免"只会点按钮不懂原理"。

---

## 阶段一：地基（理解 AWS 是什么）
- [x] 1. 云计算与 AWS 全景：为什么用云、AWS 的核心模型
- [x] 2. 账号与计费：Region（区域）、AZ（可用区）、免费套餐、账单告警
- [x] 3. IAM 安全模型：用户、角色、策略、最小权限原则（**非常重要，先学**）

## 阶段二：部署一个应用需要的核心服务
- [x] 4. 计算 Compute：EC2（虚拟机）vs Lambda（无服务器）vs 容器（ECS/Fargate）  ← Lambda 深挖，见 notes/lambda.md
- [ ] 5. 存储 Storage：S3（对象存储）、EBS（硬盘）
- [x] 6. 网络 Networking：VPC、子网、安全组（Security Group）  ← 深挖，见 notes/vpc-networking.md
- [ ] 7. 数据库 Database：RDS（关系型）、DynamoDB（NoSQL）

## 阶段三：动手——把一个真实应用部署上线
- [ ] 8. 实操 A：用 S3 托管一个静态网站
- [x] 9. 实操 A 完成：EC2 + nginx 部署第一个网站（见 notes/ec2-hands-on.md）
- [x] 10. 实操 C 完成：Lambda + API Gateway 做无服务器 API（见 notes/lambda-hands-on.md）

## 阶段四：工程化（让部署可靠、可重复）
- [ ] 11. 基础设施即代码：CloudFormation / Terraform 入门
- [ ] 12. 监控与日志：CloudWatch
- [ ] 13. 成本控制与安全最佳实践

---

## 进度记录
| 日期 | 完成内容 | 备注 |
|------|----------|------|
| 2026-06-27 | 路线图制定 | 开始学习 |
| 2026-06-27 | 完成第1、2课 | 懂了云/Region/AZ；设置了 Budgets 账单告警 |
| 2026-06-27 | 完成第3课 | IAM：创建了日常用 IAM 用户 |
| 2026-06-28 | 完成第4、6课(概念) | Lambda 深挖(notes/lambda.md)；网络/VPC 深挖(notes/vpc-networking.md) |
| 2026-06-28 | 完成实操A | EC2+nginx 部署第一个网站，踩了5个坑(notes/ec2-hands-on.md)，实例已停止 |
| 2026-06-28 | 完成实操B/C | Lambda+API Gateway 部署无服务器 API(notes/lambda-hands-on.md)，闲置免费保留 |
