# Cloudflare Container image for Wazuh Manager
# Uses the official Wazuh Docker image published on Docker Hub

ARG WAZUH_VERSION=4.9.0
FROM docker.io/wazuh/wazuh-manager:${WAZUH_VERSION}

LABEL org.opencontainers.image.source="https://hub.docker.com/r/wazuh/wazuh-manager"
LABEL org.opencontainers.image.description="Wazuh Manager packaged for Cloudflare Containers"

# No extra steps are required: the upstream entrypoint starts the manager.

EXPOSE 55000
