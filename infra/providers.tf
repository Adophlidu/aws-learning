provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "github-profile-collector"
      ManagedBy = "terraform"
      Env       = terraform.workspace
    }
  }
}
