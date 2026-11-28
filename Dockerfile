# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-17 AS engine
WORKDIR /source
ENV MAVEN_OPTS="-Xmx1500m -XX:+UseSerialGC"
COPY . .
RUN mvn -B -pl Mage.Server -am install -DskipTests \
    && mvn -B -f Mage.Server/pom.xml package assembly:single -DskipTests \
    && mkdir /engine && cd /engine && jar xf /source/Mage.Server/target/mage-server.zip \
    && cp config/config.xml config/config.template.xml \
    && rm -rf db saved \
    && date -u +%s > .build-id
RUN java -cp '/engine/lib/*' ops/playtesting/test/VerifyPackagedCardSnapshots.java
# Create both catalogs from the same executable cards bundled with the server.
RUN cd /engine \
    && java -Xmx1500m -XX:+UseSerialGC -Dxmage.exitAfterStartup=true -Dxmage.testMode=false \
        -Dxmage.healthPort=0 -Dxmage.replays=false -Dxmage.catalog.export=catalog.sqlite -jar lib/mage-server-*.jar \
    && java -Xmx512m -cp 'lib/*' /source/ops/playtesting/test/VerifyPackagedCardCatalog.java catalog.sqlite \
    && java -cp 'lib/*' org.h2.tools.Shell -url 'jdbc:h2:file:./db/cards.h2' -user '' -password '' \
        -sql 'SHUTDOWN DEFRAG' >/dev/null 2>&1 \
    && test "$(stat -c %s db/cards.h2.mv.db)" -le 150000000 \
    && mkdir cards-prebuilt \
    && mv db/cards.h2.mv.db catalog.sqlite cards-prebuilt/ \
    && rm -rf db saved extensions mageserver.log

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
COPY Mage.Web.Client/src/core/decks/archetypes/ ./archetypes/
WORKDIR /source/ops/playtesting/mcp
COPY ops/playtesting/mcp/package*.json ./
RUN npm ci
COPY ops/playtesting/mcp/ ./
COPY Mage.Web.Client/src /source/Mage.Web.Client/src
COPY Mage.Web.Client/public/meta-decks ./meta-decks
RUN npm run build && npm prune --omit=dev

FROM caddy:2.11.9-alpine AS caddy
FROM eclipse-temurin:17-jre
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates xmlstarlet python3 \
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
COPY ops/playtesting/recovery-backup.py /opt/playtesting/recovery-backup.py
COPY ops/playtesting/Caddyfile /etc/caddy/Caddyfile
ARG PLAYMAT_COMMIT
RUN chmod +x /usr/local/bin/playtesting /usr/local/bin/xmage-server \
    && printf '%s\n' "${PLAYMAT_COMMIT:-unknown}" > /opt/xmage/.commit \
    && chown -R xmage /opt/xmage
ENV PORT=8080 PLAYMAT_PRIVATE_BETA=true PLAYMAT_ENGINE_LOOPBACK=true XMAGE_AUTH=true XMAGE_PASSWORD_SIGNIN=false \
    XMAGE_MAX_GAME_THREADS=8 \
    XMAGE_AUTH_TRUSTED_HEADER=X-Playmat-User XMAGE_TRUSTED_PROXIES=127.0.0.1,::1 \
    PLAYMAT_REPLAY_DIR=/opt/xmage/saved/replays PLAYMAT_ENGINE_URL=ws://127.0.0.1:17172/ws \
    PLAYMAT_PRODUCT_URL=http://127.0.0.1:8790 AUTH_TRUSTED_HEADER=X-Playmat-User \
    XDG_DATA_HOME=/var/lib/playmat/caddy/data XDG_CONFIG_HOME=/var/lib/playmat/caddy/config
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/playtesting"]
