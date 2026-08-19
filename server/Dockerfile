# syntax=docker/dockerfile:1
# Build context is the REPO ROOT:  docker build -f server/Dockerfile -t dj-pro .

# --- stage 1: build the SPA ------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- stage 2: build the server, with the SPA embedded ----------------------
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# Replace the committed placeholder shell with the real bundle before //go:embed runs.
RUN rm -rf web-dist && mkdir -p web-dist
COPY --from=web /web/dist/ ./web-dist/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /dj-pro .

# --- stage 3: runtime ------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
 && addgroup -S dj && adduser -S -G dj dj \
 && mkdir -p /data && chown dj:dj /data
COPY --from=build /dj-pro /usr/local/bin/dj-pro
USER dj
WORKDIR /data
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["dj-pro"]
