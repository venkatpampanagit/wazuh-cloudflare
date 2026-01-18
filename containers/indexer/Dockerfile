# Cloudflare Container image for Wazuh Indexer
ARG WAZUH_VERSION=4.9.0
ARG CERT_BUILD_ID=20260115_009
FROM docker.io/wazuh/wazuh-indexer:${WAZUH_VERSION}
ARG CERT_BUILD_ID

RUN echo "Embedding Wazuh cert bundle build ${CERT_BUILD_ID}"

LABEL org.opencontainers.image.source="https://hub.docker.com/r/wazuh/wazuh-indexer"
LABEL org.opencontainers.image.description="Wazuh Indexer packaged for Cloudflare Containers"

USER root
RUN mkdir -p /usr/share/wazuh-indexer/config/certs \
 && mkdir -p /usr/share/wazuh-indexer/data \
 && chown -R wazuh-indexer:wazuh-indexer /usr/share/wazuh-indexer/config /usr/share/wazuh-indexer/data

COPY ./certs/indexer01.pem /usr/share/wazuh-indexer/config/certs/indexer.pem
COPY ./certs/indexer01-key.pem /usr/share/wazuh-indexer/config/certs/indexer-key.pem
COPY ./certs/root-ca.pem /usr/share/wazuh-indexer/config/certs/root-ca.pem
COPY ./scripts/init-security.sh /usr/local/bin/init-security.sh
COPY ./scripts/bootstrap-security.sh /usr/local/bin/bootstrap-security.sh
COPY ./security-config/ /usr/share/wazuh-indexer/security-config/

RUN dnf install -y which python3 && dnf clean all

ENV JAVA_HOME=/usr/share/wazuh-indexer/jdk \
    OPENSEARCH_JAVA_HOME=/usr/share/wazuh-indexer/jdk \
    PATH=/usr/share/wazuh-indexer/jdk/bin:$PATH \
    BOOTSTRAP_TLS_HOST=10.0.0.3

RUN chmod 640 /usr/share/wazuh-indexer/config/certs/indexer.pem \
    && chmod 600 /usr/share/wazuh-indexer/config/certs/indexer-key.pem \
    && chmod 600 /usr/share/wazuh-indexer/config/certs/root-ca.pem \
    && chown -R wazuh-indexer:wazuh-indexer /usr/share/wazuh-indexer/config/certs \
    && chmod 700 /usr/share/wazuh-indexer/config \
    && chmod 700 /usr/share/wazuh-indexer/config/certs \
    && chmod +x /usr/local/bin/init-security.sh \
    && chmod +x /usr/local/bin/bootstrap-security.sh

RUN mkdir -p /etc/wazuh-indexer/certs \
 && cp /usr/share/wazuh-indexer/config/certs/indexer.pem /etc/wazuh-indexer/certs/indexer.pem \
 && cp /usr/share/wazuh-indexer/config/certs/indexer-key.pem /etc/wazuh-indexer/certs/indexer-key.pem \
 && cp /usr/share/wazuh-indexer/config/certs/root-ca.pem /etc/wazuh-indexer/certs/root-ca.pem \
 && chown root:wazuh-indexer /etc/wazuh-indexer/certs/indexer.pem /etc/wazuh-indexer/certs/root-ca.pem \
 && chown root:wazuh-indexer /etc/wazuh-indexer/certs/indexer-key.pem \
 && chmod 640 /etc/wazuh-indexer/certs/indexer.pem /etc/wazuh-indexer/certs/root-ca.pem \
 && chmod 600 /etc/wazuh-indexer/certs/indexer-key.pem \
 && chgrp wazuh-indexer /etc/wazuh-indexer/certs \
 && chmod 700 /etc/wazuh-indexer/certs

# Rewrite OpenSearch security config to use the /usr/share paths
RUN if [ -f /usr/share/wazuh-indexer/opensearch.yml ]; then \
      sed -i 's#/etc/wazuh-indexer/certs#/usr/share/wazuh-indexer/config/certs#g' /usr/share/wazuh-indexer/opensearch.yml; \
    fi \
 && if [ -f /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig/opensearch-security.yml ]; then \
      sed -i 's#/etc/wazuh-indexer/certs#/usr/share/wazuh-indexer/config/certs#g' /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig/opensearch-security.yml; \
    fi

RUN python3 - <<'PY'
from pathlib import Path

path = Path("/usr/share/wazuh-indexer/opensearch.yml")
target = 'CN=indexer01,OU=Wazuh,O=Wazuh,L=California,C=US'
key = "plugins.security.authcz.admin_dn"

if not path.exists():
    raise SystemExit(0)

lines = path.read_text().splitlines()
output = []
i = 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()
    if stripped.startswith(f"{key}:"):
        output.append(line)
        indent = line[:len(line) - len(line.lstrip())]
        list_indent = indent
        values = []
        j = i + 1
        while j < len(lines):
            raw = lines[j]
            s = raw.strip()
            if not s:
                j += 1
                continue
            if s.startswith("-"):
                val = s[1:].strip()
                if val.startswith('"') and val.endswith('"'):
                    val = val[1:-1]
                values.append(val)
                j += 1
                continue
            break
        if target not in values:
            values.append(target)
        for val in values:
            output.append(f'{list_indent}- "{val}"')
        i = j
        continue
    output.append(line)
    i += 1

path.write_text("\n".join(output) + "\n")
PY

# Ensure security config files exist for bootstrap
RUN if [ ! -d /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig ]; then \
      mkdir -p /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig; \
    fi \
 && cp /usr/share/wazuh-indexer/security-config/* /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig/ \
 && chmod 600 /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig/* \
 && chown -R wazuh-indexer:wazuh-indexer /usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig

# Seed security index during build (uses HTTPS) then disable HTTP TLS for runtime
RUN /usr/local/bin/bootstrap-security.sh \
 && rm -rf /var/lib/wazuh-indexer/nodes \
 && rm -f /usr/share/wazuh-indexer/data/.security-initialized

RUN if [ -f /usr/share/wazuh-indexer/opensearch.yml ]; then \
      if grep -q 'plugins.security.ssl.http.enabled' /usr/share/wazuh-indexer/opensearch.yml; then \
        sed -i 's/plugins.security.ssl.http.enabled:.*/plugins.security.ssl.http.enabled: false/' /usr/share/wazuh-indexer/opensearch.yml; \
      else \
        printf '\nplugins.security.ssl.http.enabled: false\n' >> /usr/share/wazuh-indexer/opensearch.yml; \
      fi; \
    fi

EXPOSE 9200

ENTRYPOINT ["/usr/local/bin/init-security.sh"]