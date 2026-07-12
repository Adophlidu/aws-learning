resource "aws_cloudwatch_log_group" "stats" {
  name              = "/ecs/${local.name_prefix}-stats-service"
  retention_in_days = 3
}

resource "aws_ecs_task_definition" "stats" {
  family                   = "${local.name_prefix}-stats"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "stats-service"
    image        = "${aws_ecr_repository.stats.repository_url}:latest"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "DB_PORT", value = "3306" },
      { name = "PROFILE_SVC_URL", value = "http://profile.svc.internal:8080" }
    ]
    secrets = [
      { name = "DB_HOST", valueFrom = "${aws_secretsmanager_secret.db.arn}:host::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.db.arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db.arn}:password::" },
      { name = "DB_NAME", valueFrom = "${aws_secretsmanager_secret.db.arn}:dbname::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.stats.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "stats"
      }
    }
  }])
}

resource "aws_ecs_service" "stats" {
  name                              = "${local.name_prefix}-stats"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.stats.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.stats_svc.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.stats.arn
    container_name   = "stats-service"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http]
}
