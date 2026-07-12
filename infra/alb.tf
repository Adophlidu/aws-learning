resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id
  tags               = { Name = "${local.name_prefix}-alb" }
}

resource "aws_lb_target_group" "profile" {
  name        = "${local.name_prefix}-profile-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # Fargate awsvpc
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${local.name_prefix}-profile-tg" }
}

resource "aws_lb_target_group" "stats" {
  name        = "${local.name_prefix}-stats-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${local.name_prefix}-stats-tg" }
}

# 默认转发到 profile 服务
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.profile.arn
  }
}

# 路径路由：/leaderboard、/*/repos、/*/stats → stats 服务（暂定，Plan 2/3 校准）
resource "aws_lb_listener_rule" "stats" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.stats.arn
  }
  condition {
    path_pattern {
      values = ["/leaderboard*", "/*/repos", "/*/stats"]
    }
  }
}
