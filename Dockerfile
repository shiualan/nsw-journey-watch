FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
COPY package.json server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data/gtfs && chown -R node:node /app/data
ENV GTFS_DATA_DIR=/app/data/gtfs
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
