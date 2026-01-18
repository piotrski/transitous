# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

ARG MOTIS_VERSION=v2.7.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl bzip2 git python3 python3-pip rsync wget unzip \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/motis /var/lib/motis \
  && curl -fsSL "https://github.com/motis-project/motis/releases/download/${MOTIS_VERSION}/motis-linux-amd64.tar.bz2" \
  | tar -C /opt/motis -xj

RUN pip3 install --no-cache-dir requests ruamel.yaml==0.18.17 pycountry beautifulsoup4 lxml license-expression tzdata

ENV BUN_INSTALL=/usr/local/bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=${BUN_INSTALL}/bin:$PATH

ENV PATH=/opt/motis:$PATH
WORKDIR /opt/transitous

COPY feeds/ feeds/
COPY motis/config.yml motis/config.yml
COPY scripts/ scripts/
COPY src/ src/
COPY transitland-atlas/ transitland-atlas/

COPY motis/entrypoint.sh /usr/local/bin/motis-entrypoint
COPY motis/update_data.ts /opt/transitous/motis/update_data.ts
COPY motis/update_scheduler.ts /opt/transitous/motis/update_scheduler.ts
RUN chmod +x /usr/local/bin/motis-entrypoint /opt/transitous/motis/update_data.ts /opt/transitous/motis/update_scheduler.ts

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/motis-entrypoint"]
