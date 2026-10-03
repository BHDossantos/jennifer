# Jennifer API + worker. Small, non-root, reproducible (locked manifest).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY db ./db
COPY config ./config
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/src/api/main.js"]
