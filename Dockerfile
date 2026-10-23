FROM node:24-bookworm-slim
WORKDIR /app
COPY . .
RUN node scripts/build.mjs && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATABASE_PATH=/data/mapa.sqlite HOST=0.0.0.0 PORT=3001
USER node
EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "server/node.mjs"]
