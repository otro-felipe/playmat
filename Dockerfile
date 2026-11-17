# syntax=docker/dockerfile:1
# a4be2b6 and the 54c8cb2 base share the identical Mage.Sets tree
# (05e3a7e3a9e8f9413818dbcabfe579a57a1efc74). Reuse its card jar and warm catalog.
FROM ghcr.io/arcanite24/playmat-server@sha256:9bd49de1eacf7664d5f29640c90e664e858da7d2225fe2036a62812d9699aa14 AS cards
FROM maven:3.9-eclipse-temurin-17 AS engine
WORKDIR /source
ENV MAVEN_OPTS="-Xmx1500m -XX:+UseSerialGC"
COPY . .
COPY --from=cards /opt/xmage/lib/mage-sets-1.4.62.jar /tmp/mage-sets.jar
RUN mvn -B -q -N install \
    && mvn -B -q install:install-file -Dfile=/tmp/mage-sets.jar -DpomFile=Mage.Sets/pom.xml \
    && mvn -B -q -pl 'Mage.Server,!Mage.Sets' -am install -DskipTests \
    && mvn -B -q -f Mage.Server/pom.xml package assembly:single -DskipTests \
    && mkdir /engine && cd /engine && jar xf /source/Mage.Server/target/mage-server.zip \
    && cp config/config.xml config/config.template.xml \
    && rm -rf db saved \
    && date -u +%s > .build-id
COPY --from=cards /opt/xmage/cards-prebuilt/ /engine/cards-prebuilt/

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY Mage.Web.Client/package*.json ./
RUN npm ci
COPY Mage.Web.Client/ ./
ENV VITE_PRIVATE_PLAYTESTING=true VITE_IMAGE_PROXY=""
RUN npm run build

FROM node:22-bookworm-slim AS tools
WORKDIR /source/ops/playtesting/product
COPY ops/playtesting/product/package*.json ./
RUN npm ci --omit=dev
COPY ops/playtesting/product/ ./
WORKDIR /source/ops/playtesting/mcp
COPY ops/playtesting/mcp/package*.json ./
RUN npm ci
COPY ops/playtesting/mcp/ ./
COPY Mage.Web.Client/src /source/Mage.Web.Client/src
COPY Mage.Web.Client/public/meta-decks ./meta-decks
RUN npm run build && npm prune --omit=dev

FROM caddy:2.11-alpine AS caddy
FROM eclipse-temurin:17-jre
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates xmlstarlet \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /opt/xmage xmage
WORKDIR /opt/xmage
COPY --from=engine /engine/ ./
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=tools /usr/local/bin/node /usr/local/bin/node
COPY --from=tools /source/ops/playtesting /opt/playtesting
COPY --from=web /app/dist /srv/playmat
COPY Mage.Server/src/main/resources/career /opt/xmage/career-content
COPY ops/web/server-entrypoint.sh /usr/local/bin/xmage-server
COPY ops/web/log4j-docker.properties /opt/xmage/config/log4j-docker.properties
COPY ops/playtesting/entrypoint.sh /usr/local/bin/playtesting
COPY ops/playtesting/Caddyfile /etc/caddy/Caddyfile
ARG PLAYMAT_COMMIT
RUN chmod +x /usr/local/bin/playtesting /usr/local/bin/xmage-server \
    && printf '%s\n' "${PLAYMAT_COMMIT:-unknown}" > /opt/xmage/.commit \
    && chown -R xmage /opt/xmage
ENV PORT=8080 PLAYMAT_PRIVATE_BETA=true XMAGE_AUTH=true XMAGE_PASSWORD_SIGNIN=false \
    XMAGE_AUTH_TRUSTED_HEADER=X-Playmat-User XMAGE_TRUSTED_PROXIES=127.0.0.1,::1 \
    PLAYMAT_REPLAY_DIR=/opt/xmage/saved/replays PLAYMAT_ENGINE_URL=ws://127.0.0.1:17172/ws \
    PLAYMAT_PRODUCT_URL=http://127.0.0.1:8790 AUTH_TRUSTED_HEADER=X-Playmat-User \
    XDG_DATA_HOME=/var/lib/playmat/caddy/data XDG_CONFIG_HOME=/var/lib/playmat/caddy/config
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/playtesting"]
