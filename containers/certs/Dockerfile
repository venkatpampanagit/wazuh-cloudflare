# Cloudflare Container image for Wazuh Certs helper
# NOTE: As of Jan 2026 the Wazuh certs generator image has not been
# published with the 4.9.0 tag. Default to the latest published
# version (4.8.2) and allow overrides via build args/image_vars.
ARG WAZUH_VERSION=0.0.1
FROM docker.io/wazuh/wazuh-certs-generator:${WAZUH_VERSION}

LABEL org.opencontainers.image.source="https://hub.docker.com/r/wazuh/wazuh-certs-generator"
LABEL org.opencontainers.image.description="Wazuh cert generation utility packaged for Cloudflare Containers"
EXPOSE 1515