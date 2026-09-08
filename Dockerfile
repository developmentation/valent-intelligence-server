# Valent intelligence server — container image (Coolify / OVH VM).
FROM node:20-bookworm-slim
WORKDIR /app

# Install deps first for layer caching. sharp ships prebuilt linux-x64 binaries; ffmpeg-static fetches
# its ffmpeg binary on install (needs network at build time).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
