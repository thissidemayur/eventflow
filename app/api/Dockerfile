FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY prisma.config.ts ./

COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY app/api/package.json ./app/api/

# install all dependecies
RUN npm ci 

# COPY source code
COPY packages/shared ./packages/shared/
COPY packages/db/ ./packages/db/
COPY app/api/ ./app/api/


ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# genereate Prisma client
RUN npm run generate -w @eventflow/db

# build shared and db packages first
RUN npm run build -w @eventflow/shared
RUN npm run build -w @eventflow/db
RUN npm run build -w @eventflow/api


# STAGE 2 -- production image(only compiled output)
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/app/api/dist ./app/api/dist
COPY --from=builder /app/app/api/package.json ./app/api/package.json


EXPOSE 3000
CMD ["node","app/api/dist/index.js"]
