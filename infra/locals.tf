data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "profile-${terraform.workspace}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
}
