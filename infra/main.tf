
provider "aws" {
  region = var.aws_region
}

# sg
resource "aws_security_group" "eventflow" {
  name = "eventflow-sg"
  description = "Eventflow ports"

  ingress {
    from_port = 3000
    to_port = 3000
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

   ingress {
    from_port = 4000
    to_port = 4000
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}

   egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_key_pair" "eventflow" {
  key_name   = "eventflow-key"
  public_key = file("~/.ssh/aws/eventflow-key.pub")
}



resource "aws_instance" "eventflow" {
  ami = "ami-01a00762f46d584a1"
  instance_type = var.instance_type
  key_name = aws_key_pair.eventflow.key_name
  vpc_security_group_ids = [aws_security_group.eventflow.id]
  user_data = file("user_data.sh")

  tags = {
    Name = "eventflow"
  }
}


resource "aws_eip" "eventflow" {
  instance = aws_instance.eventflow.id
  domain = "vpc"
}


