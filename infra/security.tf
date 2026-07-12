# Lambda BFF：只出站（调内网 ALB）
resource "aws_security_group" "lambda" {
  name   = "${local.name_prefix}-lambda-sg"
  vpc_id = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-lambda-sg" }
}

# 内网 ALB：入站来自 Lambda-SG(80)
resource "aws_security_group" "alb" {
  name   = "${local.name_prefix}-alb-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-alb-sg" }
}

# stats-service：入站来自 ALB-SG（8080）
resource "aws_security_group" "stats_svc" {
  name   = "${local.name_prefix}-stats-svc-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-stats-svc-sg" }
}

# profile-service：入站来自 ALB-SG 和 stats-SG（Cloud Map 东西向）
resource "aws_security_group" "profile_svc" {
  name   = "${local.name_prefix}-profile-svc-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id, aws_security_group.stats_svc.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-profile-svc-sg" }
}

# RDS：入站 3306 来自两个服务 SG
resource "aws_security_group" "rds" {
  name   = "${local.name_prefix}-rds-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.profile_svc.id, aws_security_group.stats_svc.id]
  }
  tags = { Name = "${local.name_prefix}-rds-sg" }
}
