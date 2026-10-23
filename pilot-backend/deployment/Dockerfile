FROM node:22-bookworm-slim
WORKDIR /app/pilot-backend
COPY pilot-backend/package.json pilot-backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY pilot-backend/server ./server
COPY pilot-backend/activation-drafts/complex-infrastructure.cjs ./activation-drafts/complex-infrastructure.cjs
COPY pilot-backend/catalog-approvals.json ./catalog-approvals.json
COPY pilot-backend/catalog-review/usda-pilot-profiles-v1.json ./catalog-review/usda-pilot-profiles-v1.json
COPY nutrika /app/nutrika
USER node
ENV NODE_ENV=production
CMD ["node", "server/render-readonly.cjs"]
