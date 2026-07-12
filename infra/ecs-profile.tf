resource "aws_service_discovery_service" "profile" {
  name = "profile"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {}

  lifecycle {
    # provider 对空 health_check_custom_config 有已知的永久 diff（强制替换）。
    # 该块创建后不会变，忽略其漂移，避免误替换（替换需先注销 ECS 实例，会中断服务）。
    ignore_changes = [health_check_custom_config]
  }
}

resource "aws_ecs_task_definition" "profile" {
  family                   = "${local.name_prefix}-profile"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "profile-service"
    image        = "${aws_ecr_repository.profile.repository_url}:latest"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "DB_PORT", value = "3306" }
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
        "awslogs-group"         = aws_cloudwatch_log_group.profile.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "profile"
      }
    }
  }])
}

resource "aws_ecs_service" "profile" {
  name            = "${local.name_prefix}-profile"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.profile.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # 给容器等 RDS 就绪的时间，避免启动初期 ALB unhealthy 就被 ECS 替换
  health_check_grace_period_seconds = 120

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.profile_svc.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.profile.arn
    container_name   = "profile-service"
    container_port   = 8080
  }

  service_registries {
    registry_arn = aws_service_discovery_service.profile.arn
  }

  depends_on = [aws_lb_listener.http]
}
