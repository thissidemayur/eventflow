terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket = "eventflow-terraform-state-mayur-private"
    key = "prod/terraform.tfstate"
    region="ap-south-1"
}

}


