resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name_prefix}-db-subnets" }
}

resource "random_password" "db" {
  length  = 20
  special = false
}

resource "aws_db_instance" "main" {
  identifier             = "${local.name_prefix}-db"
  engine                 = "mysql"
  engine_version         = "8.0"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  storage_type           = "gp2"
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = true
  deletion_protection    = false
  apply_immediately      = true
  tags                   = { Name = "${local.name_prefix}-db" }
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name_prefix}-db-credentials"
  recovery_window_in_days = 0 # 学习：删了立即可重建同名
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    username = var.db_username
    password = random_password.db.result
    dbname   = var.db_name
  })
}
