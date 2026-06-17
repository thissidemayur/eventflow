output "public_ip" {
  value = aws_eip.eventflow.public_ip
  description = "SSH and API access IP"
}