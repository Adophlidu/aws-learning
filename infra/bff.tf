# 打包 BFF 代码为 zip（无依赖，内置 fetch）
data "archive_file" "bff" {
  type        = "zip"
  source_dir  = "${path.module}/../bff"
  output_path = "${path.module}/bff.zip"
}

resource "aws_iam_role" "bff" {
  name = "${local.name_prefix}-bff"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# VPC 内运行需要网卡权限
resource "aws_iam_role_policy_attachment" "bff_vpc" {
  role       = aws_iam_role.bff.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_lambda_function" "bff" {
  function_name    = "${local.name_prefix}-bff"
  role             = aws_iam_role.bff.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.bff.output_path
  source_code_hash = data.archive_file.bff.output_base64sha256
  timeout          = 15

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = { ALB_URL = "http://${aws_lb.main.dns_name}" }
  }
}

# API Gateway HTTP API
resource "aws_apigatewayv2_api" "bff" {
  name          = "${local.name_prefix}-bff-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type"]
  }
}

resource "aws_apigatewayv2_integration" "bff" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.bff.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = toset([
    "POST /profiles", "GET /profiles", "GET /profiles/{id}",
    "GET /stats/{gid}", "GET /repos/{gid}", "GET /leaderboard"
  ])
  api_id    = aws_apigatewayv2_api.bff.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.bff.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.bff.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGW"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bff.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}

output "bff_api_url" { value = aws_apigatewayv2_stage.default.invoke_url }
