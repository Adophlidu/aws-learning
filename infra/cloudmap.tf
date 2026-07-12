resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "svc.internal"
  description = "east-west service discovery for ${local.name_prefix}"
  vpc         = aws_vpc.main.id
}
