# Cloudflare Container image for Wazuh Dashboard
ARG WAZUH_VERSION=4.9.0
FROM docker.io/wazuh/wazuh-dashboard:${WAZUH_VERSION}

LABEL org.opencontainers.image.source="https://hub.docker.com/r/wazuh/wazuh-dashboard"
LABEL org.opencontainers.image.description="Wazuh Dashboard packaged for Cloudflare Containers"

USER root
RUN mkdir -p /etc/wazuh-dashboard/certs \
 && chown -R wazuh-dashboard:wazuh-dashboard /etc/wazuh-dashboard

COPY ./certs/root-ca.pem /etc/wazuh-dashboard/certs/root-ca.pem
COPY ./certs/dashboard.pem /etc/wazuh-dashboard/certs/dashboard.pem
COPY ./certs/dashboard-key.pem /etc/wazuh-dashboard/certs/dashboard-key.pem

RUN chmod 600 /etc/wazuh-dashboard/certs/dashboard-key.pem \
 && chown -R wazuh-dashboard:wazuh-dashboard /etc/wazuh-dashboard/certs

USER wazuh-dashboard
EXPOSE 5601
