data "aws_caller_identity" "current" {}

# 复用账号里已存在的 GitHub OIDC provider（老 deploy 已建，避免 EntityAlreadyExists）
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# 每个 workspace 一个部署角色，信任按环境隔离：
# prod 角色只认 production 分支/prod 环境；test 角色只认 main/PR/test 环境。
locals {
  allowed_subs = terraform.workspace == "prod" ? [
    "repo:${var.github_repo}:environment:prod",
    "repo:${var.github_repo}:ref:refs/heads/production",
    ] : [
    "repo:${var.github_repo}:environment:test",
    "repo:${var.github_repo}:ref:refs/heads/main",
    "repo:${var.github_repo}:pull_request",
  ]
}

resource "aws_iam_role" "deploy" {
  name = "${local.name_prefix}-gha-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = local.allowed_subs }
      }
    }]
  })
  tags = { Name = "${local.name_prefix}-gha-deploy" }
}

# 部署权限：ECR push、ECS 更新服务、Lambda 更新、传角色
resource "aws_iam_role_policy" "deploy" {
  name = "${local.name_prefix}-deploy-policy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability",
          "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:BatchGetImage"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode"]
        Resource = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name_prefix}-*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
      },
      {
        # 前端部署：同步构建产物到私有桶（含 PR 预览的 pr-N/ 前缀）
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObject"]
        Resource = [
          "arn:aws:s3:::profile-*-frontend-*",
          "arn:aws:s3:::profile-*-frontend-*/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "*"
      }
    ]
  })
}
