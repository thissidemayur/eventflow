#!/bin/bash

apt-get update -y
apt-get install -y git curl 

# ==============  SET Docker APT repository ==============
# Add Docker's official GPG key:
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update

# ==============  Install the Docker packages ==============

sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin




## ============== enable and statrt docker ==============
sudo systemctl enable docker

sudo systemctl status docker

sudo systemctl start docker

# ============== Allow ubuntu user to run docker without sudo ==============
usermod -aG docker ubuntu

## ============== docker version ==============
usermod -aG docker ubuntu

# docker version 
docker --version  

## ============== Create app directory ==============
mkdir -p /app
chown ubuntu:ubuntu /app

echo " ========================== everything done successfully ========================== "