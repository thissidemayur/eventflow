FROM node:20-alpine AS builder

WORKDIR /app

# copy root worksspace config first. 
#docker caches lauers
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/api/package.json ./app/api/


RUN npm install

COPY packages/shared/ ./packages/shared/
COPY packages/db/ ./packages/db/
COPY app/api/package.json ./app/api/

# genereate prisma client
RUN npm run generate -w @eventflow/db

# Build
RUN npm run build build -w @eventflow/shared
RUN npm run build -w @eventflow/db
RUN npm run build -w @eventflow/api


# STAGE-2: PRODUCTION_IMAGE
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# 
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/package/db/prisma ./packages/db/prisma
COPY --from=builder /app/app/worker/dist ./app/worker/dist
COPY --from=builder /app/app/worker/package.json ./app/worker/package.json

CMD ["node","app/worker/dist/index.js"]