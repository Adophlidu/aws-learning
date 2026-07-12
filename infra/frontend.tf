# 前端托管：私有 S3 桶 + CloudFront(OAC) —— 按 workspace 各一套 test/prod
# 桶不对公网开放，只有 CloudFront 经 OAC 签名可读。

resource "aws_s3_bucket" "frontend" {
  bucket        = "${local.name_prefix}-frontend-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # 学习：destroy 时连对象一起删
  tags          = { Name = "${local.name_prefix}-frontend" }
}

# 彻底关掉公网访问（走 CloudFront）
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# OAC：CloudFront 用 SigV4 签名回源私有桶（取代老的 OAI）
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name_prefix}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Function（viewer-request）：SPA 子目录路由重写。
# S3 只存实体文件，客户端路由路径（/leaderboard、/pr-1/search…）在 S3 里没有对应对象，
# 这里在边缘把「非文件请求」重写到对应的 index.html，让前端路由接管。
resource "aws_cloudfront_function" "spa_router" {
  name    = "${local.name_prefix}-spa-router"
  runtime = "cloudfront-js-2.0"
  comment = "SPA 路由重写：/pr-N/* → /pr-N/index.html；根非文件 → /index.html"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var req = event.request;
      var uri = req.uri;
      var lastSeg = uri.substring(uri.lastIndexOf('/') + 1);
      // 带扩展名的静态资源（.js/.css/.png/index.html…）直接放行
      if (lastSeg.indexOf('.') !== -1) {
        return req;
      }
      // /pr-N/... 预览前缀：重写到该前缀下的 index.html
      if (uri.indexOf('/pr-') === 0) {
        var second = uri.indexOf('/', 1);
        var prefix = second === -1 ? uri : uri.substring(0, second);
        req.uri = prefix + '/index.html';
        return req;
      }
      // 根 SPA 路由
      req.uri = '/index.html';
      return req;
    }
  EOT
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${local.name_prefix} frontend"
  price_class         = "PriceClass_100" # 学习：只用北美+欧洲边缘，省钱

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_router.arn
    }

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA fallback：S3 对未知路径返回 403/404，CloudFront 改吐 index.html(200) 交给前端路由
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${local.name_prefix}-frontend" }
}

# 桶策略：只允许「本 distribution」经 CloudFront 服务主体读取
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}
