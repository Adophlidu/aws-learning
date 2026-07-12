resource "aws_ecr_repository" "profile" {
  name                 = "${local.name_prefix}-profile-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # 学习：destroy 时连镜像一起删
  image_scanning_configuration {
    scan_on_push = false
  }
  tags = { Name = "${local.name_prefix}-profile-service" }
}

resource "aws_ecr_repository" "stats" {
  name                 = "${local.name_prefix}-stats-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = false
  }
  tags = { Name = "${local.name_prefix}-stats-service" }
}
