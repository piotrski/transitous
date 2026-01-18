# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

ARG MOTIS_VERSION=v2.7.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  bzip2 \
  git \
  python3 \
  python3-dev \
  pkg-config \
  rsync \
  wget \
  unzip \
  build-essential \
  libffi-dev \
  libxml2-dev \
  libxslt1-dev \
  zlib1g-dev \
  python3-requests \
  python3-ruamel.yaml \
  python3-pycountry \
  python3-bs4 \
  python3-lxml \
  python3-license-expression \
  python3-tz \
  && rm -rf /var/lib/apt/lists/*
RUN wget -O /usr/local/bin/gtfsclean https://github.com/public-transport/gtfsclean/releases/latest/download/gtfsclean \
  && chmod +x /usr/local/bin/gtfsclean

RUN mkdir -p /opt/motis /var/lib/motis \
  && curl -fsSL "https://github.com/motis-project/motis/releases/download/${MOTIS_VERSION}/motis-linux-amd64.tar.bz2" \
  | tar -C /opt/motis -xj

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
RUN if [ ! -d "/opt/transitous/transitland-atlas/feeds" ]; then \
  if [ -f "/opt/transitous/.gitmodules" ] && [ -d "/opt/transitous/.git" ]; then \
    git submodule update --init --recursive --depth 1 transitland-atlas; \
  else \
    echo "transitland-atlas submodule missing; cloning fresh copy."; \
    git clone --depth 1 https://github.com/transitland/transitland-atlas /opt/transitous/transitland-atlas; \
  fi; \
fi

COPY motis/entrypoint.sh /usr/local/bin/motis-entrypoint
COPY motis/update_data.ts /opt/transitous/motis/update_data.ts
COPY motis/update_scheduler.ts /opt/transitous/motis/update_scheduler.ts
RUN chmod +x /usr/local/bin/motis-entrypoint /opt/transitous/motis/update_data.ts /opt/transitous/motis/update_scheduler.ts

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/motis-entrypoint"]
