FROM node:22.22.2-bookworm

# Native Electron tools and Debian/AppImage build dependencies. This image is a
# Linux build environment, not a containerized desktop distribution or GPU test.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fakeroot git libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdrm2 libfuse2 libgbm1 libgtk-3-0 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    python3 make g++ xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY electron ./electron
COPY tests ./tests
COPY docs ./docs
RUN chown -R node:node /workspace
USER node
CMD ["npm", "test"]
