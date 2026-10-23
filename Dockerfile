# ClaudeSuite as a container, for Synology Container Manager. Started by docker-compose.yml.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production
# Light on the NAS: Node cleans up early and never grows past 64 MB of JavaScript memory
ENV NODE_OPTIONS="--max-old-space-size=64 --max-semi-space-size=2"

# Install the packages first, so a rebuild after a code change is fast
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The data folder (database, shared files) belongs to the container's own user, never root
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8082

# Container Manager shows the app as "unhealthy" when it stops answering (plain bash: no second Node process)
HEALTHCHECK --interval=1m --timeout=10s --start-period=20s \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${PORT:-8082} && printf "GET /health HTTP/1.0\r\n\r\n" >&3 && head -n 1 <&3 | grep -q " 200 "'

CMD ["node", "index.js"]
