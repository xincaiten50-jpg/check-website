FROM node:20-bookworm

# Install dependencies: sshpass, Playwright system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    sshpass \
    chromium \
    chromium-sandbox \
    fonts-noto-cjk \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers
RUN npx playwright install chromium --with-deps 2>/dev/null || \
    npx playwright install chromium

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Create non-root user
RUN useradd -m -s /bin/bash appuser && \
    chown -R appuser:appuser /app
USER appuser

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Default: run scheduled mode
CMD ["node", "index.js", "--scheduled"]
