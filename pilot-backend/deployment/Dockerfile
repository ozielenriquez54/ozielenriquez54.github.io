FROM node:22-bookworm-slim
WORKDIR /app/pilot-backend
COPY pilot-backend/package.json pilot-backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY pilot-backend/server ./server
COPY nutrika /app/nutrika
USER node
ENV NODE_ENV=production
CMD ["node", "server/render-readonly.cjs"]
