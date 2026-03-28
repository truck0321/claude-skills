FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

# Copy server package files and install (including devDeps for build)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

# Copy source and build
COPY server/src ./server/src
COPY server/tsconfig.json ./server/
RUN cd server && npm run build && npm prune --omit=dev

# Copy the management skill
COPY SKILL.md ./

ENV TRANSPORT=http
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server/dist/index.js"]
