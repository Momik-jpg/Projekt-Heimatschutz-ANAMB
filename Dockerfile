FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /app /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/heimatschutz.sqlite

EXPOSE 3000

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/app.js"]
