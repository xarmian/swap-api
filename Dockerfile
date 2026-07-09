# swap-api — production image
# Express 5 / ESM / Node 22 LTS. Stateless service: reads config/*.json from the image,
# logs to stdout + Supabase over the network. No build step, no volumes.
FROM node:22-slim AS base

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies against the committed lockfile.
# On -slim (glibc) the optional native modules (bufferutil / utf-8-validate, pulled in by
# ws) resolve to prebuilt binaries, so no compiler toolchain is required.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source. .dockerignore keeps node_modules, .git and .env out of the context,
# so host artifacts never clobber the install and secrets are never baked into the image.
COPY . .

# Run as the unprivileged user baked into the base image.
USER node

EXPOSE 3000

# Probe the app's own /health route with the stdlib http client (no curl / global fetch needed).
# start-period covers the one-time on-boot pool discovery (see DEPLOY.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
